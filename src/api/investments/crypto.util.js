// File: /src/api/investments/crypto.util.js
import {
  decryptPlaidAccessToken,
  encryptPlaidAccessToken,
  resolvePlaidTokenKey,
} from '../../services/plaid/plaidTokenCrypto.js';

export function encrypt(plain) {
  const encrypted = encryptPlaidAccessToken(plain);
  return Buffer.from(encrypted.replace(/^enc:v1:/, ''), 'base64');
}

export function decrypt(bufOrBase64) {
  resolvePlaidTokenKey();
  const base64 = Buffer.isBuffer(bufOrBase64)
    ? bufOrBase64.toString('base64')
    : String(bufOrBase64);
  return decryptPlaidAccessToken(`enc:v1:${base64}`);
}
