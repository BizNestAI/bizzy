// /src/services/tax/taxDeductionsApi.service.js
import {
  DEDUCTIBILITY_STATUSES,
  TAX_CLASSIFICATION_STATUSES,
  normalizeDateOnly,
  normalizeMoney,
  normalizeTaxYear,
} from "./taxDomain.js";
import { validationError, notFoundError } from "./taxErrors.js";
import { computeTaxDeductionsSummary } from "./taxDeductionsEngine.js";
import { compareTaxClassificationsToBookkeepingRollups } from "./taxDeductionsReconciliation.js";
import { getClassificationHistory } from "./taxClassificationOverride.service.js";
import { deriveReviewReasons } from "./taxClassificationReview.service.js";
import { getTaxCategoryMeta } from "./taxCategoryCatalog.js";
import { getTaxProfile, computeTaxProfileCompleteness } from "./taxProfile.service.js";
import { getRequiredFederalTaxConfigSet } from "./taxRuleConfig.repository.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SORTS = new Set(["date_desc", "date_asc", "amount_desc", "amount_asc", "confidence_asc", "confidence_desc", "updated_desc"]);

export async function getDeductionsOverview({ supabase, businessId, taxYear, asOfDate } = {}) {
  const context = requireContext({ supabase, businessId, taxYear, asOfDate });
  const [summary, reconciliation] = await Promise.all([
    computeTaxDeductionsSummary(context),
    safeReconciliation(context),
  ]);
  const setupState = await buildSetupState({ ...context, summary, reconciliation });
  return { ...summary, reconciliation, setupState, warnings: [...summary.warnings, ...setupState.warnings] };
}

export async function listDeductionTransactions({ supabase, businessId, taxYear, asOfDate, filters = {}, pagination = {} } = {}) {
  const context = requireContext({ supabase, businessId, taxYear, asOfDate });
  const limit = normalizeLimit(pagination.limit);
  const offset = normalizeOffset(pagination.offset);
  const rpcResult = await tryListViaRpc({ ...context, filters, limit, offset });
  if (rpcResult) return rpcResult;

  const { rows: pageRows, total, hasMore, totals, filterRows } = await loadJoinedRowsBounded({ ...context, filters, limit, offset });
  return {
    rows: pageRows.map(toTransactionRow),
    pagination: {
      limit,
      offset,
      returned: pageRows.length,
      total,
      hasMore,
    },
    totalsForFilter: totals,
    availableFilters: availableFilters(filterRows),
    warnings: collectWarnings(pageRows),
  };
}

export async function getDeductionTransactionDetail({ supabase, businessId, taxYear, transactionId } = {}) {
  const context = requireContext({ supabase, businessId, taxYear });
  if (!transactionId) throw validationError("missing_transaction_id", "transactionId is required.", { field: "transactionId" });
  const row = await loadSingleJoinedRow({ ...context, transactionId });
  if (!row) throw notFoundError("tax_deduction_transaction_not_found", "Tax deduction transaction was not found.");
  const overrideHistory = await getClassificationHistory({ supabase, businessId, taxYear: context.taxYear, transactionId });
  const reviewTask = await getReviewTask({ supabase, businessId, taxYear: context.taxYear, transactionId });
  return {
    transaction: toTransactionRow(row),
    classification: safeClassification(row.classification),
    explanation: {
      reason: row.classification.reason || null,
      steps: row.classification.metadata?.explanation_steps || [],
      warnings: safeWarnings(row.classification),
    },
    confidence: { score: row.classification.confidence_score ?? null, level: row.classification.confidence_level || "unavailable" },
    sourceTrace: buildSourceTrace(row),
    overrideHistory: overrideHistory.map(safeOverride),
    reviewTask,
    applicableRules: row.classification.rule_code ? [safeRuleSummary(row.classification)] : [],
    availableActions: availableActions(row.classification),
  };
}

