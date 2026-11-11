import { boundedIdChunks, boundedTaxQuery } from "./boundedPostgrestIds.js";
import { taxSourceRead } from "./taxSourceReadScope.js";
// /src/services/tax/taxPostedTransaction.repository.js
import { normalizeTaxYear } from "./taxDomain.js";
import { dataUnavailableError, notFoundError, validationError } from "./taxErrors.js";
import { TAX_CLASSIFICATION_ENGINE_VERSION } from "./taxEngineVersions.js";
import { hasCompletedClassificationEvaluation, hasMeaningfulClassificationOutcome, isUnresolvedFallbackClassification } from "./taxClassification.repository.js";
import { getTaxEligibilityReason } from "./taxTransactionEligibility.js";
import { normalizePostedTransactionForTax } from "./taxTransactionNormalizer.js";
import { deriveTaxReconciliationScope } from "./taxReconciliationBridge.js";
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

const QBO_ACCOUNT_CACHE_SELECT = [
  // qbo_accounts_cache is the canonical chart-of-accounts cache.  Its durable
  // column names are deliberately different from the denormalized
  // transaction_categorizations names (name/account_type/account_subtype).
  // Selecting the latter caused PostgREST to reject the projection; the
  // compatibility fallback below then returned an empty map for every row.
  "business_id", "qbo_env", "realm_id", "qbo_account_id", "name", "account_type", "account_subtype", "active",
].join(",");

const BANK_INDEX_SELECT = "id,business_id,date,amount,signed_amount,direction,merchant_entity_id,pending,is_archived,archived_at,duplicate_fingerprint,created_at";
const CLASSIFICATION_META_KEYS = ["tax_classification_stale", "classification_engine_version", "transaction_source_fingerprint", "neutralized_at", "superseded_at", "fallback", "tax_treatment_type", "is_holding", "tax_review_holding", "source_qbo_account_name", "source_qbo_account_id", "source_qbo_account_type", "source_qbo_account_subtype", "bookkeeping_category", "normalized_qbo_account_name", "normalized_qbo_account_type", "normalized_qbo_account_subtype", "taxonomy_type", "source_qbo_txn_type"];
const CLASSIFICATION_INDEX_SELECT = ["transaction_id", "business_id", "tax_year", "classification_status", "tax_category", "deductibility_status", "deductible_percent", "book_amount", "deductible_amount", "nondeductible_amount", "capitalizable_amount", "source", "rule_id", "rule_code", "transaction_date", "source_qbo_account_id", "source_qbo_account_name", "source_qbo_txn_type", "created_at", "updated_at", "tax_treatment_kind:tax_treatment->>type",
  ...CLASSIFICATION_META_KEYS.map((key) => `meta_${key}:metadata->${key}`)].join(",");

export function listTaxClassificationFreshnessIndex({ supabase, businessId, taxYear }) {
  return taxSourceRead(supabase, `classification-index:${businessId}:${taxYear}`, async () => {
    const rows = [];
    let after = null;
    for (;;) {
      let query = supabase.from("transaction_tax_classifications").select(CLASSIFICATION_INDEX_SELECT)
        .eq("business_id", businessId).eq("tax_year", taxYear).order("transaction_id", { ascending: true });
      if (after) query = query.gt("transaction_id", after);
      query = query.limit(500);
      const { data, error } = await boundedTaxQuery(query);
      if (error) throw error;
      const page = data || [];
      assertRowsBelongToBusiness(page, businessId, "transaction_tax_classifications");
      rows.push(...page.map((row) => ({ ...row, tax_treatment: row.tax_treatment || { type: row.tax_treatment_kind }, metadata: row.metadata || Object.fromEntries(CLASSIFICATION_META_KEYS.map((key) => [key, row[`meta_${key}`]])) })));
      if (!page.length) break;
      const next = String(page.at(-1).transaction_id);
      if (next === after) throw new Error("classification_index_cursor_did_not_advance");
      after = next;
    }
    return rows;
  });
}

