/* global Buffer */
import {
  assertPlaidTokenCryptoConfigured,
  decryptPlaidAccessToken,
  encryptPlaidAccessToken,
  plaidTokenEnvelopeVersion,
} from "./plaidTokenCrypto.js";
import { decrypt as decryptInvestmentToken, encrypt as encryptInvestmentToken } from "../../api/investments/crypto.util.js";

export const PLAID_TOKEN_FORMATS = Object.freeze({
  V2_K2: "V2_K2",
  V1_K1: "V1_K1",
  INVESTMENT_V1_K1: "INVESTMENT_V1_K1",
  PLAINTEXT_LEGACY: "PLAINTEXT_LEGACY",
  INVALID: "INVALID",
});

const PLAID_ACCESS_TOKEN_RE = /^access-[a-z0-9_-]+-.+/i;
const MAX_MIGRATION_LIMIT = 100;

function safeIdentity(table, row) {
  return { table, row_id: row.id || null };
}

export function classifyPlaidItemCredential(value) {
  if (!value || typeof value !== "string") return { format: PLAID_TOKEN_FORMATS.INVALID, reason: "missing_or_non_string" };
  const envelope = plaidTokenEnvelopeVersion(value);
  if (envelope?.version === "v2" && envelope.keyId === "k2") {
    try {
      decryptPlaidAccessToken(value);
      return { format: PLAID_TOKEN_FORMATS.V2_K2 };
    } catch {
      return { format: PLAID_TOKEN_FORMATS.INVALID, reason: "v2_authentication_failed" };
    }
  }
  if (envelope?.version === "v1") {
    try {
      decryptPlaidAccessToken(value);
      return { format: PLAID_TOKEN_FORMATS.V1_K1 };
    } catch {
      return { format: PLAID_TOKEN_FORMATS.INVALID, reason: "v1_authentication_failed" };
    }
  }
  if (PLAID_ACCESS_TOKEN_RE.test(value)) return { format: PLAID_TOKEN_FORMATS.PLAINTEXT_LEGACY };
  return { format: PLAID_TOKEN_FORMATS.INVALID, reason: envelope ? "unsupported_key_id" : "unrecognized_credential_format" };
}

export function classifyLinkedFinancialItemCredential(value) {
  if (!value || typeof value !== "string") return { format: PLAID_TOKEN_FORMATS.INVALID, reason: "missing_or_non_string" };
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    if (decoded.startsWith("enc:v2:k2:")) {
      decryptInvestmentToken(value);
      return { format: PLAID_TOKEN_FORMATS.V2_K2 };
    }
    decryptInvestmentToken(value);
    return { format: PLAID_TOKEN_FORMATS.INVESTMENT_V1_K1 };
  } catch {
    return { format: PLAID_TOKEN_FORMATS.INVALID, reason: "investment_envelope_invalid" };
  }
}

function plaintextForMigration(value, format, table) {
  if (table === "plaid_items" && format === PLAID_TOKEN_FORMATS.PLAINTEXT_LEGACY) return value;
  if (table === "plaid_items" && format === PLAID_TOKEN_FORMATS.V1_K1) return decryptPlaidAccessToken(value);
  if (table === "linked_financial_items" && format === PLAID_TOKEN_FORMATS.INVESTMENT_V1_K1) {
    return decryptInvestmentToken(value);
  }
  throw new Error("plaid_token_format_not_migratable");
}

function encryptedForTable(plain, table) {
  if (table === "plaid_items") return encryptPlaidAccessToken(plain);
  return encryptInvestmentToken(plain).toString("base64");
}

async function compareAndSet({ client, table, column, row, encrypted }) {
  const { data, error } = await client.from(table)
    .update({ [column]: encrypted })
    .eq("id", row.id)
    .eq(column, row[column])
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
}

async function readBatch(client, table, column, limit) {
  let query = client.from(table).select(`id,${column}`).not(column, "is", null);
  if (table === "linked_financial_items") query = query.eq("provider", "plaid");
  const { data, error } = await query.order("id", { ascending: true }).limit(limit);
  if (error) throw error;
  return data || [];
}

