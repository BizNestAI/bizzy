import { randomUUID } from "node:crypto";
import { PACKAGE_SCHEMA_VERSION, EvidenceUnavailableError } from "./exactRangePnlEvidence.js";

export const TAX_BOOKKEEPING_FORMULA_VERSION = "tax-bookkeeping-evidence-v2";
const MAX_REFERENCES = 25;
const MAX_ACTIONABLE_EXAMPLES = 10;
const TAX_PAGE_SIZE = 500;
const TRANSACTION_LOOKUP_CHUNK_SIZE = 100;

export async function buildTaxTransactionsNeedingReviewPackage({ db, businessId, taxYear, loaders = {}, persist = persistPackage }) {
  if (!businessId) throw new EvidenceUnavailableError("business_id_required");
  const loadBookkeeping = loaders.bookkeeping || loadBookkeepingReview;
  const loadTax = loaders.tax || loadTaxReview;
  const [bookkeeping, tax] = await Promise.all([loadBookkeeping({ db, businessId }), loadTax({ db, businessId, taxYear })]);
  const categoryTotal = sumCategoryCounts(tax.by_category);
  if (categoryTotal !== tax.count) throw new EvidenceUnavailableError("tax_review_category_reconciliation_failed");
  const taxIds = new Set(tax.transaction_ids || tax.references?.map((row) => row.transaction_id).filter(Boolean) || []);
  const bookkeepingIds = new Set(bookkeeping.transaction_ids || bookkeeping.references?.map((row) => row.transaction_id).filter(Boolean) || []);
  const overlapCount = [...taxIds].filter((id) => bookkeepingIds.has(id)).length;
  const combinedDistinctCount = taxIds.size === tax.count && bookkeepingIds.size === bookkeeping.count
    ? new Set([...taxIds, ...bookkeepingIds]).size
    : tax.count + bookkeeping.count - overlapCount;
  const references = dedupeReferences([...(tax.references || []), ...(bookkeeping.references || [])]).slice(0, MAX_REFERENCES);
  const packageRow = basePackage({ businessId, intent: "tax_transactions_needing_review", metrics: {
    counts: {
      tax_classifications_needing_review: tax.count,
      needs_review_bookkeeping: bookkeeping.count,
      combined_distinct_needing_review: combinedDistinctCount,
      tax_bookkeeping_overlap: overlapCount,
      unresolved_owner_or_personal: tax.by_category.owner_or_personal || 0,
      meals_or_travel_review: tax.by_category.meals_or_travel || 0,
      capital_asset_review: tax.by_category.capital_asset || 0,
      other_tax_classification_blockers: tax.by_category.other || 0,
    },
    tax_category_breakdown: { ...tax.by_category },
    reconciliation: {
      breakdown_scope: "complete_eligible_tax_population",
      tax_distinct_count: tax.count,
      tax_category_total: categoryTotal,
      categories_reconciled: categoryTotal === tax.count,
      bookkeeping_distinct_count: bookkeeping.count,
      tax_bookkeeping_overlap: overlapCount,
      combined_distinct_count: combinedDistinctCount,
      duplicates_detected: tax.duplicates_detected || 0,
      excluded_tax_records: tax.excluded || { pending: 0, archived: 0, missing_transaction: 0 },
    },
    actionable_examples: (tax.examples || []).slice(0, MAX_ACTIONABLE_EXAMPLES),
    bounded_references: references,
    reference_limit: MAX_REFERENCES,
  }, warnings: ["This identifies recorded bookkeeping and tax-classification review items; it does not identify missing deductions."] });
  return persist({ db, packageRow });
}