const BANK_SCAN_SELECT = BANK_SELECT.split(",").filter((key) => !["raw", "location", "counterparties"].includes(key)).join(",");
const QBO_SCAN_SELECT = QBO_SELECT.split(",").filter((key) => !["payload", "response"].includes(key)).concat([
  "payload_account_ref:payload->AccountRef", "payload_purchase_account_ref:payload->Purchase->AccountRef",
  "response_account_ref:response->AccountRef", "response_purchase_account_ref:response->Purchase->AccountRef",
]).join(",");

export async function getPostedTransactionsForTaxByIds({ supabase, businessId, transactionIds }) {
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const ids = [...new Set(transactionIds.map(String))];
  const start = await taxSourceRead(supabase, `scope:${businessId}`, () => getBookkeepingStartDate(supabase, businessId));
  const bankRows = [];
  for (const chunk of chunks(ids, CHUNK_SIZE)) {
    const { data, error } = await boundedTaxQuery(supabase.from("bank_transactions").select(BANK_INDEX_SELECT).eq("business_id", businessId).in("id", chunk));
    if (error) throw error;
    assertRowsBelongToBusiness(data || [], businessId, "bank_transactions");
    bankRows.push(...(data || []));
  }
  const catRows = [], qboRows = [];
  for (const chunk of chunks(ids, CHUNK_SIZE)) {
    const [cat, receipt] = await Promise.all([
      boundedTaxQuery(supabase.from("transaction_categorizations").select("transaction_id,business_id,status,qbo_txn_id,post_error,posted_at,decided_at").eq("business_id", businessId).in("transaction_id", chunk)),
      boundedTaxQuery(supabase.from("qbo_posted_transactions").select("transaction_id,business_id,status,qbo_txn_id,posted_at").eq("business_id", businessId).in("transaction_id", chunk)),
    ]);
    if (cat.error) throw cat.error;
    if (receipt.error) throw receipt.error;
    assertRowsBelongToBusiness(cat.data || [], businessId, "transaction_categorizations");
    assertRowsBelongToBusiness(receipt.data || [], businessId, "qbo_posted_transactions");
    catRows.push(...(cat.data || [])); qboRows.push(...(receipt.data || []));
  }
  const cats = latestByTransaction(catRows), receipts = latestByTransaction(qboRows);
  return new Map(bankRows.map((bank) => {
    const reason = getTaxEligibilityReason({ bankTransaction: bank, categorization: cats.get(String(bank.id)), qboPostedTransaction: receipts.get(String(bank.id)), businessId });
    const inScope = isTransactionInActiveBookkeepingScope(bank, start);
    return [String(bank.id), { isEligible: reason === "eligible_posted" && inScope, eligibilityReason: inScope ? reason : "transaction_before_bookkeeping_start_date" }];
  }));
}

