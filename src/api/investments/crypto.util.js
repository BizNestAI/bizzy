// File: /src/api/investments/crypto.util.js
/* global Buffer */
import {
  decryptPlaidAccessToken,
  encryptPlaidAccessToken,
  resolvePlaidTokenKey,
} from '../../services/plaid/plaidTokenCrypto.js';

export function encrypt(plain) {
  return Buffer.from(encryptPlaidAccessToken(plain), 'utf8');
}

export function decrypt(bufOrBase64) {
  resolvePlaidTokenKey();
  const encoded = Buffer.isBuffer(bufOrBase64)
    ? bufOrBase64.toString('base64')
    : String(bufOrBase64);
  const decoded = Buffer.from(encoded, 'base64');
  const versioned = decoded.toString('utf8');
  if (versioned.startsWith('enc:v2:')) return decryptPlaidAccessToken(versioned);
  // Backward compatibility: legacy investment rows contain only the raw v1
  // AES-GCM payload and rely on the legacy k1 key.
  return decryptPlaidAccessToken(`enc:v1:${encoded}`);
}