export async function getDeductionCategoryDetail({ supabase, businessId, taxYear, asOfDate, taxCategory } = {}) {
  if (!taxCategory) throw validationError("missing_tax_category", "taxCategory is required.", { field: "taxCategory" });
  const overview = await getDeductionsOverview({ supabase, businessId, taxYear, asOfDate });
  const category = overview.categories.find((item) => item.taxCategory === taxCategory);
  const txns = await listDeductionTransactions({ supabase, businessId, taxYear, asOfDate, filters: { taxCategory }, pagination: { limit: 10, offset: 0 } });
  const rows = txns.rows;
  return {
    category: category || { taxCategory, displayName: getTaxCategoryMeta(taxCategory).displayName },
    totals: category ? pickCategoryTotals(category) : emptyCategoryTotals(),
    monthly: category?.monthly || {},
    transactionCount: category?.transactionCount || 0,
    reviewCount: category?.reviewCount || 0,
    topMerchants: topBy(rows, (row) => row.merchantName || row.counterpartyName),
    topQboAccounts: topBy(rows, (row) => row.qboAccountName),
    topRules: category?.topRules || [],
    warnings: category?.warnings || [],
    comparison: categoryComparison(category, overview.comparisons),
    recentTransactions: rows,
  };
}

export async function buildCpaPackage({ supabase, businessId, taxYear, asOfDate, includeHistory = false } = {}) {
  const overview = await getDeductionsOverview({ supabase, businessId, taxYear, asOfDate });
  const transactions = await listDeductionTransactions({
    supabase,
    businessId,
    taxYear,
    asOfDate,
    filters: {},
    pagination: { limit: MAX_LIMIT, offset: 0 },
  });
  const profile = await getTaxProfile({ supabase, businessId, taxYear: overview.meta.taxYear }).catch(() => null);
  const ruleSupport = await getRequiredFederalTaxConfigSet({
    supabase,
    taxYear: overview.meta.taxYear,
    filingStatus: profile?.filing_status,
    entityType: profile?.entity_type,
  }).catch((err) => ({ configs: {}, missing: [], warnings: [{ code: err.code || "tax_rules_missing", message: err.message || "Tax rules unavailable." }] }));
  return {
    metadata: {
      businessId,
      taxYear: overview.meta.taxYear,
      asOfDate: overview.meta.asOfDate,
      generatedAt: new Date().toISOString(),
      source: "transaction_tax_classifications",
    },
    taxProfileSummary: profile ? {
      id: profile.id,
      entityType: profile.entity_type,
      filingStatus: profile.filing_status,
      primaryTaxState: profile.primary_tax_state,
      profileStatus: profile.profile_status,
      completeness: computeTaxProfileCompleteness(profile),
    } : null,
    ruleSupportSummary: ruleSupport,
    deductionSummary: overview,
    transactions: includeHistory
      ? await appendHistory({ supabase, businessId, taxYear: overview.meta.taxYear, rows: transactions.rows })
      : transactions.rows,
    adjustmentsPlaceholder: [],
    coverage: overview.coverage,
    warnings: overview.warnings,
    generationAudit: {
      rawPayloadsIncluded: false,
      generatedBy: "tax_deductions_api",
      rowLimitApplied: transactions.pagination.hasMore,
    },
  };
}

async function tryListViaRpc({ supabase, businessId, taxYear, asOfDate, filters, limit, offset }) {
  if (typeof supabase.rpc !== "function") return null;
  const { data, error } = await supabase.rpc("get_tax_deduction_transaction_drilldown", {
    p_business_id: businessId,
    p_tax_year: taxYear,
    p_as_of_date: asOfDate,
    p_tax_category: filters.taxCategory || null,
    p_month: filters.month || null,
    p_deductibility_status: filters.deductibilityStatus || null,
    p_classification_status: filters.classificationStatus || null,
    p_confidence_level: filters.confidenceLevel || null,
    p_qbo_account_id: filters.qboAccountId || null,
    p_merchant: filters.merchant || null,
    p_search: filters.search || null,
    p_min_amount: filters.minAmount,
    p_max_amount: filters.maxAmount,
    p_sort: filters.sort || "date_desc",
    p_limit: limit,
    p_offset: offset,
  });
  if (error) {
    if (isMissingRpcError(error)) return null;
    throw error;
  }
  return normalizeRpcDrilldownPayload(data, { limit, offset });
}

function normalizeRpcDrilldownPayload(data, { limit, offset }) {
  const payload = data && typeof data === "object" ? data : {};
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const pagination = payload.pagination || {};
  return {
    rows: rows.map(normalizeRpcTransactionRow),
    pagination: {
      limit: Number(pagination.limit ?? limit),
      offset: Number(pagination.offset ?? offset),
      returned: Number(pagination.returned ?? rows.length),
      total: Number(pagination.total ?? rows.length),
      hasMore: Boolean(pagination.hasMore),
    },
    totalsForFilter: payload.totalsForFilter || { bookAmount: 0, deductibleAmount: 0, nondeductibleAmount: 0, capitalizableAmount: 0, needsReviewAmount: 0 },
    availableFilters: normalizeAvailableFilters(payload.availableFilters),
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
  };
}