export async function getPostedTransactionForTax({ supabase, businessId, transactionId } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  if (!transactionId) throw validationError("missing_transaction_id", "transactionId is required.");

  const bookkeepingStartDate = await taxSourceRead(supabase, `scope:${businessId}`, () => getBookkeepingStartDate(supabase, businessId));
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
    qboAccount: related.accountMap.get(String(transactionId)),
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
  const population = await scanTaxListPopulation({ supabase, businessId, bankRows });
  let rows = population.filter((row) => row.isEligible).filter((row) => matchesTaxSearch(row, search)).sort(compareTaxRows);
  if (qboAccountId) rows = rows.filter((row) => row.qboAccountId === qboAccountId);
  if (!includeSourceWarnings) rows = rows.map((row) => ({ ...row, sourceWarnings: [] }));

  const count = rows.length;
  const pageIds = new Set(rows.slice(page.offset, page.offset + page.limit).map((row) => String(row.transactionId)));
  const paged = (await hydrateRows({ supabase, businessId, bankRows: bankRows.filter((row) => pageIds.has(String(row.id))) })).sort(compareTaxRows);
  return {
    rows: includeSourceWarnings ? paged : paged.map((row) => ({ ...row, sourceWarnings: [] })),
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

// The Tax/Reconciliations bridge needs the same active, tenant-scoped source
// rows before Tax eligibility filters are applied. This read-only reader is
// deliberately separate from the customer list API so an identity mismatch is
// visible instead of being hidden by an equal aggregate count.
export async function listTaxPostingSourceRows({
  supabase,
  businessId,
  taxYear,
  dateFrom,
  dateTo,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const range = resolveDateRange({ taxYear, dateFrom, dateTo });
  const bankRows = await fetchBankRows({ supabase, businessId, range });
  const rows = await hydrateRows({ supabase, businessId, bankRows });
  return rows.sort(compareTaxRows);
}

// Bounded, tenant/year-scoped hydration for an already-authoritative population.
// Callers must still reconcile the returned identities before exposing data.
export async function listTaxPostingSourceRowsByIds({ supabase, businessId, taxYear, transactionIds } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const range = resolveDateRange({ taxYear });
  const ids = (transactionIds || []).map(String);
  const uniqueIds = [...new Set(ids)];
  if (!ids.length || uniqueIds.length !== ids.length) {
    throw dataUnavailableError("The Tax question transaction population is unavailable.", { reason: "invalid_question_membership" });
  }
  const bookkeepingStartDate = await taxSourceRead(supabase, `scope:${businessId}`, () => getBookkeepingStartDate(supabase, businessId));
  const bankRows = [];
  for (const chunk of chunks(uniqueIds, CHUNK_SIZE)) {
    let query = boundedTaxQuery(supabase.from("bank_transactions").select(BANK_SELECT)
      .eq("business_id", businessId)
      .gte("date", range.dateFrom)
      .lte("date", range.dateTo)
      .eq("is_archived", false)
      .eq("pending", false)
      .in("id", chunk));
    query = applyActiveBookkeepingScope(query, bookkeepingStartDate);
    const { data, error } = await boundedTaxQuery(query);
    if (error) throw error;
    bankRows.push(...(data || []));
  }
  const returnedIds = bankRows.map((row) => String(row.id));
  if (new Set(returnedIds).size !== uniqueIds.length || returnedIds.some((id) => !uniqueIds.includes(id))) {
    throw dataUnavailableError("The Tax question transaction population is unavailable.", { reason: "question_source_population_mismatch" });
  }
  const rows = (await hydrateRows({ supabase, businessId, bankRows })).filter((row) => row.isEligible);
  if (rows.length !== uniqueIds.length || rows.some((row) => !uniqueIds.includes(String(row.transactionId)))) {
    throw dataUnavailableError("The Tax question transaction population is unavailable.", { reason: "question_hydration_incomplete" });
  }
  return rows.sort(compareTaxRows);
}

// Grouped-question membership and tax treatment are already fixed by the
// current immutable projection/classifications.  The modal only needs the
// current bank-source display facts, so do not re-run the much broader posted
// transaction hydration (categorization, QBO post, and account-cache reads)
// for every preview.  Classification amount/account equality is checked by
// the caller before anything is exposed.
export async function listTaxQuestionBankRowsByIds({ supabase, businessId, taxYear, transactionIds } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const range = resolveDateRange({ taxYear });
  const ids = (transactionIds || []).map(String);
  const uniqueIds = [...new Set(ids)];
  if (!ids.length || uniqueIds.length !== ids.length) {
    throw dataUnavailableError("The Tax question transaction population is unavailable.", { reason: "invalid_question_membership" });
  }
  const bookkeepingStartDate = await taxSourceRead(supabase, `scope:${businessId}`, () => getBookkeepingStartDate(supabase, businessId));
  const rows = [];
  for (const chunk of chunks(uniqueIds, CHUNK_SIZE)) {
    let query = boundedTaxQuery(supabase.from("bank_transactions").select(BANK_SELECT)
      .eq("business_id", businessId)
      .gte("date", range.dateFrom)
      .lte("date", range.dateTo)
      .eq("is_archived", false)
      .eq("pending", false)
      .in("id", chunk));
    query = applyActiveBookkeepingScope(query, bookkeepingStartDate);
    const { data, error } = await boundedTaxQuery(query);
    if (error) throw error;
    rows.push(...(data || []));
  }
  const returnedIds = rows.map((row) => String(row.id));
  if (rows.length !== uniqueIds.length || new Set(returnedIds).size !== uniqueIds.length || returnedIds.some((id) => !uniqueIds.includes(id))) {
    throw dataUnavailableError("The Tax question transaction population is unavailable.", { reason: "question_source_population_mismatch" });
  }
  return rows.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || String(a.id).localeCompare(String(b.id)));
}

export async function listUnclassifiedPostedTransactions({ supabase, businessId, taxYear, limit = DEFAULT_LIMIT, offset = 0, cursor } = {}) {
  const year = requireTaxYear(taxYear);
  const snapshot = await getTaxClassificationSourceSnapshot({ supabase, businessId, taxYear: year });
  const unclassified = snapshot.rows;
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
    counts: {
      eligiblePosted: snapshot.eligiblePostedCount,
      classified: snapshot.classifiedCount,
      unclassified: snapshot.unclassifiedCount,
    },
    warnings: collectListWarnings(paged),
  };
}

async function listAllEligiblePostedRows({ supabase, businessId, taxYear }) {
  const bankRows = await fetchBankRows({ supabase, businessId, range: resolveDateRange({ taxYear }) });
  return (await hydrateRows({ supabase, businessId, bankRows })).filter((row) => row.isEligible).sort(compareTaxRows);
}

export function getTaxClassificationSourceSnapshot(options = {}) {
  return taxSourceRead(options.supabase, `snapshot:${options.businessId}:${options.taxYear}`, () => readTaxClassificationSourceSnapshot(options));
}
async function readTaxClassificationSourceSnapshot({ supabase, businessId, taxYear } = {}) {
  const year = requireTaxYear(taxYear);
  const classifications = await listTaxClassificationFreshnessIndex({ supabase, businessId, taxYear: year });
  const indexBankRows = await fetchBankRows({ supabase, businessId, range: resolveDateRange({ taxYear: year }), indexOnly: true });
  const postedRows = (await scanTaxListPopulation({ supabase, businessId, bankRows: indexBankRows, indexOnly: true })).filter((row) => row.isEligible).sort(compareTaxRows);
  const fingerprintedRows = postedRows.map((row) => ({
    ...row,
    sourceFingerprint: computeTaxTransactionFingerprint(row),
  }));
  const classificationMap = new Map(classifications.map((row) => [String(row.transaction_id), row]));
  const unclassified = fingerprintedRows.filter((row) => {
    const classification = classificationMap.get(String(row.transactionId));
    return !classification || isMachineClassificationStaleForSource(classification, row);
  });
  const currentClassifications = fingerprintedRows
    .map((row) => classificationMap.get(String(row.transactionId)))
    .filter((row) => row && hasCompletedClassificationEvaluation(row));
  const meaningfulClassifications = currentClassifications.filter(hasMeaningfulClassificationOutcome);
  const unresolvedFallbackCount = currentClassifications.filter(isUnresolvedFallbackClassification).length;
  const dueIds = unclassified.map((row) => String(row.transactionId));
  const dueBankRows = [];
  for (const ids of chunks(dueIds, CHUNK_SIZE)) {
    const { data, error } = await boundedTaxQuery(supabase.from("bank_transactions").select(BANK_SCAN_SELECT).eq("business_id", businessId).in("id", ids));
    if (error) throw error;
    assertRowsBelongToBusiness(data || [], businessId, "bank_transactions");
    dueBankRows.push(...(data || []));
  }
  const detailedRows = await hydrateRows({ supabase, businessId, bankRows: dueBankRows });
  return {
    rows: detailedRows.filter((row) => row.isEligible).sort(compareTaxRows).map((row) => ({ ...row, sourceFingerprint: computeTaxTransactionFingerprint(row) })),
    transactionIds: unclassified.map((row) => String(row.transactionId)).filter(Boolean),
    eligiblePostedCount: fingerprintedRows.length,
    classifiedCount: meaningfulClassifications.length,
    evaluatedCount: currentClassifications.length,
    unresolvedCount: unresolvedFallbackCount,
    candidateCount: unclassified.length,
    unclassifiedCount: unclassified.length + unresolvedFallbackCount,
  };
}

export async function countPostedTransactionsForTax({ supabase, businessId, taxYear } = {}) {
  const result = await listPostedTransactionsForTax({ supabase, businessId, taxYear, limit: MAX_LIMIT, offset: 0 });
  return result.counts.eligiblePosted;
}

export async function countUnclassifiedPostedTransactions({ supabase, businessId, taxYear } = {}) {
  const result = await listUnclassifiedPostedTransactions({ supabase, businessId, taxYear, limit: MAX_LIMIT, offset: 0 });
  return result.counts.unclassified;
}

export async function countReviewRequiredTaxClassifications({ supabase, businessId, taxYear } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const year = requireTaxYear(taxYear);
  const postedRows = await listAllEligiblePostedRows({ supabase, businessId, taxYear: year });
  const transactionIds = postedRows.map((row) => row.transactionId).filter(Boolean);
  const reviewRequiredIds = new Set();
  for (const chunk of chunks([...new Set(transactionIds.map(String))], CHUNK_SIZE)) {
    const { data, error } = await boundedTaxQuery(supabase
      .from("transaction_tax_classifications")
      .select("transaction_id")
      .eq("business_id", businessId)
      .eq("tax_year", year)
      .eq("requires_review", true)
      .in("transaction_id", chunk));
    if (error) throw error;
    for (const row of data || []) reviewRequiredIds.add(String(row.transaction_id));
  }
  return reviewRequiredIds.size;
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

function fetchBankRows(options) {
  const { supabase, ...key } = options;
  return taxSourceRead(supabase, `bank:${JSON.stringify(key)}`, () => fetchBankRowsUncached(options));
}
async function fetchBankRowsUncached({ supabase, businessId, range, accountId, direction, includeArchivedPending = false, indexOnly = false }) {
  const bookkeepingStartDate = await taxSourceRead(supabase, `scope:${businessId}`, () => getBookkeepingStartDate(supabase, businessId));
  let query = supabase
    .from("bank_transactions")
    .select(indexOnly ? BANK_INDEX_SELECT : BANK_SCAN_SELECT)
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
    const { data, error } = await boundedTaxQuery(pageQuery);
    if (error) throw error;
    assertRowsBelongToBusiness(data || [], businessId, "bank_transactions");
    rows.push(...(data || []));
    if (!data || data.length < BANK_PAGE_SIZE || typeof query.range !== "function") break;
  }
  return rows;
}

async function scanTaxListPopulation({ supabase, businessId, bankRows, indexOnly = false }) {
  const cats = [], receipts = [];
  const projection = "transaction_id,business_id,status,qbo_txn_id,qbo_txn_type,post_error,posted_at,decided_at,txn_name,final_qbo_account_id,final_qbo_account_name,suggested_qbo_account_id,suggested_qbo_account_name,taxonomy_type:meta->>taxonomy_type";
  for (const ids of chunks(bankRows.map((row) => row.id), CHUNK_SIZE)) {
    const [cat, qbo] = await Promise.all([
      boundedTaxQuery(supabase.from("transaction_categorizations").select(projection).eq("business_id", businessId).in("transaction_id", ids)),
      boundedTaxQuery(supabase.from("qbo_posted_transactions").select(QBO_SCAN_SELECT).eq("business_id", businessId).in("transaction_id", ids)),
    ]);
    if (cat.error) throw cat.error;
    if (qbo.error) throw qbo.error;
    assertRowsBelongToBusiness(cat.data || [], businessId, "transaction_categorizations");
    assertRowsBelongToBusiness(qbo.data || [], businessId, "qbo_posted_transactions");
    cats.push(...(cat.data || []).map((row) => ({ ...row, meta: row.meta || { taxonomy_type: row.taxonomy_type } }))); receipts.push(...(qbo.data || []).map(receiptAccountRefs));
  }
  const catMap = latestByTransaction(cats), qboMap = latestByTransaction(receipts);
  const accounts = await fetchQboAccountMap({ supabase, businessId, catRows: cats, qboRows: receipts, indexOnly });
  return bankRows.map((bank) => buildTaxRow({ bankTransaction: bank, categorization: catMap.get(String(bank.id)), qboPostedTransaction: qboMap.get(String(bank.id)), qboAccount: accounts.get(String(bank.id)), businessId }));
}

function receiptAccountRefs(row) {
  return { ...row,
    payload: row.payload || { AccountRef: row.payload_account_ref, Purchase: { AccountRef: row.payload_purchase_account_ref } },
    response: row.response || { AccountRef: row.response_account_ref, Purchase: { AccountRef: row.response_purchase_account_ref } },
  };
}

async function hydrateRows({ supabase, businessId, bankRows }) {
  const ids = [...new Set(bankRows.map((row) => row.id).filter(Boolean).map(String))];
  const { catMap, qboMap, accountMap } = await fetchRelatedRows({ supabase, businessId, transactionIds: ids });
  return bankRows.map((bankTransaction) => buildTaxRow({
    bankTransaction,
    categorization: catMap.get(String(bankTransaction.id)),
    qboPostedTransaction: qboMap.get(String(bankTransaction.id)),
    qboAccount: accountMap.get(String(bankTransaction.id)),
    businessId,
  }));
}

function fetchRelatedRows(options) {
  const { supabase, businessId, transactionIds } = options;
  return taxSourceRead(supabase, `related:${businessId}:${JSON.stringify([...transactionIds].sort())}`, () => fetchRelatedRowsUncached(options));
}
async function fetchRelatedRowsUncached({ supabase, businessId, transactionIds }) {
  const catRows = [];
  const qboRows = [];
  const idChunks = chunks([...new Set((transactionIds || []).filter(Boolean).map(String))], CHUNK_SIZE);
  await mapWithConcurrency(idChunks, RELATED_ROW_CONCURRENCY, async (chunk, chunkIndex) => {
    const result = await fetchRelatedChunkWithRetry({ supabase, businessId, chunk, chunkIndex });
    catRows.push(...result.catRows);
    qboRows.push(...result.qboRows);
  });
  const accountMap = await fetchQboAccountMap({ supabase, businessId, catRows, qboRows });
  return {
    catMap: latestByTransaction(catRows),
    qboMap: latestByTransaction(qboRows),
    accountMap,
  };
}

function fetchRelatedChunkWithRetry(options) {
  return taxSourceRead(options.supabase, `related-chunk:${options.businessId}:${JSON.stringify(options.chunk)}`, () => readRelatedChunkWithRetry(options));
}
async function readRelatedChunkWithRetry({ supabase, businessId, chunk, chunkIndex }) {
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
    boundedTaxQuery(supabase.from("transaction_categorizations").select(CAT_SELECT).eq("business_id", businessId).in("transaction_id", chunk)),
    boundedTaxQuery(supabase.from("qbo_posted_transactions").select(QBO_SCAN_SELECT).eq("business_id", businessId).in("transaction_id", chunk)),
  ]);
  if (catRes.error) throw catRes.error;
  if (qboRes.error) throw qboRes.error;
  const catRows = catRes.data || [];
  const qboRows = (qboRes.data || []).map(receiptAccountRefs);
  assertRowsBelongToBusiness(catRows, businessId, "transaction_categorizations");
  assertRowsBelongToBusiness(qboRows, businessId, "qbo_posted_transactions");
  return { catRows, qboRows };
}

