import { supabase as defaultDb } from "../supabaseAdmin.js";

/* global process */

const PAGE_SIZE = 500;
const IN_QUERY_SIZE = 200;
const CONFIRMED_STATUSES = new Set(["posted", "matched", "matched_existing_qbo", "reconciled"]);
export const JOB_COSTING_BANK_TRANSACTION_COLUMNS = [
  "id",
  "date",
  "name",
  "merchant_name",
  "counterparty_name",
  "raw",
  "amount",
  "direction",
  "pending",
  "is_archived",
  "plaid_account_id",
];

function chunks(values, size = IN_QUERY_SIZE) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function isConfirmedCategorization(row = {}) {
  const status = String(row.status || "").toLowerCase();
  const qboId = row.qbo_txn_id || row.meta?.confirmed_qbo_entity_id;
  return Boolean(qboId) && CONFIRMED_STATUSES.has(status) && !row.excluded_at && !row.meta?.excluded_at;
}

async function fetchAllCategorizations(db, businessId) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from("transaction_categorizations")
      .select("transaction_id,status,final_qbo_account_id,final_qbo_account_name,qbo_txn_id,qbo_txn_type,posted_at,reconciled_at,excluded_at,meta,updated_at")
      .eq("business_id", businessId)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows.filter(isConfirmedCategorization);
}

async function fetchBankTransactions(db, businessId, transactionIds) {
  const rows = [];
  for (const ids of chunks(transactionIds)) {
    const { data, error } = await db
      .from("bank_transactions")
      .select(JOB_COSTING_BANK_TRANSACTION_COLUMNS.join(","))
      .eq("business_id", businessId)
      .in("id", ids);
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function getCanonicalBankDescription(bank = {}) {
  const raw = bank.raw && typeof bank.raw === "object" && !Array.isArray(bank.raw) ? bank.raw : {};
  return [bank.name, raw.name, raw.memo, raw.original_description]
    .map(cleanText)
    .find(Boolean) || "";
}

export function getCanonicalBankVendor(bank = {}) {
  return [bank.counterparty_name, bank.merchant_name]
    .map(cleanText)
    .find(Boolean) || "";
}

/** Durable, provider-independent source for Job Costing's confirmed transaction list. */
export async function fetchConfirmedJobCostingTransactions({ businessId, db = defaultDb, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!businessId) throw new Error("business_id_required");
  const categorizations = await fetchAllCategorizations(db, businessId);
  const ids = [...new Set(categorizations.map((row) => row.transaction_id).filter(Boolean))];
  if (!ids.length) return { rows: [], postedCount: 0, matchedCount: 0 };
  const bankRows = await fetchBankTransactions(db, businessId, ids);
  const bankById = new Map(bankRows.map((row) => [String(row.id), row]));
  const identities = new Set();
  const rows = [];
  let postedCount = 0;
  let matchedCount = 0;

  for (const cat of categorizations) {
    const bank = bankById.get(String(cat.transaction_id));
    if (!bank || bank.pending === true || bank.is_archived === true || !bank.date || String(bank.date) > today) continue;
    const qboTxnId = cat.qbo_txn_id || cat.meta?.confirmed_qbo_entity_id;
    const qboTxnType = cat.qbo_txn_type || cat.meta?.confirmed_qbo_entity_type || "Transaction";
    const identity = `${qboTxnType}:${qboTxnId}`;
    if (identities.has(identity)) continue;
    identities.add(identity);
    const matched = ["matched", "matched_existing_qbo", "reconciled"].includes(String(cat.status || "").toLowerCase());
    if (matched) matchedCount += 1;
    else postedCount += 1;
    const vendor = getCanonicalBankVendor(bank);
    const description = getCanonicalBankDescription(bank);
    rows.push({
      id: bank.id,
      transaction_id: bank.id,
      date: bank.date,
      vendor,
      payee: vendor,
      description,
      memo: description,
      bank_memo: description,
      // Compatibility field for existing UI consumers. This is derived from
      // schema-backed data and is not a bank_transactions database column.
      original_description: description,
      display_description: vendor || description || "No description",
      amount: Number(bank.amount || 0),
      direction: bank.direction || (Number(bank.amount || 0) < 0 ? "OUTFLOW" : "INFLOW"),
      final_qbo_account_id: cat.final_qbo_account_id || null,
      final_qbo_account_name: cat.final_qbo_account_name || null,
      gl_account_id: cat.final_qbo_account_id || null,
      gl_account: cat.final_qbo_account_name || "Uncategorized",
      qbo_txn_id: qboTxnId,
      qbo_txn_type: qboTxnType,
      posted_at: cat.posted_at || cat.reconciled_at || null,
      plaid_account_id: bank.plaid_account_id || null,
      status: matched ? "matched" : "posted",
      provider_identity: identity,
    });
  }
  rows.sort((left, right) => String(right.date).localeCompare(String(left.date)) || String(right.id).localeCompare(String(left.id)));
  return { rows, postedCount, matchedCount };
}

export function safeJobCostingDataFailure(error, context = {}) {
  const cause = error?.cause || null;
  const code = cause?.code || error?.code || null;
  const hostname = (() => {
    try { return new URL(process.env.SUPABASE_URL || "").hostname || null; } catch { return null; }
  })();
  return {
    upstream_service: "supabase_postgrest",
    hostname,
    method: "GET",
    operation: context.operation || "job_costing_confirmed_transactions",
    timeout_ms: context.timeoutMs || null,
    elapsed_ms: context.elapsedMs || 0,
    error_name: error?.name || "Error",
    error_message: error?.message || String(error),
    error_code: error?.code || null,
    cause_name: cause?.name || null,
    cause_message: cause?.message || null,
    cause_code: cause?.code || null,
    network_classification: /^\d{5}$/.test(String(code || "")) || /^PGRST/.test(String(code || "")) ? "database" : /ENOTFOUND|EAI_AGAIN/.test(String(code)) ? "dns" : /ECONNREFUSED/.test(String(code)) ? "connection_refused" : /TIMEOUT|ETIMEDOUT/i.test(String(code)) ? "timeout" : /CERT|TLS/i.test(String(code)) ? "tls" : code ? "transport" : "unknown",
    attempt_count: 1,
    aborted: error?.name === "AbortError" || cause?.name === "AbortError",
    deployment_sha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.DEPLOYMENT_SHA || null,
    business_id: context.businessId || null,
    correlation_id: context.correlationId || null,
  };
}

/** Safe startup/diagnostic shape: validates configuration without exposing credentials. */
export function getJobCostingRepositoryConfig(env = process.env) {
  let hostname = null;
  let protocol = null;
  let urlValid = false;
  try {
    const parsed = new URL(env.SUPABASE_URL || "");
    hostname = parsed.hostname || null;
    protocol = parsed.protocol || null;
    urlValid = Boolean(hostname && ["http:", "https:"].includes(protocol));
  } catch {
    // Safe validation result below is intentionally secret-free.
  }
  return {
    upstream_service: "supabase_postgrest",
    hostname,
    protocol,
    url_valid: urlValid,
    service_role_configured: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
  };
}
