// /src/services/tax/taxPostedTransaction.repository.js
import { normalizeTaxYear } from "./taxDomain.js";
import { dataUnavailableError, notFoundError, validationError } from "./taxErrors.js";
import { getTaxEligibilityReason } from "./taxTransactionEligibility.js";
import { normalizePostedTransactionForTax } from "./taxTransactionNormalizer.js";
import { applyActiveBookkeepingScope, getBookkeepingStartDate, isTransactionInActiveBookkeepingScope } from "../bookkeeping/bookkeepingScope.js";

const CHUNK_SIZE = 50;
const RELATED_ROW_CONCURRENCY = 3;
const RELATED_ROW_RETRY_ATTEMPTS = 2;
const BANK_PAGE_SIZE = 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 250;

const BANK_SELECT = [
  "id", "business_id", "plaid_account_id", "plaid_transaction_id", "pending", "date", "authorized_date",
  "name", "merchant_name", "merchant_entity_id", "payment_channel", "transaction_type", "check_number",
  "amount", "signed_amount", "direction", "category_primary", "category_detailed", "personal_finance_category",
  "counterparty_name", "qbo_entity_type", "qbo_entity_id", "is_archived", "archived_at", "duplicate_fingerprint",
  "raw", "location", "counterparties", "created_at",
].join(",");

const CAT_SELECT = [
  "id", "business_id", "transaction_id", "status", "suggested_qbo_account_id", "suggested_qbo_account_name",
  "confidence", "reason", "final_qbo_account_id", "final_qbo_account_name", "decided_by", "decided_at",
  "meta", "post_after", "qbo_txn_id", "qbo_txn_type", "posted_at", "post_error", "reconciled_at",
  "txn_date", "txn_name", "signed_amount", "is_archived",
].join(",");

const QBO_SELECT = [
  "id", "business_id", "transaction_id", "qbo_env", "realm_id", "qbo_txn_type", "qbo_txn_id",
  "qbo_sync_token", "status", "posted_at", "error", "payload", "response",
].join(",");

export async function getPostedTransactionForTax({ supabase, businessId, transactionId } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  if (!transactionId) throw validationError("missing_transaction_id", "transactionId is required.");

  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
  const { data: bankTransaction, error } = await supabase
    .from("bank_transactions")
    .select(BANK_SELECT)
    .eq("business_id", businessId)
    .eq("id", transactionId)
    .maybeSingle();
  if (error) throw error;
  if (!bankTransaction) throw notFoundError("transaction_not_found", "Posted transaction was not found.");
  if (!isTransactionInActiveBookkeepingScope(bankTransaction, bookkeepingStartDate)) {
    throw notFoundError("posted_tax_transaction_not_found", "Eligible posted transaction was not found.", {
      reason: "transaction_before_bookkeeping_start_date",
      bookkeeping_start_date: bookkeepingStartDate,
    });
  }

  const related = await fetchRelatedRows({ supabase, businessId, transactionIds: [transactionId] });
  const row = buildTaxRow({
    bankTransaction,
    categorization: related.catMap.get(String(transactionId)),
    qboPostedTransaction: related.qboMap.get(String(transactionId)),
    businessId,
  });
  if (!row.isEligible) {
    throw notFoundError("posted_tax_transaction_not_found", "Eligible posted transaction was not found.", {
      reason: row.eligibilityReason,
    });
  }
  return row;
}

