import crypto from "crypto";

const ENVELOPE_PREFIX = "enc:v1:";
const KEY_ENV_NAMES = ["PLAID_TOKEN_ENCRYPTION_KEY", "ENCRYPTION_KEY_32B"];

function configuredKey() {
  if (process.env.NODE_ENV === "production") {
    return {
      name: "PLAID_TOKEN_ENCRYPTION_KEY",
      value: process.env.PLAID_TOKEN_ENCRYPTION_KEY || "",
    };
  }

  for (const name of KEY_ENV_NAMES) {
    const value = process.env[name];
    if (value) return { name, value };
  }
  return { name: null, value: "" };
}

export function resolvePlaidTokenKey() {
  const { name, value } = configuredKey();
  if (!value) {
    throw new Error("plaid_token_encryption_key_missing");
  }

  const trimmed = String(value).trim();
  const base64 = Buffer.from(trimmed, "base64");
  if (base64.length === 32 && base64.toString("base64").replace(/=+$/, "") === trimmed.replace(/=+$/, "")) {
    return { name, key: base64 };
  }

  const utf8 = Buffer.from(trimmed, "utf8");
  if (utf8.length === 32) return { name, key: utf8 };

  throw new Error("plaid_token_encryption_key_invalid");
}

export function assertPlaidTokenCryptoConfigured() {
  resolvePlaidTokenKey();
  return true;
}

if (process.env.NODE_ENV === "production") {
  assertPlaidTokenCryptoConfigured();
}

export function isEncryptedPlaidToken(value) {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

export function encryptPlaidAccessToken(plain) {
  if (!plain) throw new Error("plaid_access_token_missing");
  const { key } = resolvePlaidTokenKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${Buffer.concat([iv, tag, enc]).toString("base64")}`;
}

export function decryptPlaidAccessToken(stored) {
  if (!stored) throw new Error("plaid_access_token_missing");
  if (!isEncryptedPlaidToken(stored)) {
    throw new Error("plaid_access_token_not_encrypted");
  }
  const { key } = resolvePlaidTokenKey();
  const raw = Buffer.from(stored.slice(ENVELOPE_PREFIX.length), "base64");
  if (raw.length <= 28) throw new Error("plaid_access_token_ciphertext_invalid");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export async function resolveStoredPlaidAccessToken({ storedToken, persistEncrypted }) {
  if (!storedToken) throw new Error("plaid_access_token_missing");
  if (isEncryptedPlaidToken(storedToken)) {
    return decryptPlaidAccessToken(storedToken);
  }

  const encrypted = encryptPlaidAccessToken(storedToken);
  if (typeof persistEncrypted === "function") {
    await persistEncrypted(encrypted);
  }
  return String(storedToken);
}

export const PLAID_TOKEN_ENVELOPE_PREFIX = ENVELOPE_PREFIX;
