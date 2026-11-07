import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import { Agent, fetch } from 'undici';
import ipaddr from 'ipaddr.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';

const PORT = Number.parseInt(process.env.PORT || '10000', 10);
const MAX_FILE_SIZE = Math.max(1, Number.parseInt(process.env.MAX_FILE_SIZE_MB || '300', 10)) * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const REDIRECT_LIMIT = 4;
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://sandeepdolai.github.io,http://localhost:4321')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);
const ALLOWED_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi',
  '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac'
]);

const app = Fastify({
  logger: true,
  bodyLimit: 8 * 1024,
  requestTimeout: 30_000,
  connectionTimeout: 15_000
});

await app.register(cors, {
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.has(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  maxAge: 600
});
await app.register(formbody);
await app.register(rateLimit, { global: true, max: 60, timeWindow: '1 minute' });

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function assertPublicIp(address) {
  let parsed;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    throw new ApiError(400, 'The media host does not resolve to a public address.');
  }
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }
  if (parsed.range() !== 'unicast') {
    throw new ApiError(400, 'Links to private, local or reserved network addresses are not allowed.');
  }
  return isIP(address);
}

async function resolvePublicAddresses(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.test')
  ) {
    throw new ApiError(400, 'Local and private network addresses are not allowed.');
  }

  let records;
  if (isIP(normalized)) {
    records = [{ address: normalized, family: isIP(normalized) }];
  } else {
    try {
      records = await lookup(normalized, { all: true, verbatim: true });
    } catch {
      throw new ApiError(422, 'The media host could not be resolved.');
    }
  }
  if (!records.length) throw new ApiError(422, 'The media host could not be resolved.');
  for (const record of records) assertPublicIp(record.address);
  return records;
}

function validateMediaUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) {
    throw new ApiError(400, 'Enter a valid media URL.');
  }
  let url;
  try { url = new URL(value); } catch { throw new ApiError(400, 'Enter a valid media URL.'); }
  if (url.protocol !== 'https:') throw new ApiError(400, 'Only HTTPS media URLs are supported.');
  if (url.username || url.password) throw new ApiError(400, 'URLs containing embedded credentials are not supported.');
  if (url.port && url.port !== '443') throw new ApiError(400, 'Only standard HTTPS links are supported.');
  url.hash = '';
  return url;
}

function makePinnedAgent(hostname, addresses) {
  const expectedHost = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const lookupPinned = (requestedHost, options, callback) => {
    const requested = requestedHost.replace(/^\[|\]$/g, '').toLowerCase();
    if (requested !== expectedHost) return callback(new Error('Blocked unexpected DNS lookup.'));
    const opts = typeof options === 'object' && options !== null ? options : { family: options };
    const available = addresses.filter((entry) => !opts.family || opts.family === 0 || entry.family === opts.family);
    if (!available.length) return callback(new Error('No public address is available.'));
    if (opts.all) return callback(null, available.map((entry) => ({ address: entry.address, family: entry.family })));
    return callback(null, available[0].address, available[0].family);
  };
  return new Agent({ connect: { lookup: lookupPinned } });
}

