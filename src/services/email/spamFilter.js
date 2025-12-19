// src/services/email/spamFilter.js
const BAD = ['viagra', 'crypto airdrop', 'get rich quick'];
export function isLikelySpam({ subject = '', snippet = '' }) {
  const s = (subject + ' ' + snippet).toLowerCase();
  return BAD.some((w) => s.includes(w));
}