function normalizeRpcTransactionRow(row) {
  return {
    ...row,
    date: normalizeDateOnly(row.date) || row.date,
    signedAmount: Number(row.signedAmount || 0),
    absoluteAmount: Number(row.absoluteAmount || Math.abs(Number(row.signedAmount || 0))),
    deductiblePercent: Number(row.deductiblePercent || 0),
    deductibleAmount: Number(row.deductibleAmount || 0),
    nondeductibleAmount: Number(row.nondeductibleAmount || 0),
    capitalizableAmount: Number(row.capitalizableAmount || 0),
    confidenceScore: row.confidenceScore == null ? null : Number(row.confidenceScore),
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    requiresReview: row.requiresReview === true,
    override: row.override || { hasOverride: false, source: null, lastChangedAt: null },
    rule: row.rule || { id: null, code: null, explanation: null, supportLevel: null },
  };
}

function normalizeAvailableFilters(value = {}) {
  return {
    taxCategories: sortedArray(value.taxCategories),
    classificationStatuses: sortedArray(value.classificationStatuses),
    deductibilityStatuses: sortedArray(value.deductibilityStatuses),
    qboAccounts: Array.isArray(value.qboAccounts) ? value.qboAccounts.filter((item) => item?.name).sort((a, b) => String(a.name).localeCompare(String(b.name))) : [],
    months: sortedArray(value.months),
    confidenceLevels: sortedArray(value.confidenceLevels),
  };
}

function sortedArray(value) {
  return Array.isArray(value) ? [...new Set(value.filter(Boolean))].sort() : [];
}

function isMissingRpcError(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  return text.includes("function") && (text.includes("does not exist") || text.includes("not found") || text.includes("could not find"));
}

async function loadJoinedRowsBounded({ supabase, businessId, taxYear, asOfDate, filters, limit, offset }) {
  const sort = filters.sort || "date_desc";
  const totals = await loadBoundedTotals({ supabase, businessId, taxYear, asOfDate, filters });
  const filterRows = await loadFilterSample({ supabase, businessId, taxYear, asOfDate });
  const page = await fetchBoundedPage({ supabase, businessId, taxYear, asOfDate, filters, sort, limit: limit + 1, offset });
  const hasMore = page.length > limit;
  const rows = hasMore ? page.slice(0, limit) : page;
  return { rows, total: offset + rows.length + (hasMore ? 1 : 0), hasMore, totals, filterRows };
}

async function fetchBoundedPage({ supabase, businessId, taxYear, asOfDate, filters, sort, limit, offset }) {
  let query = buildClassificationQuery({ supabase, businessId, taxYear, asOfDate, filters });
  query = applyClassificationSort(query, sort);
  if (typeof query.range === "function") query = query.range(offset, offset + limit - 1);
  const { data, error } = await query;
  if (error) throw error;
  const hydrated = await hydrateClassificationRows({ supabase, businessId, taxYear, asOfDate, classifications: data || [] });
  return hydrated.filter((row) => matchesFilters(row, filters, { taxYear }));
}

function buildClassificationQuery({ supabase, businessId, taxYear, asOfDate, filters }) {
  let query = supabase.from("transaction_tax_classifications");
  query = query.select("*");
  query = query.eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .gte("transaction_date", filters.month ? `${filters.month}-01` : `${taxYear}-01-01`)
    .lte("transaction_date", filters.month ? lastDayOfMonth(filters.month) : asOfDate);
  if (filters.taxCategory) query = query.eq("tax_category", filters.taxCategory);
  if (filters.deductibilityStatus) query = query.eq("deductibility_status", filters.deductibilityStatus);
  if (filters.classificationStatus) query = query.eq("classification_status", filters.classificationStatus);
  if (filters.confidenceLevel) query = query.eq("confidence_level", filters.confidenceLevel);
  if (filters.qboAccountId) query = query.eq("source_qbo_account_id", filters.qboAccountId);
  return query;
}

