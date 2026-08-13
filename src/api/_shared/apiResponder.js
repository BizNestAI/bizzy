// src/api/_shared/apiResponder.js
import { buildSafeErrorResponse } from './safeErrorResponse.js';

export function sendOk(res, data, meta = {}) {
  return res.status(200).json({ data, error: null, meta });
}
export function sendErr(res, status = 500, message = 'Internal error', meta = {}) {
  const err = new Error(message);
  err.status = status;
  err.meta = meta;
  err.code = status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR';
  err.expose = status < 500;
  const safe = buildSafeErrorResponse(err);
  return res.status(safe.status).json({ data: null, error: { message: safe.body.message, code: safe.body.error }, meta: safe.body.meta || {} });
}
