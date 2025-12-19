// src/api/_shared/safeJson.js
export function stripFences(s = '') {
  return s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
}
export function safeJSON(s = '{}') {
  try { return JSON.parse(stripFences(s)); } catch { return {}; }
}
