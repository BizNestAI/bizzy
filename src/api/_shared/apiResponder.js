// src/api/_shared/apiResponder.js
export function sendOk(res, data, meta = {}) {
  return res.status(200).json({ data, error: null, meta });
}
export function sendErr(res, status = 500, message = 'Internal error', meta = {}) {
  return res.status(status).json({ data: null, error: { message }, meta });
}