export async function buildTaxProfessionalReadinessPackage({ db, businessId, taxYear, loaders = {}, persist = persistPackage }) {
  if (!businessId) throw new EvidenceUnavailableError("business_id_required");
  const load = loaders.readiness || loadReadinessSignals;
  const signals = await load({ db, businessId, taxYear });
  const requiredKeys = ["needs_review", "pending", "reconciliation", "connections", "posting", "categorization", "pnl", "tax_review"];
  const unavailableSources = requiredKeys.filter((key) => signals[key]?.available !== true);
  const requiredAvailable = unavailableSources.length === 0;
  const hasBlockers = requiredKeys.some((key) => Number(signals[key]?.blocker_count || 0) > 0);
  const status = !requiredAvailable
    ? "readiness_unavailable"
    : hasBlockers ? "bookkeeping_attention_required" : "no_known_bookkeeping_blockers";
  const statement = status === "readiness_unavailable"
    ? "Readiness could not be determined because required evidence is unavailable"
    : status === "bookkeeping_attention_required" ? "Bookkeeping items still need attention" : "No known bookkeeping blockers were found";
  const packageRow = basePackage({
    businessId, intent: "tax_professional_readiness", completeness: requiredAvailable ? "complete" : "unavailable",
    metrics: {
      status,
      statement,
      has_blockers: hasBlockers,
      unavailable_sources: unavailableSources,
      unavailable_reason: unavailableSources.length === 1
        ? signals[unavailableSources[0]]?.unavailable_reason || `${unavailableSources[0]}_evidence_unavailable`
        : unavailableSources.length > 1 ? "readiness_sources_unavailable" : null,
      // These populations can overlap. Keep them separate instead of presenting
      // their sum as a distinct transaction count.
      blocker_populations: {
        tax_classification_review: Number(signals.tax_review?.blocker_count || 0),
        bookkeeping_review: Number(signals.needs_review?.blocker_count || 0),
        pending_or_accounting_review: Number(signals.pending?.blocker_count || 0),
        posting_errors: Number(signals.posting?.blocker_count || 0),
        bookkeeping_feed_review_or_pending: Number(signals.categorization?.blocker_count || 0),
      },
      readiness_dimensions: {
        bookkeeping_cleanup_outstanding: ["needs_review", "pending", "posting", "categorization"].some((key) => Number(signals[key]?.blocker_count || 0) > 0),
        tax_classification_questions_outstanding: Number(signals.tax_review?.blocker_count || 0) > 0,
        reconciliation: signals.reconciliation?.status || "unavailable",
        financial_evidence_available: signals.pnl?.available === true && Number(signals.pnl?.blocker_count || 0) === 0,
        connections_available: signals.connections?.available === true && Number(signals.connections?.blocker_count || 0) === 0,
      },
      checklist: signals,
    },
    warnings: ["This is bookkeeping readiness only—not tax-return readiness, filing readiness, or tax-law compliance."],
  });
  return persist({ db, packageRow });
}

async function loadBookkeepingReview({ db, businessId }) {
  const rows = [];
  let expectedCount = null;
  for (let from = 0; ; from += TAX_PAGE_SIZE) {
    const { data, error, count } = await db.from("bizzy_chat_bookkeeping_feed")
      .select("transaction_id,transaction_date,primary_feed,posting_outcome", { count: from === 0 ? "exact" : undefined })
      .eq("business_id", businessId).eq("primary_feed", "needs_review")
      .order("transaction_id", { ascending: true }).range(from, from + TAX_PAGE_SIZE - 1);
    if (error) throw error;
    if (from === 0 && count != null) expectedCount = Number(count);
    rows.push(...(data || []));
    if (!data?.length || data.length < TAX_PAGE_SIZE || (expectedCount != null && rows.length >= expectedCount)) break;
  }
  if (expectedCount != null && rows.length !== expectedCount) throw new EvidenceUnavailableError("bookkeeping_review_pagination_incomplete");
  const uniqueRows = uniqueRowsByTransaction(rows, "duplicate_bookkeeping_review_record");
  const recentRows = [...uniqueRows].sort((left, right) => String(right.transaction_date || "").localeCompare(String(left.transaction_date || "")));
  return {
    count: uniqueRows.length,
    transaction_ids: uniqueRows.map((row) => row.transaction_id),
    references: recentRows.slice(0, MAX_REFERENCES).map((row) => ({ transaction_id: row.transaction_id, date: row.transaction_date, signal: "bookkeeping_needs_review", status: row.posting_outcome || row.primary_feed })),
  };
}