export async function listPostedTransactionsForTax({
  supabase,
  businessId,
  taxYear,
  dateFrom,
  dateTo,
  accountId,
  qboAccountId,
  direction,
  search,
  limit = DEFAULT_LIMIT,
  offset = 0,
  cursor,
  includeSourceWarnings = true,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const range = resolveDateRange({ taxYear, dateFrom, dateTo });
  const page = normalizePagination({ limit, offset });
  const bankRows = await fetchBankRows({ supabase, businessId, range, accountId, direction });
  const hydrated = await hydrateRows({ supabase, businessId, bankRows });
  let rows = hydrated.filter((row) => row.isEligible).filter((row) => matchesTaxSearch(row, search)).sort(compareTaxRows);
  if (qboAccountId) rows = rows.filter((row) => row.qboAccountId === qboAccountId);
  if (!includeSourceWarnings) rows = rows.map((row) => ({ ...row, sourceWarnings: [] }));

  const count = rows.length;
  const paged = rows.slice(page.offset, page.offset + page.limit);
  return {
    rows: paged,
    pagination: {
      limit: page.limit,
      offset: page.offset,
      cursor: cursor || null,
      returned: paged.length,
      total: count,
      hasMore: page.offset + page.limit < count,
    },
    counts: { eligiblePosted: count },
    warnings: collectListWarnings(paged),
  };
}

export async function listUnclassifiedPostedTransactions({ supabase, businessId, taxYear, limit = DEFAULT_LIMIT, offset = 0, cursor } = {}) {
  const year = requireTaxYear(taxYear);
  const postedRows = await listAllEligiblePostedRows({ supabase, businessId, taxYear: year });
  const ids = postedRows.map((row) => row.transactionId);
  const classifiedIds = await fetchClassifiedTransactionIds({ supabase, businessId, taxYear: year, transactionIds: ids });
  const unclassified = postedRows.filter((row) => !classifiedIds.has(String(row.transactionId)));
  const page = normalizePagination({ limit, offset });
  const paged = unclassified.slice(page.offset, page.offset + page.limit);
  return {
    rows: paged,
    pagination: {
      limit: page.limit,
      offset: page.offset,
      cursor: cursor || null,
      returned: paged.length,
      total: unclassified.length,
      hasMore: page.offset + page.limit < unclassified.length,
    },
    counts: { unclassified: unclassified.length },
    warnings: collectListWarnings(paged),
  };
}

async function listAllEligiblePostedRows({ supabase, businessId, taxYear }) {
  const rows = [];
  for (let offset = 0; ; offset += MAX_LIMIT) {
    const page = await listPostedTransactionsForTax({ supabase, businessId, taxYear, limit: MAX_LIMIT, offset });
    rows.push(...page.rows);
    if (!page.pagination.hasMore) break;
  }
  return rows.sort(compareTaxRows);
}

export async function countPostedTransactionsForTax({ supabase, businessId, taxYear } = {}) {
  const result = await listPostedTransactionsForTax({ supabase, businessId, taxYear, limit: MAX_LIMIT, offset: 0 });
  return result.counts.eligiblePosted;
}

export async function countUnclassifiedPostedTransactions({ supabase, businessId, taxYear } = {}) {
  const result = await listUnclassifiedPostedTransactions({ supabase, businessId, taxYear, limit: MAX_LIMIT, offset: 0 });
  return result.counts.unclassified;
}

export async function getPostedTransactionIdsForTax({ supabase, businessId, taxYear, dateFrom, dateTo } = {}) {
  const result = await listPostedTransactionsForTax({ supabase, businessId, taxYear, dateFrom, dateTo, limit: MAX_LIMIT, offset: 0 });
  return result.rows.map((row) => row.transactionId);
}

export async function getPostedTransactionSourceHealth({ supabase, businessId, taxYear } = {}) {
  const range = resolveDateRange({ taxYear });
  const bankRows = await fetchBankRows({ supabase, businessId, range, includeArchivedPending: true });
  const hydrated = await hydrateRows({ supabase, businessId, bankRows });
  const eligible = hydrated.filter((row) => row.isEligible);
  const unclassified = await listUnclassifiedPostedTransactions({ supabase, businessId, taxYear, limit: MAX_LIMIT, offset: 0 });
  return {
    eligiblePostedCount: eligible.length,
    unclassifiedCount: unclassified.counts.unclassified,
    pendingCount: hydrated.filter((row) => row.eligibilityReason === "pending_transaction").length,
    archivedCount: hydrated.filter((row) => row.eligibilityReason === "archived_transaction").length,
    approvedNotPostedCount: hydrated.filter((row) => row.eligibilityReason === "approved_not_posted").length,
    failedPostCount: hydrated.filter((row) => row.eligibilityReason === "failed_post").length,
    qboConflictCount: hydrated.filter((row) => row.sourceWarnings.includes("qbo_id_mismatch") || row.sourceWarnings.includes("conflicting_post_status")).length,
    missingQboAccountCount: eligible.filter((row) => row.sourceWarnings.includes("missing_qbo_account")).length,
    missingDirectionCount: eligible.filter((row) => row.sourceWarnings.includes("missing_direction")).length,
    warnings: collectListWarnings(eligible),
  };
}

async function fetchBankRows({ supabase, businessId, range, accountId, direction, includeArchivedPending = false }) {
  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
  let query = supabase
    .from("bank_transactions")
    .select(BANK_SELECT)
    .eq("business_id", businessId)
    .gte("date", range.dateFrom)
    .lte("date", range.dateTo)
    .order("date", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  query = applyActiveBookkeepingScope(query, bookkeepingStartDate);

  if (!includeArchivedPending) {
    query = query.eq("is_archived", false).eq("pending", false);
  }
  if (accountId) query = query.eq("plaid_account_id", accountId);
  if (direction) query = query.eq("direction", direction);

  const rows = [];
  for (let start = 0; ; start += BANK_PAGE_SIZE) {
    const pageQuery = typeof query.range === "function" ? query.range(start, start + BANK_PAGE_SIZE - 1) : query;
    const { data, error } = await pageQuery;
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < BANK_PAGE_SIZE || typeof query.range !== "function") break;
  }
  return rows;
}

async function hydrateRows({ supabase, businessId, bankRows }) {
  const ids = [...new Set(bankRows.map((row) => row.id).filter(Boolean).map(String))];
  const { catMap, qboMap } = await fetchRelatedRows({ supabase, businessId, transactionIds: ids });
  return bankRows.map((bankTransaction) => buildTaxRow({
    bankTransaction,
    categorization: catMap.get(String(bankTransaction.id)),
    qboPostedTransaction: qboMap.get(String(bankTransaction.id)),
    businessId,
  }));
}

async function fetchRelatedRows({ supabase, businessId, transactionIds }) {
  const catRows = [];
  const qboRows = [];
  const idChunks = chunks([...new Set((transactionIds || []).filter(Boolean).map(String))], CHUNK_SIZE);
  await mapWithConcurrency(idChunks, RELATED_ROW_CONCURRENCY, async (chunk, chunkIndex) => {
    const result = await fetchRelatedChunkWithRetry({ supabase, businessId, chunk, chunkIndex });
    catRows.push(...result.catRows);
    qboRows.push(...result.qboRows);
  });
  return {
    catMap: latestByTransaction(catRows),
    qboMap: latestByTransaction(qboRows),
  };
}

async function fetchRelatedChunkWithRetry({ supabase, businessId, chunk, chunkIndex }) {
  let lastError = null;
  for (let attempt = 0; attempt <= RELATED_ROW_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await fetchRelatedChunk({ supabase, businessId, chunk });
    } catch (err) {
      lastError = err;
      if (!isTransientReadError(err) || attempt >= RELATED_ROW_RETRY_ATTEMPTS) break;
      await delay(50 * 2 ** attempt);
    }
  }
  throw dataUnavailableError("Tax posted transaction related rows are temporarily unavailable.", {
    stage: "posted_transaction_hydration",
    chunkIndex,
    chunkSize: chunk.length,
    retryable: isTransientReadError(lastError),
    code: lastError?.code || lastError?.name || "unknown",
  });
}

