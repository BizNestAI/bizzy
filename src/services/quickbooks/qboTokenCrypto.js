import crypto from "crypto";

const ENVELOPE_PREFIX = "enc:v1:";
const KEY_ENV_NAMES = ["QBO_TOKEN_ENCRYPTION_KEY", "ENCRYPTION_KEY_32B"];

function configuredKey() {
  if (process.env.NODE_ENV === "production") {
    return {
      name: "QBO_TOKEN_ENCRYPTION_KEY",
      value: process.env.QBO_TOKEN_ENCRYPTION_KEY || "",
    };
  }

  for (const name of KEY_ENV_NAMES) {
    const value = process.env[name];
    if (value) return { name, value };
  }
  return { name: null, value: "" };
}

export function resolveQboTokenKey() {
  const { name, value } = configuredKey();
  if (!value) throw new Error("qbo_token_encryption_key_missing");

  const trimmed = String(value).trim();
  const base64 = Buffer.from(trimmed, "base64");
  if (base64.length === 32 && base64.toString("base64").replace(/=+$/, "") === trimmed.replace(/=+$/, "")) {
    return { name, key: base64 };
  }

  const utf8 = Buffer.from(trimmed, "utf8");
  if (utf8.length === 32) return { name, key: utf8 };

  throw new Error("qbo_token_encryption_key_invalid");
}

export function assertQboTokenCryptoConfigured() {
  resolveQboTokenKey();
  return true;
}

if (process.env.NODE_ENV === "production") {
  assertQboTokenCryptoConfigured();
}

export function isEncryptedQboToken(value) {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

export function encryptQboToken(plain) {
  if (!plain) throw new Error("qbo_token_missing");
  const { key } = resolveQboTokenKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${Buffer.concat([iv, tag, enc]).toString("base64")}`;
}

export function decryptQboToken(stored) {
  if (!stored) throw new Error("qbo_token_missing");
  if (!isEncryptedQboToken(stored)) throw new Error("qbo_token_not_encrypted");
  const { key } = resolveQboTokenKey();
  const raw = Buffer.from(stored.slice(ENVELOPE_PREFIX.length), "base64");
  if (raw.length <= 28) throw new Error("qbo_token_ciphertext_invalid");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export async function resolveStoredQboToken({ storedToken, persistEncrypted }) {
  if (!storedToken) throw new Error("qbo_token_missing");
  if (isEncryptedQboToken(storedToken)) return decryptQboToken(storedToken);

  const encrypted = encryptQboToken(storedToken);
  if (typeof persistEncrypted === "function") await persistEncrypted(encrypted);
  return String(storedToken);
}

export const QBO_TOKEN_ENVELOPE_PREFIX = ENVELOPE_PREFIX;