export async function loadTaxReview({ db, businessId, taxYear, pageSize = TAX_PAGE_SIZE }) {
  const rows = await loadAllTaxReviewRows({ db, businessId, taxYear, pageSize });
  const rowsByTransaction = new Map();
  for (const row of rows) {
    if (!row.transaction_id) throw new EvidenceUnavailableError("tax_review_transaction_id_missing");
    if (row.classification_status !== "needs_review" || row.requires_review !== true) throw new EvidenceUnavailableError("inconsistent_tax_review_status");
    if (rowsByTransaction.has(row.transaction_id)) throw new EvidenceUnavailableError("duplicate_tax_review_classification");
    rowsByTransaction.set(row.transaction_id, row);
  }
  const transactionDetails = await loadTransactionDetails({ db, businessId, transactionIds: [...rowsByTransaction.keys()] });
  const detailById = new Map(transactionDetails.map((row) => [row.id, row]));
  const by_category = { owner_or_personal: 0, meals_or_travel: 0, capital_asset: 0, other: 0 };
  const eligible = [];
  const excluded = { pending: 0, archived: 0, missing_transaction: 0 };
  for (const row of rows) {
    const transaction = detailById.get(row.transaction_id);
    if (!transaction) { excluded.missing_transaction += 1; continue; }
    if (transaction.pending === true) { excluded.pending += 1; continue; }
    if (transaction.is_archived === true || transaction.archived_at) { excluded.archived += 1; continue; }
    const category = classifyPermittedTaxSignal(row);
    by_category[category] += 1;
    eligible.push({ row, transaction, category });
  }
  const prioritized = eligible.sort(compareReviewPriority);
  const examples = prioritized.slice(0, MAX_ACTIONABLE_EXAMPLES).map(toActionableExample);
  const references = prioritized.slice(0, MAX_REFERENCES).map(({ row, transaction, category }) => ({
    transaction_id: row.transaction_id,
    date: row.transaction_date || transaction.date || null,
    signal: category,
    status: "needs_review",
  }));
  return {
    count: eligible.length,
    by_category,
    references,
    examples,
    transaction_ids: eligible.map(({ row }) => row.transaction_id),
    duplicates_detected: 0,
    excluded,
  };
}

async function loadAllTaxReviewRows({ db, businessId, taxYear, pageSize }) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new EvidenceUnavailableError("tax_review_page_size_invalid");
  const rows = [];
  let expectedCount = null;
  for (let from = 0; ; from += pageSize) {
    const { data, error, count } = await db.from("transaction_tax_classifications")
      .select("transaction_id,transaction_date,book_amount,tax_category,deductibility_status,classification_status,requires_review,reason,confidence_score,rule_priority,metadata", { count: from === 0 ? "exact" : undefined })
      .eq("business_id", businessId).eq("tax_year", taxYear).eq("classification_status", "needs_review")
      .order("transaction_id", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw error;
    if (from === 0 && count != null) expectedCount = Number(count);
    rows.push(...(data || []));
    if (!data?.length || data.length < pageSize || (expectedCount != null && rows.length >= expectedCount)) break;
  }
  if (expectedCount != null && rows.length !== expectedCount) throw new EvidenceUnavailableError("tax_review_pagination_incomplete");
  return rows;
}