async function fetchRelatedChunk({ supabase, businessId, chunk }) {
  const [catRes, qboRes] = await Promise.all([
    supabase.from("transaction_categorizations").select(CAT_SELECT).eq("business_id", businessId).in("transaction_id", chunk),
    supabase.from("qbo_posted_transactions").select(QBO_SELECT).eq("business_id", businessId).in("transaction_id", chunk),
  ]);
  if (catRes.error) throw catRes.error;
  if (qboRes.error) throw qboRes.error;
  const catRows = catRes.data || [];
  const qboRows = qboRes.data || [];
  assertRowsBelongToBusiness(catRows, businessId, "transaction_categorizations");
  assertRowsBelongToBusiness(qboRows, businessId, "qbo_posted_transactions");
  return { catRows, qboRows };
}

async function fetchClassifiedTransactionIds({ supabase, businessId, taxYear, transactionIds }) {
  const out = new Set();
  for (const chunk of chunks([...new Set((transactionIds || []).filter(Boolean).map(String))], CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("transaction_tax_classifications")
      .select("transaction_id")
      .eq("business_id", businessId)
      .eq("tax_year", taxYear)
      .in("transaction_id", chunk);
    if (error) throw error;
    for (const row of data || []) out.add(String(row.transaction_id));
  }
  return out;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async (_, workerIndex) => {
    for (let index = workerIndex; index < items.length; index += concurrency) {
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

function assertRowsBelongToBusiness(rows, businessId, table) {
  const invalid = rows.find((row) => row?.business_id && String(row.business_id) !== String(businessId));
  if (invalid) {
    throw validationError("cross_business_tax_row", "Tax posted transaction hydration returned a row for another business.", { table });
  }
}

function isTransientReadError(error) {
  const text = `${error?.name || ""} ${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  if (["42501", "42703", "42p01", "23503", "23505"].includes(String(error?.code || "").toLowerCase())) return false;
  return text.includes("fetch failed") ||
    text.includes("network") ||
    text.includes("timeout") ||
    text.includes("temporarily") ||
    /^5\d\d$/.test(String(error?.status || ""));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTaxRow({ bankTransaction, categorization, qboPostedTransaction, businessId }) {
  const normalized = normalizePostedTransactionForTax({ bankTransaction, categorization, qboPostedTransaction });
  const eligibilityReason = getTaxEligibilityReason({ bankTransaction, categorization, qboPostedTransaction, businessId });
  return {
    ...normalized,
    isEligible: eligibilityReason === "eligible_posted",
    eligibilityReason,
    taxTransactionStatus: eligibilityReason === "eligible_posted" ? "eligible_posted" : "excluded",
  };
}

function latestByTransaction(rows = []) {
  const sorted = [...rows].sort((a, b) =>
    Date.parse(b.posted_at || b.decided_at || b.created_at || 0) - Date.parse(a.posted_at || a.decided_at || a.created_at || 0)
  );
  const map = new Map();
  for (const row of sorted) {
    const key = String(row.transaction_id);
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

function resolveDateRange({ taxYear, dateFrom, dateTo }) {
  if (dateFrom || dateTo) {
    return {
      dateFrom: dateFrom || "2000-01-01",
      dateTo: dateTo || "2100-12-31",
    };
  }
  const year = requireTaxYear(taxYear);
  return { dateFrom: `${year}-01-01`, dateTo: `${year}-12-31` };
}

function requireTaxYear(value) {
  const year = normalizeTaxYear(value ?? new Date().getFullYear());
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  return year;
}

function normalizePagination({ limit, offset }) {
  const l = Number(limit ?? DEFAULT_LIMIT);
  const o = Number(offset ?? 0);
  if (!Number.isInteger(l) || l < 1 || l > MAX_LIMIT) throw validationError("invalid_limit", "limit must be an integer from 1 to 250.");
  if (!Number.isInteger(o) || o < 0) throw validationError("invalid_offset", "offset must be a non-negative integer.");
  return { limit: l, offset: o };
}

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function matchesTaxSearch(row, search) {
  if (!search) return true;
  const needle = String(search).trim().toLowerCase();
  if (!needle) return true;
  return [row.merchantName, row.counterpartyName, row.description, row.originalName, row.qboAccountName]
    .some((value) => String(value || "").toLowerCase().includes(needle));
}

function collectListWarnings(rows = []) {
  const counts = {};
  for (const row of rows) {
    for (const warning of row.sourceWarnings || []) counts[warning] = (counts[warning] || 0) + 1;
  }
  return Object.entries(counts).map(([code, count]) => ({ code, count }));
}

function compareTaxRows(a, b) {
  return (
    String(b.transactionDate || "").localeCompare(String(a.transactionDate || "")) ||
    String(b.rawRefs?.bankTransactionId || "").localeCompare(String(a.rawRefs?.bankTransactionId || ""))
  );
}
