import { inspectMediaUrl, sendApiError, sendJson, parseRequestBody } from '../_lib/media.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  try {
    const body = parseRequestBody(req);
    const result = await inspectMediaUrl(body.url);
    return sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    return sendApiError(res, error);
  }
}
