// File: /src/api/investments/crypto.util.js
import crypto from 'crypto';

const KEY_B64 = process.env.ENCRYPTION_KEY_32B; // base64 32-byte

if (!KEY_B64) {
  console.warn('[crypto] ENCRYPTION_KEY_32B not set — encryption will throw if used.');
}

export function encrypt(plain) {
  if (!KEY_B64) throw new Error('encryption_key_missing');
  const key = Buffer.from(KEY_B64, 'base64');      // 32 bytes
  const iv  = crypto.randomBytes(12);              // 96-bit for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // store as iv|tag|enc
  return Buffer.concat([iv, tag, enc]);
}

export function decrypt(bufOrBase64) {
  if (!KEY_B64) throw new Error('encryption_key_missing');
  const key = Buffer.from(KEY_B64, 'base64');
  const raw = Buffer.isBuffer(bufOrBase64) ? bufOrBase64 : Buffer.from(String(bufOrBase64), 'base64');
  const iv  = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}
