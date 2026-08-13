import {
  assertQboTokenCryptoConfigured,
  decryptQboToken,
  encryptQboToken,
  isEncryptedQboToken,
} from "./qboTokenCrypto.js";

export const QBO_TOKEN_FORMATS = Object.freeze({
  ENCRYPTED_CURRENT: "ENCRYPTED_CURRENT",
  PLAINTEXT_LEGACY: "PLAINTEXT_LEGACY",
  INVALID: "INVALID",
});

const QBO_ACCESS_RE = /^eyJ|^qbo-access-|^access[-_]/i;
const QBO_REFRESH_RE = /^AB|^qbo-refresh-|^refresh[-_]/i;

function safeRowIdentity(row = {}) {
  return {
    row_id: row.id || null,
    business_id: row.business_id || null,
    realm_id: row.realm_id || null,
    qbo_env: row.qbo_env || null,
  };
}

export function classifyQboToken(value, kind = "token") {
  if (!value || typeof value !== "string") {
    return { format: QBO_TOKEN_FORMATS.INVALID, reason: "missing_or_non_string" };
  }
  if (isEncryptedQboToken(value)) {
    try {
      decryptQboToken(value);
      return { format: QBO_TOKEN_FORMATS.ENCRYPTED_CURRENT };
    } catch {
      return { format: QBO_TOKEN_FORMATS.INVALID, reason: "encrypted_envelope_invalid" };
    }
  }
  const matcher = kind === "refresh" ? QBO_REFRESH_RE : QBO_ACCESS_RE;
  if (matcher.test(value)) return { format: QBO_TOKEN_FORMATS.PLAINTEXT_LEGACY };
  return { format: QBO_TOKEN_FORMATS.INVALID, reason: "unrecognized_token_format" };
}

export async function migrateQboTokens({ supabaseClient, apply = false, limit = 1000 } = {}) {
  if (!supabaseClient?.from) throw new Error("supabase_client_required");
  assertQboTokenCryptoConfigured();

  const { data, error } = await supabaseClient
    .from("quickbooks_tokens")
    .select("id,business_id,realm_id,qbo_env,access_token,refresh_token")
    .limit(limit);
  if (error) throw error;

  const results = [];
  for (const row of data || []) {
    const identity = safeRowIdentity(row);
    const access = classifyQboToken(row.access_token, "access");
    const refresh = classifyQboToken(row.refresh_token, "refresh");
    const alreadyEncrypted =
      access.format === QBO_TOKEN_FORMATS.ENCRYPTED_CURRENT &&
      refresh.format === QBO_TOKEN_FORMATS.ENCRYPTED_CURRENT;
    const hasPlaintext =
      access.format === QBO_TOKEN_FORMATS.PLAINTEXT_LEGACY ||
      refresh.format === QBO_TOKEN_FORMATS.PLAINTEXT_LEGACY;
    const hasInvalid =
      access.format === QBO_TOKEN_FORMATS.INVALID ||
      refresh.format === QBO_TOKEN_FORMATS.INVALID;

    if (alreadyEncrypted) {
      results.push({ ...identity, access_format: access.format, refresh_format: refresh.format, status: "already_encrypted" });
      continue;
    }
    if (hasInvalid) {
      results.push({
        ...identity,
        access_format: access.format,
        refresh_format: refresh.format,
        status: "needs_attention",
      });
      continue;
    }
    if (hasPlaintext && !apply) {
      results.push({ ...identity, access_format: access.format, refresh_format: refresh.format, status: "would_encrypt" });
      continue;
    }
    if (hasPlaintext) {
      const update = {
        access_token: isEncryptedQboToken(row.access_token) ? row.access_token : encryptQboToken(row.access_token),
        refresh_token: isEncryptedQboToken(row.refresh_token) ? row.refresh_token : encryptQboToken(row.refresh_token),
      };
      let query = supabaseClient.from("quickbooks_tokens").update(update);
      if (row.id) query = query.eq("id", row.id);
      else query = query.eq("business_id", row.business_id).eq("qbo_env", row.qbo_env);
      const updateResult = await query;
      if (updateResult.error) throw updateResult.error;
      results.push({ ...identity, access_format: access.format, refresh_format: refresh.format, status: "encrypted" });
    }
  }

  const summary = results.reduce((acc, row) => {
    acc.total += 1;
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, { total: 0 });

  return { apply: Boolean(apply), limit, summary, results };
}