export async function migratePlaidTokens({ supabaseClient, apply = false, limit = 25 } = {}) {
  if (!supabaseClient?.from) throw new Error("supabase_client_required");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MIGRATION_LIMIT) throw new Error("invalid_migration_limit");
  assertPlaidTokenCryptoConfigured();

  const results = [];
  const specs = [
    { table: "plaid_items", column: "plaid_access_token" },
    { table: "linked_financial_items", column: "access_token_enc" },
  ];
  let remaining = limit;

  for (const spec of specs) {
    if (!remaining) break;
    const rows = await readBatch(supabaseClient, spec.table, spec.column, remaining);
    remaining -= rows.length;
    for (const row of rows) {
      const classified = spec.table === "plaid_items"
        ? classifyPlaidItemCredential(row[spec.column])
        : classifyLinkedFinancialItemCredential(row[spec.column]);
      const identity = safeIdentity(spec.table, row);
      if (classified.format === PLAID_TOKEN_FORMATS.V2_K2) {
        results.push({ ...identity, category: classified.format, status: "already_current" });
        continue;
      }
      if (![PLAID_TOKEN_FORMATS.V1_K1, PLAID_TOKEN_FORMATS.INVESTMENT_V1_K1, PLAID_TOKEN_FORMATS.PLAINTEXT_LEGACY].includes(classified.format)) {
        results.push({ ...identity, category: classified.format, status: "needs_attention", reason: classified.reason });
        continue;
      }
      if (!apply) {
        results.push({ ...identity, category: classified.format, status: "would_migrate" });
        continue;
      }
      const plain = plaintextForMigration(row[spec.column], classified.format, spec.table);
      const encrypted = encryptedForTable(plain, spec.table);
      const updated = await compareAndSet({ client: supabaseClient, ...spec, row, encrypted });
      results.push({ ...identity, category: classified.format, status: updated ? "migrated" : "conflict" });
    }
  }

  const summary = results.reduce((acc, row) => {
    acc.total += 1;
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, { total: 0 });
  return {
    apply: Boolean(apply),
    limit,
    bounded: true,
    mutated_columns: apply ? ["plaid_items.plaid_access_token", "linked_financial_items.access_token_enc"] : [],
    summary,
    results,
  };
}

export async function verifyPlaidTokenRotation({ supabaseClient, expectedActiveItems = null, limit = 100 } = {}) {
  if (!supabaseClient?.from) throw new Error("supabase_client_required");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MIGRATION_LIMIT) throw new Error("invalid_migration_limit");
  assertPlaidTokenCryptoConfigured();
  const { data: itemRows, error: itemError } = await supabaseClient.from("plaid_items")
    .select("id,is_active,status,plaid_access_token")
    .order("id", { ascending: true })
    .limit(limit);
  if (itemError) throw itemError;
  const { data: investmentRows, error: investmentError } = await supabaseClient.from("linked_financial_items")
    .select("id,provider,access_token_enc")
    .eq("provider", "plaid")
    .not("access_token_enc", "is", null)
    .order("id", { ascending: true })
    .limit(limit);
  if (investmentError) throw investmentError;

  const activeRows = (itemRows || []).filter((row) => row.is_active === true && ["active", "connected"].includes(row.status));
  const itemResults = activeRows.map((row) => ({
    table: "plaid_items",
    row_id: row.id,
    category: classifyPlaidItemCredential(row.plaid_access_token).format,
  }));
  const investmentResults = (investmentRows || []).map((row) => ({
    table: "linked_financial_items",
    row_id: row.id,
    category: classifyLinkedFinancialItemCredential(row.access_token_enc).format,
  }));
  const v2K2 = itemResults.filter((row) => row.category === PLAID_TOKEN_FORMATS.V2_K2).length;
  const invalid = [...itemResults, ...investmentResults].filter((row) => row.category === PLAID_TOKEN_FORMATS.INVALID).length;
  const expectedMatches = expectedActiveItems === null || activeRows.length === expectedActiveItems;
  const ok = expectedMatches && v2K2 === activeRows.length && invalid === 0;
  return {
    ok,
    expected_active_items: expectedActiveItems,
    active_items: activeRows.length,
    active_v2_k2_authenticated: v2K2,
    active_legacy_or_plaintext: activeRows.length - v2K2,
    investment_credentials: investmentResults.length,
    invalid_credentials: invalid,
    results: [...itemResults, ...investmentResults],
  };
}

// Backward-compatible export for existing callers. It now performs the bounded
// two-column rotation rather than a plaintext-only plaid_items migration.
export const migratePlaidItemAccessTokens = migratePlaidTokens;