async function openRemote(initialUrl, method, extraHeaders = {}) {
  let currentUrl = validateMediaUrl(initialUrl);
  for (let redirects = 0; redirects <= REDIRECT_LIMIT; redirects += 1) {
    const addresses = await resolvePublicAddresses(currentUrl.hostname);
    const dispatcher = makePinnedAgent(currentUrl.hostname, addresses);
    let response;
    try {
      response = await fetch(currentUrl, {
        method,
        redirect: 'manual',
        dispatcher,
        headers: {
          'user-agent': 'MemorableDayDownloader/1.0 (+https://sandeepdolai.github.io/Downloadmedia/)',
          ...extraHeaders
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      await dispatcher.close().catch(() => {});
      throw new ApiError(502, 'The media source could not be reached. Check the link and try again.');
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      await dispatcher.close().catch(() => {});
      if (!location || redirects === REDIRECT_LIMIT) throw new ApiError(502, 'The media source returned too many redirects.');
      try {
        currentUrl = validateMediaUrl(new URL(location, currentUrl).toString());
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, 'The media source returned an invalid redirect.');
      }
      continue;
    }

    if (!response.ok && !(method === 'HEAD' && [405, 501].includes(response.status))) {
      await response.body?.cancel().catch(() => {});
      await dispatcher.close().catch(() => {});
      if (response.status === 401 || response.status === 403) {
        throw new ApiError(422, 'This media requires access or permission that the downloader does not have.');
      }
      throw new ApiError(502, `The media host returned HTTP ${response.status}.`);
    }
    return { response, dispatcher, url: currentUrl };
  }
  throw new ApiError(502, 'The media source could not be reached.');
}

function extensionFrom(url) {
  const match = url.pathname.toLowerCase().match(/\.[a-z0-9]{2,5}$/);
  return match ? match[0] : '';
}

function filenameFrom(response, url, contentType) {
  const disposition = response.headers.get('content-disposition') || '';
  let candidate = '';
  const extended = disposition.match(/filename\*=utf-8''([^;]+)/i);
  const ordinary = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (extended) {
    try { candidate = decodeURIComponent(extended[1]); } catch { candidate = extended[1]; }
  } else if (ordinary) {
    candidate = ordinary[1];
  } else {
    try { candidate = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || 'media-file'); }
    catch { candidate = 'media-file'; }
  }
  candidate = candidate.normalize('NFKC')
    .replace(/[\\/\u0000-\u001f\u007f"<>:|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (!candidate || candidate === '.' || candidate === '..') candidate = 'media-file';
  if (!/\.[a-z0-9]{2,5}$/i.test(candidate)) {
    candidate += extensionFrom(url) || (contentType.startsWith('audio/') ? '.audio' : '.video');
  }
  return candidate;
}

function mediaTypeFrom(response) {
  return (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
}

function isDirectMedia(response, url) {
  const type = mediaTypeFrom(response);
  if (type === 'text/html' || type === 'application/xhtml+xml') return false;
  const extension = extensionFrom(url);
  return type.startsWith('video/') ||
    type.startsWith('audio/') ||
    (type === 'application/octet-stream' && ALLOWED_EXTENSIONS.has(extension)) ||
    ALLOWED_EXTENSIONS.has(extension);
}

async function inspectRemote(urlValue) {
  let remote = await openRemote(urlValue, 'HEAD');
  if ([405, 501].includes(remote.response.status)) {
    await remote.dispatcher.close().catch(() => {});
    remote = await openRemote(urlValue, 'GET', { range: 'bytes=0-0' });
  }
  const { response, dispatcher, url } = remote;
  const contentType = mediaTypeFrom(response);
  let sizeBytes = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (response.status === 206) {
    const total = response.headers.get('content-range')?.match(/\/(\d+)$/);
    if (total) sizeBytes = Number.parseInt(total[1], 10);
  }
  const filename = filenameFrom(response, url, contentType);
  const supported = isDirectMedia(response, url);
  await response.body?.cancel().catch(() => {});
  await dispatcher.close().catch(() => {});
  if (Number.isFinite(sizeBytes) && sizeBytes > MAX_FILE_SIZE) {
    throw new ApiError(413, 'This file is larger than the current download limit.');
  }
  if (!supported) {
    throw new ApiError(422, 'This link opens a webpage rather than a direct media file. The first version accepts direct HTTPS audio/video files and authorized media URLs.');
  }
  const video = contentType.startsWith('video/') ||
    ['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi'].includes(extensionFrom(url));
  const formats = [
    { id: 'original', label: `Original file (${extensionFrom(url).replace('.', '').toUpperCase() || 'media'})`, available: true }
  ];
  if (video || contentType.startsWith('audio/')) {
    formats.push({ id: 'mp3', label: 'MP3 audio · 192 kbps', available: true });
  }
  return {
    title: filename,
    filename,
    contentType: contentType || 'application/octet-stream',
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    formats
  };
}

function withSizeLimit() {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > MAX_FILE_SIZE) return callback(new Error('The media source exceeded the configured size limit.'));
      callback(null, chunk);
    }
  });
}