async function loadTransactionDetails({ db, businessId, transactionIds }) {
  const rows = [];
  for (let index = 0; index < transactionIds.length; index += TRANSACTION_LOOKUP_CHUNK_SIZE) {
    const ids = transactionIds.slice(index, index + TRANSACTION_LOOKUP_CHUNK_SIZE);
    const { data, error } = await db.from("bank_transactions")
      .select("id,date,name,merchant_name,amount,signed_amount,iso_currency_code,unofficial_currency_code,pending,is_archived,archived_at")
      .eq("business_id", businessId).in("id", ids);
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

function compareReviewPriority(left, right) {
  const signalDifference = reviewSignalPriority(right.row) - reviewSignalPriority(left.row);
  if (signalDifference) return signalDifference;
  const confidenceDifference = numericConfidence(left.row.confidence_score) - numericConfidence(right.row.confidence_score);
  if (confidenceDifference) return confidenceDifference;
  const amountDifference = absoluteAmount(right) - absoluteAmount(left);
  if (amountDifference) return amountDifference;
  const dateDifference = String(right.row.transaction_date || right.transaction.date || "").localeCompare(String(left.row.transaction_date || left.transaction.date || ""));
  if (dateDifference) return dateDifference;
  return String(left.row.transaction_id).localeCompare(String(right.row.transaction_id));
}

function reviewSignalPriority(row) {
  const metadata = row.metadata || {};
  if (metadata.substantiation_required || metadata.business_purpose_required || metadata.personal_business_mixed_use) return 3;
  if (String(row.reason || "").trim()) return 2;
  return row.requires_review === true ? 1 : 0;
}

function numericConfidence(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 1; }
function absoluteAmount({ row, transaction }) { const parsed = Number(row.book_amount ?? transaction.signed_amount ?? transaction.amount); return Number.isFinite(parsed) ? Math.abs(parsed) : 0; }

function toActionableExample({ row, transaction, category }) {
  const amount = row.book_amount ?? transaction.signed_amount ?? transaction.amount;
  const parsedAmount = Number(amount);
  return {
    transaction_id: row.transaction_id,
    date: row.transaction_date || transaction.date || null,
    merchant: transaction.merchant_name || transaction.name || null,
    amount: Number.isFinite(parsedAmount) ? parsedAmount : null,
    currency: transaction.iso_currency_code || transaction.unofficial_currency_code || null,
    review_category: category,
    review_reason: safeText(row.reason),
    status: "needs_review",
  };
}

function safeText(value) { const text = typeof value === "string" ? value.trim() : ""; return text ? text.slice(0, 240) : null; }
function sumCategoryCounts(categories = {}) { return ["owner_or_personal", "meals_or_travel", "capital_asset", "other"].reduce((sum, key) => sum + Number(categories[key] || 0), 0); }
function uniqueRowsByTransaction(rows, duplicateCode) {
  const byId = new Map();
  for (const row of rows) {
    if (!row.transaction_id) throw new EvidenceUnavailableError("review_transaction_id_missing");
    if (byId.has(row.transaction_id)) throw new EvidenceUnavailableError(duplicateCode);
    byId.set(row.transaction_id, row);
  }
  return [...byId.values()];
}

export function classifyPermittedTaxSignal(row = {}) {
  const category = String(row.tax_category || "").toLowerCase();
  const metadata = row.metadata || {};
  if (/owner|personal|distribution|draw/.test(category) || metadata.personal_business_mixed_use) return "owner_or_personal";
  if (/meal|travel/.test(category) && (metadata.substantiation_required || metadata.business_purpose_required || row.requires_review)) return "meals_or_travel";
  if (row.deductibility_status === "capitalizable" || /equipment|asset|capitaliz/.test(category)) return "capital_asset";
  return "other";
}

async function loadReadinessSignals({ db, businessId, taxYear }) {
  const queries = await Promise.allSettled([
    countQuery(db.from("bizzy_chat_bookkeeping_feed").select("transaction_id", { count: "exact", head: true }).eq("business_id", businessId).eq("primary_feed", "needs_review")),
    countQuery(db.from("bank_transactions").select("id", { count: "exact", head: true }).eq("business_id", businessId).or("pending.eq.true,accounting_review_required.eq.true,pending_resolution_state.eq.stale_pending_check_required")),
    oneQuery(db.from("reconciliation_runs").select("status,period_start,period_end,last_checked_at,needs_review_count,pending_count,failed_post_count").eq("business_id", businessId).order("last_checked_at", { ascending: false }).limit(1).maybeSingle()),
    Promise.all([oneQuery(db.from("quickbooks_tokens").select("realm_id,status,is_active,last_connected_at,connected_at,created_at").eq("business_id", businessId).eq("status", "active").eq("is_active", true).order("last_connected_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle()), oneQuery(db.from("plaid_items").select("status,last_success_at,last_sync_at").eq("business_id", businessId).eq("is_active", true).in("status", ["connected", "active"]).order("updated_at", { ascending: false }).limit(1).maybeSingle())]),
    countQuery(db.from("transaction_categorizations").select("transaction_id", { count: "exact", head: true }).eq("business_id", businessId).not("post_error", "is", null)),
    countQuery(db.from("bizzy_chat_bookkeeping_feed").select("transaction_id", { count: "exact", head: true }).eq("business_id", businessId).in("primary_feed", ["needs_review", "pending"])),
    oneQuery(db.from("qbo_pnl_exact_range_evidence").select("id,completeness_status,reconciliation_status,refreshed_at").eq("business_id", businessId).eq("accounting_basis", "Cash").eq("completeness_status", "complete").eq("reconciliation_status", "reconciled").order("refreshed_at", { ascending: false }).limit(1).maybeSingle()),
    countQuery(db.from("transaction_tax_classifications").select("transaction_id", { count: "exact", head: true }).eq("business_id", businessId).eq("tax_year", taxYear).eq("classification_status", "needs_review")),
  ]);
  const available = (index) => queries[index].status === "fulfilled";
  const value = (index) => available(index) ? queries[index].value : null;
  const connection = value(3);
  return {
    needs_review: signal(available(0), value(0), "bookkeeping_review_query_failed"),
    pending: signal(available(1), value(1), "pending_review_query_failed"),
    reconciliation: buildReconciliationReadinessSignal(queries[2]),
    connections: {
      available: available(3) && !!connection?.[0]?.realm_id && !!connection?.[1],
      blocker_count: connection?.[0]?.realm_id && connection?.[1] ? 0 : 1,
      unavailable_reason: !available(3) ? "connection_health_query_failed" : (!connection?.[0]?.realm_id || !connection?.[1]) ? "required_connection_evidence_missing" : null,
      qbo_last_connection_at: connection?.[0]?.last_connected_at || connection?.[0]?.connected_at || connection?.[0]?.created_at || null,
      plaid_last_sync_at: connection?.[1]?.last_success_at || connection?.[1]?.last_sync_at || null,
    },
    posting: signal(available(4), value(4), "posting_error_query_failed"),
    categorization: signal(available(5), value(5), "bookkeeping_feed_query_failed"),
    pnl: {
      available: available(6) && !!value(6),
      blocker_count: value(6) ? 0 : 1,
      unavailable_reason: !available(6) ? "financial_evidence_query_failed" : !value(6) ? "verified_cash_pnl_missing" : null,
      evidence_id: value(6)?.id || null,
    },
    tax_review: signal(available(7), value(7), "tax_review_query_failed"),
  };
}

export function buildReconciliationReadinessSignal(settledQuery) {
  if (!settledQuery || settledQuery.status !== "fulfilled") {
    return {
      available: false,
      blocker_count: 0,
      status: "unavailable",
      unavailable_reason: "reconciliation_query_failed",
      latest: null,
      verified_scope: null,
    };
  }
  const row = settledQuery.value || null;
  if (!row) {
    return {
      available: true,
      blocker_count: 1,
      status: "not_completed",
      unavailable_reason: null,
      latest: null,
      verified_scope: null,
    };
  }
  const ok = String(row.status || "").toLowerCase() === "ok";
  return {
    available: true,
    blocker_count: ok ? 0 : 1,
    status: ok ? "verified_for_recorded_scope" : "issue_present",
    unavailable_reason: null,
    latest: row,
    verified_scope: {
      period_start: row.period_start || null,
      period_end: row.period_end || null,
      accounts: "limited_to_reconciliation_run_scope",
    },
  };
}

function basePackage({ businessId, intent, metrics, warnings, completeness = "complete" }) { return { id: randomUUID(), schema_version: PACKAGE_SCHEMA_VERSION, intent, business_id: businessId, period: null, comparison_period: null, accounting_basis: null, currency: null, sources: [], completeness, reconciliation: { status: "unavailable", difference: null }, formula_version: TAX_BOOKKEEPING_FORMULA_VERSION, metrics, warnings }; }
function signal(available, count, unavailableReason) { return { available, blocker_count: available ? Number(count || 0) : 0, unavailable_reason: available ? null : unavailableReason }; }
async function countQuery(query) { const { count, error } = await query; if (error) throw error; return Number(count || 0); }
async function oneQuery(query) { const { data, error } = await query; if (error) throw error; return data || null; }
function dedupeReferences(rows) { const seen = new Set(); return rows.filter((row) => { const key = `${row.transaction_id}:${row.signal}`; if (!row.transaction_id || seen.has(key)) return false; seen.add(key); return true; }); }
async function persistPackage({ db, packageRow }) { const { data, error } = await db.from("business_evidence_packages").insert(packageRow).select("*").single(); if (error) throw error; return data; }