async function hydrateClassificationRows({ supabase, businessId, taxYear, asOfDate = `${taxYear}-12-31`, classifications }) {
  const ids = [...new Set((classifications || []).map((row) => row.transaction_id).filter(Boolean))];
  const [bankMap, overrideMap, reviewMap] = await Promise.all([
    fetchBankMap({ supabase, businessId, ids }),
    fetchLatestOverrideMap({ supabase, businessId, taxYear, ids }),
    fetchReviewTaskMap({ supabase, businessId, taxYear, ids }),
  ]);
  return (classifications || [])
    .map((classification) => {
      const bank = bankMap.get(String(classification.transaction_id));
      return bank ? { classification, bank, override: overrideMap.get(String(classification.transaction_id)) || null, reviewTask: reviewMap.get(String(classification.transaction_id)) || null } : null;
    })
    .filter(Boolean)
    .filter((row) => row.bank.business_id === businessId && row.bank.pending !== true && row.bank.is_archived !== true)
    .filter((row) => {
      const date = rowDate(row);
      return date && date <= asOfDate && date.startsWith(`${taxYear}-`);
    });
}

async function loadSingleJoinedRow({ supabase, businessId, taxYear, asOfDate, transactionId }) {
  const { data: classification, error } = await supabase
    .from("transaction_tax_classifications")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .eq("transaction_id", transactionId)
    .maybeSingle();
  if (error) throw error;
  if (!classification) return null;
  const rows = await hydrateClassificationRows({ supabase, businessId, taxYear, asOfDate, classifications: [classification] });
  return rows.find((row) => rowDate(row) <= asOfDate) || null;
}

async function loadBoundedTotals({ supabase, businessId, taxYear, asOfDate, filters }) {
  const rows = [];
  for (let offset = 0; offset < 1000; offset += 200) {
    let query = buildClassificationQuery({ supabase, businessId, taxYear, asOfDate, filters });
    if (typeof query.range === "function") query = query.range(offset, offset + 199);
    const { data, error } = await query;
    if (error) throw error;
    const page = await hydrateClassificationRows({ supabase, businessId, taxYear, asOfDate, classifications: data || [] });
    rows.push(...page.filter((row) => matchesFilters(row, filters, { taxYear })));
    if (!data || data.length < 200) break;
  }
  return totalsForRows(rows);
}

async function loadFilterSample({ supabase, businessId, taxYear, asOfDate }) {
  let query = supabase
    .from("transaction_tax_classifications")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .gte("transaction_date", `${taxYear}-01-01`)
    .lte("transaction_date", asOfDate);
  query = applyClassificationSort(query, "date_desc");
  if (typeof query.range === "function") query = query.range(0, 999);
  const { data, error } = await query;
  if (error) throw error;
  return hydrateClassificationRows({ supabase, businessId, taxYear, asOfDate, classifications: data || [] });
}

function applyClassificationSort(query, sort) {
  if (sort === "date_asc") return query.order("transaction_date", { ascending: true }).order("updated_at", { ascending: false }).order("id", { ascending: false });
  if (sort === "amount_desc") return query.order("book_amount", { ascending: true }).order("transaction_date", { ascending: false }).order("updated_at", { ascending: false }).order("id", { ascending: false });
  if (sort === "amount_asc") return query.order("book_amount", { ascending: false }).order("transaction_date", { ascending: false }).order("updated_at", { ascending: false }).order("id", { ascending: false });
  if (sort === "confidence_asc") return query.order("confidence_score", { ascending: true }).order("transaction_date", { ascending: false }).order("updated_at", { ascending: false }).order("id", { ascending: false });
  if (sort === "confidence_desc") return query.order("confidence_score", { ascending: false }).order("transaction_date", { ascending: false }).order("updated_at", { ascending: false }).order("id", { ascending: false });
  if (sort === "updated_desc") return query.order("updated_at", { ascending: false }).order("transaction_date", { ascending: false }).order("id", { ascending: false });
  return query.order("transaction_date", { ascending: false }).order("updated_at", { ascending: false }).order("id", { ascending: false });
}