function attachmentHeader(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function handleDownload(request, reply) {
  const urlValue = request.body?.url;
  const format = request.body?.format || 'original';
  if (!['original', 'mp3'].includes(format)) throw new ApiError(400, 'Choose a supported download format.');

  const remote = await openRemote(urlValue, 'GET');
  const { response, dispatcher, url } = remote;
  if (!isDirectMedia(response, url)) {
    await response.body?.cancel().catch(() => {});
    await dispatcher.close().catch(() => {});
    throw new ApiError(422, 'This is not a direct media file. Paste a direct HTTPS audio/video URL.');
  }
  const contentType = mediaTypeFrom(response);
  const sourceLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(sourceLength) && sourceLength > MAX_FILE_SIZE) {
    await response.body?.cancel().catch(() => {});
    await dispatcher.close().catch(() => {});
    throw new ApiError(413, 'This file is larger than the current download limit.');
  }
  if (!response.body) {
    await dispatcher.close().catch(() => {});
    throw new ApiError(502, 'The media source returned an empty response.');
  }

  const originalName = filenameFrom(response, url, contentType);
  const baseName = originalName.replace(/\.[^.]+$/, '') || 'media-file';
  const filename = format === 'mp3' ? `${baseName}.mp3` : originalName;
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': format === 'mp3' ? 'audio/mpeg' : (contentType || 'application/octet-stream'),
    'Content-Disposition': attachmentHeader(filename),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(format === 'original' && Number.isFinite(sourceLength) ? { 'Content-Length': String(sourceLength) } : {})
  });

  const source = Readable.fromWeb(response.body);
  const limiter = withSizeLimit();
  const cleanup = () => dispatcher.close().catch(() => {});
  reply.raw.on('close', cleanup);

  if (format === 'original') {
    source.pipe(limiter).pipe(reply.raw);
    source.on('error', (error) => {
      app.log.warn({ err: error }, 'Source stream failed during download');
      reply.raw.destroy(error);
    });
    limiter.on('error', (error) => {
      app.log.warn({ err: error }, 'Download size limit interrupted a stream');
      reply.raw.destroy(error);
    });
    return;
  }

  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-vn', '-map', '0:a:0',
    '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  ffmpeg.stderr.on('data', () => {});
  ffmpeg.stdin.on('error', () => {});
  ffmpeg.on('error', (error) => {
    app.log.error({ err: error }, 'FFmpeg process failed');
    source.destroy(error);
    reply.raw.destroy(error);
  });
  source.pipe(limiter).pipe(ffmpeg.stdin);
  ffmpeg.stdout.pipe(reply.raw);
  ffmpeg.on('close', (code) => {
    if (code !== 0) {
      app.log.warn({ code }, 'FFmpeg could not convert this media to MP3');
      reply.raw.destroy(new Error('Audio conversion failed.'));
    }
  });
  source.on('error', (error) => { ffmpeg.kill('SIGKILL'); reply.raw.destroy(error); });
  limiter.on('error', (error) => { ffmpeg.kill('SIGKILL'); reply.raw.destroy(error); });
  reply.raw.on('close', () => { if (!ffmpeg.killed) ffmpeg.kill('SIGTERM'); });
}

app.setErrorHandler((error, request, reply) => {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) request.log.error({ err: error }, 'Downloader API request failed');
  if (!reply.sent) reply.code(status).send({
    error: status >= 500 ? 'The download service encountered a problem. Try again.' : error.message
  });
});

app.get('/health', async () => ({ ok: true, service: 'memorableday-downloader-api' }));
app.post('/v1/inspect', {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
}, async (request) => {
  const url = validateMediaUrl(request.body?.url);
  return { ok: true, ...await inspectRemote(url.toString()) };
});
app.post('/v1/download', {
  config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
}, handleDownload);

app.listen({ port: PORT, host: '0.0.0.0' }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
