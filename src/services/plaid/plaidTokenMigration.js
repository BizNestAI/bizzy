import {
  assertPlaidTokenCryptoConfigured,
  decryptPlaidAccessToken,
  encryptPlaidAccessToken,
  isEncryptedPlaidToken,
} from "./plaidTokenCrypto.js";

export const PLAID_TOKEN_FORMATS = Object.freeze({
  ENCRYPTED_CURRENT: "ENCRYPTED_CURRENT",
  ENCRYPTED_LEGACY: "ENCRYPTED_LEGACY",
  PLAINTEXT_LEGACY: "PLAINTEXT_LEGACY",
  INVALID: "INVALID",
});

const PLAID_ACCESS_TOKEN_RE = /^access-[a-z0-9_-]+-.+/i;

function safeRowIdentity(row = {}) {
  return {
    row_id: row.id || null,
    business_id: row.business_id || null,
    plaid_item_id: row.plaid_item_id || null,
  };
}

export function classifyPlaidItemCredential(value) {
  if (!value || typeof value !== "string") {
    return { format: PLAID_TOKEN_FORMATS.INVALID, reason: "missing_or_non_string" };
  }

  if (isEncryptedPlaidToken(value)) {
    try {
      decryptPlaidAccessToken(value);
      return { format: PLAID_TOKEN_FORMATS.ENCRYPTED_CURRENT };
    } catch {
      return { format: PLAID_TOKEN_FORMATS.INVALID, reason: "encrypted_envelope_invalid" };
    }
  }

  if (PLAID_ACCESS_TOKEN_RE.test(value)) {
    return { format: PLAID_TOKEN_FORMATS.PLAINTEXT_LEGACY };
  }

  return { format: PLAID_TOKEN_FORMATS.INVALID, reason: "unrecognized_credential_format" };
}

export function classifyLinkedFinancialItemCredential(value) {
  if (!value || typeof value !== "string") {
    return { format: PLAID_TOKEN_FORMATS.INVALID, reason: "missing_or_non_string" };
  }

  if (isEncryptedPlaidToken(value)) {
    try {
      decryptPlaidAccessToken(value);
      return { format: PLAID_TOKEN_FORMATS.ENCRYPTED_CURRENT };
    } catch {
      return { format: PLAID_TOKEN_FORMATS.INVALID, reason: "encrypted_envelope_invalid" };
    }
  }

  try {
    decryptPlaidAccessToken(`enc:v1:${value}`);
    return { format: PLAID_TOKEN_FORMATS.ENCRYPTED_LEGACY };
  } catch {
    return { format: PLAID_TOKEN_FORMATS.INVALID, reason: "legacy_encrypted_blob_invalid" };
  }
}

async function updatePlaidItemCredential({ supabaseClient, row, encrypted }) {
  let query = supabaseClient
    .from("plaid_items")
    .update({
      plaid_access_token: encrypted,
      updated_at: new Date().toISOString(),
    });

  if (row.id) {
    query = query.eq("id", row.id);
  } else {
    query = query.eq("business_id", row.business_id).eq("plaid_item_id", row.plaid_item_id);
  }

  const { error } = await query;
  if (error) throw error;
}

export async function migratePlaidItemAccessTokens({
  supabaseClient,
  apply = false,
  limit = 1000,
} = {}) {
  if (!supabaseClient?.from) {
    throw new Error("supabase_client_required");
  }

  assertPlaidTokenCryptoConfigured();

  const { data, error } = await supabaseClient
    .from("plaid_items")
    .select("id,business_id,plaid_item_id,plaid_access_token")
    .limit(limit);
  if (error) throw error;

  const results = [];
  for (const row of data || []) {
    const identity = safeRowIdentity(row);
    const classified = classifyPlaidItemCredential(row.plaid_access_token);

    if (classified.format === PLAID_TOKEN_FORMATS.ENCRYPTED_CURRENT) {
      results.push({ ...identity, format: classified.format, status: "already_encrypted" });
      continue;
    }

    if (classified.format === PLAID_TOKEN_FORMATS.PLAINTEXT_LEGACY) {
      if (!apply) {
        results.push({ ...identity, format: classified.format, status: "would_encrypt" });
        continue;
      }

      const encrypted = encryptPlaidAccessToken(row.plaid_access_token);
      await updatePlaidItemCredential({ supabaseClient, row, encrypted });
      results.push({ ...identity, format: classified.format, status: "encrypted" });
      continue;
    }

    results.push({
      ...identity,
      format: classified.format,
      status: "needs_attention",
      reason: classified.reason,
    });
  }

  const summary = results.reduce(
    (acc, row) => {
      acc.total += 1;
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    },
    { total: 0 }
  );

  return { apply: Boolean(apply), limit, summary, results };
}
