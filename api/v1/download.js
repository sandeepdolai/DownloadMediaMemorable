import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpegPath from 'ffmpeg-static';
import {
  ApiError,
  openRemote,
  isDirectMedia,
  mediaTypeFrom,
  filenameFrom,
  parseRequestBody,
  sendApiError,
  sendJson
} from '../_lib/media.js';

const MAX_FILE_SIZE = Math.max(1, Number.parseInt(process.env.MAX_FILE_SIZE_MB || '300', 10)) * 1024 * 1024;

function withSizeLimit() {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > MAX_FILE_SIZE) {
        callback(new ApiError(413, 'This file is larger than the current download limit.'));
        return;
      }
      callback(null, chunk);
    }
  });
}

function attachmentHeader(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename);
}

export const config = {
  api: { bodyParser: { sizeLimit: '16kb' } }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let dispatcher;
  let ffmpeg;
  try {
    const body = parseRequestBody(req);
    const urlValue = body.url;
    const format = body.format || 'original';
    if (!['original', 'mp3'].includes(format)) throw new ApiError(400, 'Choose a supported download format.');

    const remote = await openRemote(urlValue, 'GET', {}, 270000);
    const response = remote.response;
    dispatcher = remote.dispatcher;
    const url = remote.url;

    if (!isDirectMedia(response, url)) {
      await response.body?.cancel().catch(() => {});
      throw new ApiError(422, 'This is not a direct media file. Paste a direct HTTPS audio/video URL.');
    }
    const contentType = mediaTypeFrom(response);
    const sourceLength = Number.parseInt(response.headers.get('content-length') || '', 10);
    if (Number.isFinite(sourceLength) && sourceLength > MAX_FILE_SIZE) {
      await response.body?.cancel().catch(() => {});
      throw new ApiError(413, 'This file is larger than the current download limit.');
    }
    if (!response.body) throw new ApiError(502, 'The media source returned an empty response.');

    const originalName = filenameFrom(response, url, contentType);
    const baseName = originalName.replace(/\.[^.]+$/, '') || 'media-file';
    const filename = format === 'mp3' ? baseName + '.mp3' : originalName;

    if (format === 'mp3' && !ffmpegPath) {
      await response.body.cancel().catch(() => {});
      throw new ApiError(503, 'MP3 conversion is unavailable on this deployment.');
    }

    res.writeHead(200, {
      'Content-Type': format === 'mp3' ? 'audio/mpeg' : (contentType || 'application/octet-stream'),
      'Content-Disposition': attachmentHeader(filename),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(format === 'original' && Number.isFinite(sourceLength) ? { 'Content-Length': String(sourceLength) } : {})
    });

    const source = Readable.fromWeb(response.body);
    const limiter = withSizeLimit();
    res.on('close', () => {
      if (ffmpeg && !ffmpeg.killed) ffmpeg.kill('SIGTERM');
    });

    if (format === 'original') {
      try {
        await pipeline(source, limiter, res);
      } finally {
        await dispatcher.close().catch(() => {});
      }
      return;
    }

    ffmpeg = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn', '-map', '0:a:0',
      '-c:a', 'libmp3lame', '-b:a', '192k',
      '-f', 'mp3', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    ffmpeg.stderr.on('data', () => {});
    const inputDone = pipeline(source, limiter, ffmpeg.stdin);
    const outputDone = pipeline(ffmpeg.stdout, res);
    const processDone = new Promise((resolve, reject) => {
      ffmpeg.once('error', reject);
      ffmpeg.once('close', (code) => code === 0 ? resolve() : reject(new Error('FFmpeg exited with code ' + code)));
    });
    try {
      await Promise.all([inputDone, outputDone, processDone]);
    } finally {
      if (!ffmpeg.killed) ffmpeg.kill('SIGTERM');
      await dispatcher.close().catch(() => {});
    }
  } catch (error) {
    if (ffmpeg && !ffmpeg.killed) ffmpeg.kill('SIGKILL');
    if (dispatcher) await dispatcher.close().catch(() => {});
    if (res.headersSent) {
      if (!res.destroyed) res.destroy(error);
      return;
    }
    return sendApiError(res, error);
  }
}
