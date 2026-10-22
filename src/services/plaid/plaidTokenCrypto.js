/* global process, Buffer */
import crypto from "crypto";

const V1_PREFIX = "enc:v1:";
const V2_PREFIX = "enc:v2:";
const ACTIVE_KEY_ID = "k2";

function decodeKey(name, value) {
  if (!value) throw new Error(`plaid_token_encryption_key_missing:${name}`);
  const trimmed = String(value).trim();
  const base64 = Buffer.from(trimmed, "base64");
  if (base64.length === 32 && base64.toString("base64").replace(/=+$/, "") === trimmed.replace(/=+$/, "")) {
    return base64;
  }
  const utf8 = Buffer.from(trimmed, "utf8");
  if (utf8.length === 32) return utf8;
  throw new Error(`plaid_token_encryption_key_invalid:${name}`);
}

function legacyKeyValue() {
  if (process.env.PLAID_TOKEN_ENCRYPTION_KEY) return process.env.PLAID_TOKEN_ENCRYPTION_KEY;
  if (process.env.NODE_ENV !== "production") return process.env.ENCRYPTION_KEY_32B || "";
  return "";
}

function configuredActiveKeyId() {
  const configured = String(process.env.PLAID_TOKEN_ACTIVE_KEY_ID || "").trim();
  if (process.env.NODE_ENV === "production" && !configured) {
    throw new Error("plaid_token_active_key_id_missing");
  }
  const keyId = configured || ACTIVE_KEY_ID;
  if (keyId !== ACTIVE_KEY_ID) throw new Error("plaid_token_active_key_id_invalid");
  return keyId;
}

export function resolvePlaidTokenKey(keyId = configuredActiveKeyId()) {
  if (keyId === "k1") {
    return { name: "PLAID_TOKEN_ENCRYPTION_KEY", keyId, key: decodeKey("k1", legacyKeyValue()) };
  }
  if (keyId === ACTIVE_KEY_ID) {
    return {
      name: "PLAID_TOKEN_ENCRYPTION_KEY_K2",
      keyId,
      key: decodeKey(ACTIVE_KEY_ID, process.env.PLAID_TOKEN_ENCRYPTION_KEY_K2 || ""),
    };
  }
  throw new Error("plaid_token_key_id_unknown");
}

export function assertPlaidTokenCryptoConfigured() {
  configuredActiveKeyId();
  resolvePlaidTokenKey("k1");
  resolvePlaidTokenKey(ACTIVE_KEY_ID);
  return true;
}

if (process.env.NODE_ENV === "production") assertPlaidTokenCryptoConfigured();

export function isEncryptedPlaidToken(value) {
  return typeof value === "string" && (value.startsWith(V1_PREFIX) || value.startsWith(V2_PREFIX));
}

export function plaidTokenEnvelopeVersion(value) {
  if (typeof value !== "string") return null;
  if (value.startsWith(V1_PREFIX)) return { version: "v1", keyId: "k1" };
  const match = value.match(/^enc:v2:([^:]+):/);
  return match ? { version: "v2", keyId: match[1] } : null;
}

function encryptEnvelope(plain, keyId) {
  if (!plain) throw new Error("plaid_access_token_missing");
  const { key } = resolvePlaidTokenKey(keyId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]).toString("base64");
  return keyId === "k1" ? `${V1_PREFIX}${payload}` : `${V2_PREFIX}${keyId}:${payload}`;
}

export function encryptPlaidAccessToken(plain) {
  return encryptEnvelope(plain, configuredActiveKeyId());
}

// Migration/tests only. Runtime writes must always use encryptPlaidAccessToken and k2.
export function encryptPlaidAccessTokenLegacyV1(plain) {
  return encryptEnvelope(plain, "k1");
}

export function decryptPlaidAccessToken(stored) {
  if (!stored) throw new Error("plaid_access_token_missing");
  const envelope = plaidTokenEnvelopeVersion(stored);
  if (!envelope) throw new Error("plaid_access_token_not_encrypted");
  if (envelope.version === "v1" && envelope.keyId !== "k1") throw new Error("plaid_token_key_id_unknown");
  if (envelope.version === "v2" && envelope.keyId !== ACTIVE_KEY_ID) throw new Error("plaid_token_key_id_unknown");
  const prefix = envelope.version === "v1" ? V1_PREFIX : `${V2_PREFIX}${envelope.keyId}:`;
  const raw = Buffer.from(stored.slice(prefix.length), "base64");
  if (raw.length <= 28) throw new Error("plaid_access_token_ciphertext_invalid");
  const { key } = resolvePlaidTokenKey(envelope.keyId);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

export async function resolveStoredPlaidAccessToken({ storedToken }) {
  if (!storedToken) throw new Error("plaid_access_token_missing");
  if (!isEncryptedPlaidToken(storedToken)) throw new Error("plaid_access_token_migration_required");
  return decryptPlaidAccessToken(storedToken);
}

export const PLAID_TOKEN_ENVELOPE_PREFIX = V2_PREFIX;
export const PLAID_TOKEN_LEGACY_ENVELOPE_PREFIX = V1_PREFIX;
export const PLAID_TOKEN_ACTIVE_KEY_ID = ACTIVE_KEY_ID;