async function fetchQboAccountMap({ supabase, businessId, catRows = [], qboRows = [], indexOnly = false }) {
  const accountIds = [...new Set(catRows
    .map((row) => row.final_qbo_account_id || row.suggested_qbo_account_id)
    .filter(Boolean)
    .map(String))];
  if (!accountIds.length) return new Map();
  const rows = [];
  for (const chunk of chunks(accountIds, CHUNK_SIZE)) {
    const { data, error } = await taxSourceRead(supabase, `accounts:${businessId}:${indexOnly}:${JSON.stringify([...chunk].sort())}`, () => boundedTaxQuery(supabase
      .from("qbo_accounts_cache").select(indexOnly ? "business_id,qbo_env,realm_id,qbo_account_id,name" : QBO_ACCOUNT_CACHE_SELECT).eq("business_id", businessId).in("qbo_account_id", chunk)));
    if (error) {
      // A missing optional cache is compatible with older isolated test
      // fixtures. A missing *column* is not: treating it as an empty cache
      // turns every otherwise-valid posted row into incomplete QBO evidence.
      // Surface that contract problem instead of silently zeroing deductions.
      if (String(error.code || "").toUpperCase() === "42P01") return new Map();
      throw error;
    }
    rows.push(...(data || []));
  }
  assertRowsBelongToBusiness(rows, businessId, "qbo_accounts_cache");
  const accountKey = (row) => JSON.stringify([row.business_id, row.qbo_env || null, row.realm_id || null, String(row.qbo_account_id)]);
  const byIdentity = new Map(rows.map((row) => [accountKey(row), row]));
  const qboByTxn = latestByTransaction(qboRows);
  const out = new Map();
  for (const cat of catRows) {
    const accountId = cat.final_qbo_account_id || cat.suggested_qbo_account_id;
    const qbo = qboByTxn.get(String(cat.transaction_id));
    let account = byIdentity.get(accountKey({ business_id: businessId, qbo_env: qbo?.qbo_env, realm_id: qbo?.realm_id, qbo_account_id: accountId }));
    if (!account) {
      const compatible = rows.filter((row) => String(row.qbo_account_id) === String(accountId) &&
        (!qbo?.realm_id || !row.realm_id || String(qbo.realm_id) === String(row.realm_id)) &&
        (!qbo?.qbo_env || !row.qbo_env || String(qbo.qbo_env) === String(row.qbo_env)));
      if (compatible.length === 1) account = compatible[0];
    }
    if (!account) continue;
    if (qbo?.realm_id && account.realm_id && String(qbo.realm_id) !== String(account.realm_id)) continue;
    if (qbo?.qbo_env && account.qbo_env && String(qbo.qbo_env) !== String(account.qbo_env)) continue;
    out.set(String(cat.transaction_id), account);
  }
  return out;
}