function lastDayOfMonth(month) {
  const [year, monthNum] = String(month).split("-").map(Number);
  const day = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  return `${year}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function fetchBankMap({ supabase, businessId, ids }) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from("bank_transactions")
      .select("id,business_id,date,authorized_date,pending,is_archived,name,merchant_name,counterparty_name,signed_amount,amount,direction,category_primary,category_detailed,payment_channel,transaction_type,created_at")
      .eq("business_id", businessId)
      .in("id", chunk);
    if (error) throw error;
    for (const row of data || []) map.set(String(row.id), row);
  }
  return map;
}

async function fetchLatestOverrideMap({ supabase, businessId, taxYear, ids }) {
  const map = new Map();
  if (!ids.length) return map;
  const { data, error } = await supabase
    .from("tax_classification_overrides")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .in("transaction_id", ids)
    .order("created_at", { ascending: false });
  if (error) throw error;
  for (const row of data || []) if (!map.has(String(row.transaction_id))) map.set(String(row.transaction_id), row);
  return map;
}

async function fetchReviewTaskMap({ supabase, businessId, taxYear, ids }) {
  const map = new Map();
  if (!ids.length) return map;
  const { data, error } = await supabase
    .from("tax_review_tasks")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .in("transaction_id", ids);
  if (error) throw error;
  for (const row of data || []) map.set(String(row.transaction_id), safeReviewTask(row));
  return map;
}

async function getReviewTask({ supabase, businessId, taxYear, transactionId }) {
  const { data, error } = await supabase
    .from("tax_review_tasks")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .eq("transaction_id", transactionId)
    .maybeSingle();
  if (error) throw error;
  return data ? safeReviewTask(data) : null;
}

function matchesFilters(row, filters, context) {
  const c = row.classification;
  const b = row.bank;
  const date = rowDate(row);
  const abs = Math.abs(Number(c.book_amount ?? b.signed_amount ?? 0));
  if (filters.taxCategory && c.tax_category !== filters.taxCategory) return false;
  if (filters.month && date.slice(0, 7) !== filters.month) return false;
  if (filters.month && !filters.month.startsWith(`${context.taxYear}-`)) return false;
  if (filters.deductibilityStatus && c.deductibility_status !== filters.deductibilityStatus) return false;
  if (filters.classificationStatus && c.classification_status !== filters.classificationStatus) return false;
  if (filters.confidenceLevel && c.confidence_level !== filters.confidenceLevel) return false;
  if (filters.qboAccountId && sourceQboAccountId(c) !== filters.qboAccountId) return false;
  if (filters.merchant && !containsAny([b.merchant_name, b.counterparty_name], filters.merchant)) return false;
  if (filters.search && !containsAny([b.name, b.merchant_name, b.counterparty_name, c.tax_category, c.rule_code, c.reason, sourceQboAccountName(c)], filters.search)) return false;
  if (filters.minAmount != null && abs < Number(filters.minAmount)) return false;
  if (filters.maxAmount != null && abs > Number(filters.maxAmount)) return false;
  return true;
}

function toTransactionRow(row) {
  const c = row.classification;
  const b = row.bank;
  const signedAmount = Number(c.book_amount ?? b.signed_amount ?? 0);
  const warnings = safeWarnings(c);
  return {
    transactionId: c.transaction_id,
    date: rowDate(row),
    description: b.name || c.metadata?.description || null,
    merchantName: b.merchant_name || null,
    counterpartyName: b.counterparty_name || null,
    signedAmount,
    absoluteAmount: Math.abs(signedAmount),
    direction: b.direction || c.metadata?.direction || (signedAmount >= 0 ? "INFLOW" : "OUTFLOW"),
    qboAccountId: sourceQboAccountId(c),
    qboAccountName: sourceQboAccountName(c),
    qboTxnId: c.source_qbo_txn_id || c.metadata?.source_qbo_txn_id || null,
    qboTxnType: c.source_qbo_txn_type || c.metadata?.source_qbo_txn_type || null,
    taxCategory: c.tax_category,
    deductibilityStatus: c.deductibility_status,
    deductiblePercent: Number(c.deductible_percent || 0),
    deductibleAmount: Number(c.deductible_amount || 0),
    nondeductibleAmount: Number(c.nondeductible_amount || 0),
    capitalizableAmount: Number(c.capitalizable_amount || 0),
    taxTreatment: c.tax_treatment || null,
    classificationStatus: c.classification_status,
    confidenceScore: c.confidence_score ?? null,
    confidenceLevel: c.confidence_level || "unavailable",
    rule: safeRuleSummary(c),
    reason: c.reason || null,
    warnings,
    requiresReview: c.requires_review === true || c.classification_status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW,
    override: {
      hasOverride: Boolean(c.user_override || c.cpa_override || row.override),
      source: row.override?.override_source || c.source || null,
      lastChangedAt: row.override?.created_at || null,
    },
    sourceTruth: c.metadata?.source_truth || null,
    postedAt: c.metadata?.posted_at || null,
    classifiedAt: c.metadata?.classified_at || c.created_at || null,
    updatedAt: c.updated_at || null,
  };
}

function safeClassification(c) {
  return {
    id: c.id || null,
    transactionId: c.transaction_id,
    taxYear: c.tax_year,
    taxCategory: c.tax_category,
    deductibilityStatus: c.deductibility_status,
    deductiblePercent: c.deductible_percent,
    bookAmount: c.book_amount,
    deductibleAmount: c.deductible_amount,
    nondeductibleAmount: c.nondeductible_amount,
    capitalizableAmount: c.capitalizable_amount,
    classificationStatus: c.classification_status,
    confidenceScore: c.confidence_score,
    confidenceLevel: c.confidence_level,
    ruleId: c.rule_id,
    ruleCode: c.rule_code,
    reason: c.reason,
    requiresReview: c.requires_review,
    userOverride: c.user_override === true,
    cpaOverride: c.cpa_override === true,
    updatedAt: c.updated_at,
  };
}

function buildSourceTrace(row) {
  const c = row.classification;
  return [
    { step: "bank_transaction", present: true, id: row.bank.id, date: row.bank.date },
    { step: "bookkeeping_categorization", present: Boolean(sourceQboAccountName(c)), qboAccountName: sourceQboAccountName(c) },
    { step: "qbo_posting", present: Boolean(c.source_qbo_txn_id || c.metadata?.source_qbo_txn_id), qboTxnId: c.source_qbo_txn_id || c.metadata?.source_qbo_txn_id || null },
    { step: "tax_rule_match", present: Boolean(c.rule_code), ruleCode: c.rule_code || null },
    { step: "classification", present: true, status: c.classification_status },
    { step: "override", present: Boolean(row.override), source: row.override?.override_source || null },
  ];
}

function safeOverride(row) {
  return {
    id: row.id || null,
    classificationId: row.classification_id || null,
    previousValues: row.previous_values || null,
    newValues: row.new_values || null,
    overrideSource: row.override_source || null,
    overrideReason: row.override_reason || null,
    overriddenBy: row.overridden_by || null,
    createdAt: row.created_at || null,
  };
}

function safeReviewTask(row) {
  return row ? {
    id: row.id || null,
    reasonCode: row.reason_code || null,
    severity: row.severity || null,
    status: row.status || null,
    title: row.title || null,
    description: row.description || null,
    updatedAt: row.updated_at || null,
  } : null;
}

function safeRuleSummary(c) {
  return {
    id: c.rule_id || null,
    code: c.rule_code || null,
    explanation: c.reason || null,
    supportLevel: c.metadata?.rule_support_level || null,
  };
}

function availableActions(c) {
  if (c.classification_status === TAX_CLASSIFICATION_STATUSES.EXCLUDED) return ["restore"];
  const actions = ["confirm", "edit", "exclude", "create_business_rule"];
  if (c.requires_review || c.classification_status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW) actions.push("resolve_review");
  return actions;
}

function totalsForRows(rows) {
  return rows.reduce((acc, row) => {
    const c = row.classification;
    acc.bookAmount += Math.abs(Number(c.book_amount || 0));
    acc.deductibleAmount += Number(c.deductible_amount || 0);
    acc.nondeductibleAmount += Number(c.nondeductible_amount || 0);
    acc.capitalizableAmount += Number(c.capitalizable_amount || 0);
    if (c.requires_review || c.classification_status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW) acc.needsReviewAmount += Math.abs(Number(c.book_amount || 0));
    return acc;
  }, { bookAmount: 0, deductibleAmount: 0, nondeductibleAmount: 0, capitalizableAmount: 0, needsReviewAmount: 0 });
}

function availableFilters(rows) {
  const values = {
    taxCategories: new Set(),
    classificationStatuses: new Set(),
    deductibilityStatuses: new Set(),
    qboAccounts: new Map(),
    months: new Set(),
    confidenceLevels: new Set(),
  };
  for (const row of rows) {
    const c = row.classification;
    values.taxCategories.add(c.tax_category);
    values.classificationStatuses.add(c.classification_status);
    values.deductibilityStatuses.add(c.deductibility_status);
    if (sourceQboAccountName(c)) values.qboAccounts.set(sourceQboAccountId(c) || sourceQboAccountName(c), { id: sourceQboAccountId(c), name: sourceQboAccountName(c) });
    values.months.add(rowDate(row).slice(0, 7));
    if (c.confidence_level) values.confidenceLevels.add(c.confidence_level);
  }
  return {
    taxCategories: [...values.taxCategories].filter(Boolean).sort(),
    classificationStatuses: [...values.classificationStatuses].filter(Boolean).sort(),
    deductibilityStatuses: [...values.deductibilityStatuses].filter(Boolean).sort(),
    qboAccounts: [...values.qboAccounts.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    months: [...values.months].filter(Boolean).sort(),
    confidenceLevels: [...values.confidenceLevels].filter(Boolean).sort(),
  };
}

async function buildSetupState({ supabase, businessId, taxYear, summary, reconciliation }) {
  const warnings = [];
  let state = "ready";
  if (!summary.coverage.eligiblePostedCount && !summary.coverage.classifiedCount) {
    state = "no_posted_transactions";
    warnings.push(warning("no_posted_transactions", "medium", "No posted tax-eligible transactions were found.", "refresh_books"));
  } else if (!summary.coverage.classifiedCount) {
    state = "classifications_missing";
    warnings.push(warning("classifications_not_run", "high", "Posted transactions have not been tax-classified yet.", "run_classification"));
  } else if (summary.coverage.needsReviewCount > 0) {
    state = "needs_review";
    warnings.push(warning("classifications_incomplete", "medium", "Some classifications still need review.", "review_transactions"));
  } else if (summary.coverage.classificationCoveragePercent < 100) {
    state = "partial";
    warnings.push(warning("classifications_incomplete", "medium", "Not all posted transactions are classified.", "run_classification"));
  }
  const profile = await getTaxProfile({ supabase, businessId, taxYear }).catch(() => null);
  if (profile) {
    const completeness = computeTaxProfileCompleteness(profile);
    if (!completeness.isCompleteForEstimate) warnings.push(warning("tax_profile_incomplete", "medium", "Tax profile is incomplete.", "complete_tax_profile"));
  }
  if (reconciliation?.status === "difference_found") warnings.push(warning("source_reconciliation_difference", "low", "Bookkeeping rollups differ from tax classifications.", "review_transactions"));
  if (summary.coverage.needsReviewBookAmount > summary.totals.estimatedDeductibleAmount * 0.25 && summary.coverage.needsReviewBookAmount > 0) {
    warnings.push(warning("high_needs_review_amount", "medium", "A meaningful amount of activity needs review.", "review_transactions"));
  }
  return { state, warnings };
}

async function safeReconciliation(context) {
  try {
    return await compareTaxClassificationsToBookkeepingRollups(context);
  } catch (err) {
    return { status: "unavailable", warning: err.code || "reconciliation_unavailable" };
  }
}

function collectWarnings(rows) {
  return [...new Set(rows.flatMap((row) => safeWarnings(row.classification)))];
}

function safeWarnings(c) {
  return [
    ...(Array.isArray(c.metadata?.warnings) ? c.metadata.warnings : []),
    ...(Array.isArray(c.metadata?.source_warnings) ? c.metadata.source_warnings : []),
    ...((c.requires_review || c.classification_status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW) ? deriveReviewReasons(c) : []),
  ];
}

function rowDate(row) {
  return normalizeDateOnly(row.classification.transaction_date) || normalizeDateOnly(row.bank.date) || "";
}

function sourceQboAccountId(c) {
  return c.source_qbo_account_id || c.metadata?.source_qbo_account_id || null;
}

function sourceQboAccountName(c) {
  return c.source_qbo_account_name || c.metadata?.source_qbo_account_name || c.metadata?.bookkeeping_category || null;
}

function requireContext({ supabase, businessId, taxYear, year, asOfDate } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const normalizedYear = normalizeTaxYear(taxYear ?? year);
  if (!normalizedYear) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  const date = asOfDate == null || asOfDate === "" ? `${normalizedYear}-12-31` : normalizeDateOnly(asOfDate);
  if (!date) throw validationError("invalid_as_of_date", "asOfDate must be YYYY-MM-DD.", { field: "asOfDate" });
  return { supabase, businessId, taxYear: normalizedYear, asOfDate: date };
}

export function validateDeductionTransactionFilters(query = {}) {
  const filters = {
    taxCategory: optionalString(query.taxCategory),
    month: optionalMonth(query.month),
    deductibilityStatus: optionalEnum(query.deductibilityStatus, Object.values(DEDUCTIBILITY_STATUSES), "deductibilityStatus"),
    classificationStatus: optionalEnum(query.classificationStatus, Object.values(TAX_CLASSIFICATION_STATUSES), "classificationStatus"),
    confidenceLevel: optionalString(query.confidenceLevel),
    qboAccountId: optionalString(query.qboAccountId),
    merchant: optionalString(query.merchant),
    search: optionalString(query.search),
    minAmount: optionalMoney(query.minAmount, "minAmount"),
    maxAmount: optionalMoney(query.maxAmount, "maxAmount"),
    sort: optionalString(query.sort) || "date_desc",
  };
  if (!SORTS.has(filters.sort)) throw validationError("invalid_sort", "Unsupported deductions transaction sort.", { sort: filters.sort });
  if (filters.minAmount != null && filters.maxAmount != null && filters.minAmount > filters.maxAmount) {
    throw validationError("invalid_amount_range", "minAmount cannot exceed maxAmount.");
  }
  return filters;
}

function optionalString(value) {
  if (value == null || value === "") return null;
  if (Array.isArray(value)) throw validationError("invalid_filter", "Filter values must be scalar.");
  return String(value).trim() || null;
}

function optionalEnum(value, allowed, field) {
  const str = optionalString(value);
  if (!str) return null;
  if (!allowed.includes(str)) throw validationError(`invalid_${field}`, `${field} is not supported.`, { field });
  return str;
}

function optionalMoney(value, field) {
  if (value == null || value === "") return null;
  const n = normalizeMoney(value);
  if (n == null || n < 0) throw validationError(`invalid_${field}`, `${field} must be a nonnegative finite number.`, { field });
  return n;
}

function optionalMonth(value) {
  const str = optionalString(value);
  if (!str) return null;
  if (!/^\d{4}-\d{2}$/.test(str)) throw validationError("invalid_month", "month must be YYYY-MM.", { field: "month" });
  return str;
}

export function normalizeDeductionPagination({ limit, offset } = {}) {
  return { limit: normalizeLimit(limit), offset: normalizeOffset(offset) };
}

function normalizeLimit(value) {
  if (value == null || value === "") return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw validationError("invalid_limit", "limit must be an integer from 1 to 200.", { field: "limit" });
  return n;
}

function normalizeOffset(value) {
  if (value == null || value === "") return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw validationError("invalid_offset", "offset must be a non-negative integer.", { field: "offset" });
  return n;
}

function containsAny(values, needle) {
  const n = String(needle || "").toLowerCase();
  return values.some((value) => String(value || "").toLowerCase().includes(n));
}

function topBy(rows, fn) {
  const counts = new Map();
  for (const row of rows) {
    const key = fn(row);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([value, count]) => ({ value, count }));
}

function pickCategoryTotals(category) {
  return {
    bookExpenseAmount: category.bookExpenseAmount,
    estimatedDeductibleAmount: category.estimatedDeductibleAmount,
    confirmedDeductibleAmount: category.confirmedDeductibleAmount,
    autoClassifiedDeductibleAmount: category.autoClassifiedDeductibleAmount,
    nondeductibleAmount: category.nondeductibleAmount,
    capitalizableAmount: category.capitalizableAmount,
    needsReviewAmount: category.needsReviewAmount,
  };
}

function emptyCategoryTotals() {
  return {
    bookExpenseAmount: 0,
    estimatedDeductibleAmount: 0,
    confirmedDeductibleAmount: 0,
    autoClassifiedDeductibleAmount: 0,
    nondeductibleAmount: 0,
    capitalizableAmount: 0,
    needsReviewAmount: 0,
  };
}

function categoryComparison(category, comparisons) {
  return category ? comparisons?.currentYtdVsPriorYearYtd || null : null;
}

async function appendHistory({ supabase, businessId, taxYear, rows }) {
  const out = [];
  for (const row of rows) {
    const history = await getClassificationHistory({ supabase, businessId, taxYear, transactionId: row.transactionId }).catch(() => []);
    out.push({ ...row, overrideHistory: history.map(safeOverride) });
  }
  return out;
}

function warning(code, severity, message, action) {
  return { code, severity, message, action };
}