function isMachineClassificationStaleForSource(classification, transaction) {
  if (!hasCompletedClassificationEvaluation(classification)) return true;
  const status = String(classification?.classification_status || "").toLowerCase();
  if (["user_confirmed", "cpa_confirmed"].includes(status)) return false;
  const metadata = classification?.metadata || {};
  if (metadata.tax_classification_stale === true) return true;
  if (metadata.neutralized_at || metadata.superseded_at) return false;
  if (metadata.classification_engine_version && metadata.classification_engine_version !== TAX_CLASSIFICATION_ENGINE_VERSION) return true;
  const priorFingerprint = metadata.transaction_source_fingerprint || null;
  return Boolean(priorFingerprint && transaction?.sourceFingerprint && priorFingerprint !== transaction.sourceFingerprint);
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

function buildTaxRow({ bankTransaction, categorization, qboPostedTransaction, qboAccount, businessId }) {
  const normalized = normalizePostedTransactionForTax({ bankTransaction, categorization, qboPostedTransaction, qboAccount });
  const eligibilityReason = getTaxEligibilityReason({ bankTransaction, categorization, qboPostedTransaction, businessId });
  const row = {
    ...normalized,
    isEligible: eligibilityReason === "eligible_posted",
    eligibilityReason,
    taxTransactionStatus: eligibilityReason === "eligible_posted" ? "eligible_posted" : "excluded",
  };
  const taxScope = row.isEligible ? deriveTaxReconciliationScope(row) : null;
  return {
    ...row,
    taxScopeDisposition: taxScope?.disposition || null,
    taxScopeReasonCode: taxScope?.reasonCode || null,
  };
}

export function computeTaxTransactionFingerprint(row = {}) {
  return JSON.stringify({
    transactionId: row.transactionId || row.transaction_id || null,
    date: row.transactionDate || row.transaction_date || row.date || null,
    signedAmount: Number(row.signedAmount ?? row.signed_amount ?? row.amount ?? 0),
    direction: row.direction || null,
    qboTxnId: row.qboTxnId || row.qbo_txn_id || null,
    qboTxnType: row.qboTxnType || row.qbo_txn_type || null,
    qboAccountId: row.qboAccountId || row.qbo_account_id || null,
    qboAccountName: row.qboAccountName || row.qbo_account_name || row.bookkeepingCategory || null,
    bookkeepingCategory: row.bookkeepingCategory || row.bookkeeping_category || null,
    taxonomyType: row.taxonomyType || row.taxonomy_type || null,
    merchantEntityId: row.merchantEntityId || row.merchant_entity_id || null,
  });
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

function chunks(values, size) { return boundedIdChunks(values, size); }

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
