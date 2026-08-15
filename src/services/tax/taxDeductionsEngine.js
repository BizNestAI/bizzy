// /src/services/tax/taxDeductionsEngine.js
import {
  DEDUCTIBILITY_STATUSES,
  TAX_CLASSIFICATION_STATUSES,
  normalizeDateOnly,
  normalizeTaxYear,
} from "./taxDomain.js";
import { validationError } from "./taxErrors.js";
import { TAX_DEDUCTIONS_ENGINE_VERSION } from "./taxEngineVersions.js";
import { countPostedTransactionsForTax } from "./taxPostedTransaction.repository.js";
import { getTaxCategoryMeta, sortTaxCategories } from "./taxCategoryCatalog.js";
import { applyActiveBookkeepingScope, getBookkeepingStartDate } from "../bookkeeping/bookkeepingScope.js";

const PAGE_SIZE = 1000;
const INCLUDED_STATUSES = new Set([
  TAX_CLASSIFICATION_STATUSES.AUTO_CLASSIFIED,
  TAX_CLASSIFICATION_STATUSES.USER_CONFIRMED,
  TAX_CLASSIFICATION_STATUSES.CPA_CONFIRMED,
  TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW,
]);
const CONFIRMED_STATUSES = new Set([
  TAX_CLASSIFICATION_STATUSES.USER_CONFIRMED,
  TAX_CLASSIFICATION_STATUSES.CPA_CONFIRMED,
]);

export async function computeTaxDeductionsSummary({
  supabase,
  businessId,
  taxYear,
  asOfDate,
  includeNeedsReview = true,
  includeExcluded = false,
  includeComparisons = true,
} = {}) {
  const context = buildContext({ supabase, businessId, taxYear, asOfDate });
  const classifications = await loadVisibleClassifications({ ...context, includeNeedsReview, includeExcluded });
  const monthList = buildMonthList(context.taxYear);
  const totals = buildEmptyTotals(monthList);
  const categoryMap = new Map();
  const warnings = [];

  for (const item of classifications) {
    applyClassificationToTotals({ item, totals, categoryMap, monthList });
  }

  const categories = Array.from(categoryMap.values())
    .map(finalizeCategory)
    .sort(sortTaxCategories);
  const coverage = await computeCoverageFromRows({ ...context, rows: classifications });
  if (!classifications.length) {
    warnings.push({
      code: "no_tax_classifications",
      severity: "medium",
      message: "No transaction tax classifications were found for this tax year.",
    });
  }
  if (coverage.needsReviewCount > 0) {
    warnings.push({
      code: "deductions_need_review",
      severity: "medium",
      message: "Some posted activity still needs tax classification review.",
    });
  }

  const comparisons = includeComparisons
    ? await buildComparisons({ supabase, businessId, taxYear: context.taxYear, asOfDate: context.asOfDate })
    : emptyComparisons();

  return {
    meta: {
      businessId,
      taxYear: context.taxYear,
      asOfDate: context.asOfDate,
      generatedAt: new Date().toISOString(),
      source: "transaction_tax_classifications",
      engineVersion: TAX_DEDUCTIONS_ENGINE_VERSION,
      isLive: true,
    },
    coverage,
    totals: finalizeTotals(totals),
    categories,
    comparisons,
    warnings: [...warnings, ...coverage.warnings],
  };
}

export async function computeTaxDeductionsByMonth(args = {}) {
  const summary = await computeTaxDeductionsSummary({ ...args, includeComparisons: false });
  return summary.totals.byMonth;
}

export async function computeTaxDeductionsByCategory(args = {}) {
  const summary = await computeTaxDeductionsSummary({ ...args, includeComparisons: false });
  return summary.categories;
}

export async function computeTaxDeductionCoverage(args = {}) {
  const summary = await computeTaxDeductionsSummary({ ...args, includeComparisons: false });
  return summary.coverage;
}

export async function computeTaxDeductionComparison(args = {}) {
  const context = buildContext(args);
  const comparisons = await buildComparisons(context);
  return args.comparisonType ? comparisons[args.comparisonType] || null : comparisons;
}

async function loadVisibleClassifications({ supabase, businessId, taxYear, asOfDate, includeNeedsReview, includeExcluded }) {
  const rows = await fetchAllClassifications({ supabase, businessId, taxYear });
  const transactionIds = [...new Set(rows.map((row) => row.transaction_id).filter(Boolean))];
  const bankMap = await fetchBankTransactions({ supabase, businessId, transactionIds });
  const normalized = [];
  for (const row of rows) {
    const status = row.classification_status || TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW;
    if (status === TAX_CLASSIFICATION_STATUSES.EXCLUDED && !includeExcluded) continue;
    if (status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW && !includeNeedsReview) continue;
    if (status !== TAX_CLASSIFICATION_STATUSES.EXCLUDED && !INCLUDED_STATUSES.has(status)) continue;

    const bank = bankMap.get(String(row.transaction_id));
    if (!bank || bank.business_id !== businessId || bank.pending === true || bank.is_archived === true) continue;
    const transactionDate = normalizeDateOnly(row.transaction_date) || normalizeDateOnly(bank.date);
    if (!transactionDate || transactionDate > asOfDate || !transactionDate.startsWith(`${taxYear}-`)) continue;

    normalized.push({ classification: row, bankTransaction: bank, transactionDate });
  }
  return normalized;
}

async function fetchAllClassifications({ supabase, businessId, taxYear }) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = supabase
      .from("transaction_tax_classifications")
      .select("*")
      .eq("business_id", businessId)
      .eq("tax_year", taxYear)
      .order("transaction_date", { ascending: true })
      .order("transaction_id", { ascending: true });
    if (typeof query.range === "function") query = query.range(offset, offset + PAGE_SIZE - 1);
    const { data, error } = await query;
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchBankTransactions({ supabase, businessId, transactionIds }) {
  const map = new Map();
  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
  for (let i = 0; i < transactionIds.length; i += 500) {
    const chunk = transactionIds.slice(i, i + 500);
    if (!chunk.length) continue;
    const { data, error } = await applyActiveBookkeepingScope(
      supabase
      .from("bank_transactions")
      .select("id,business_id,date,pending,is_archived,signed_amount,direction,merchant_name,counterparty_name,name")
      .eq("business_id", businessId)
      .in("id", chunk),
      bookkeepingStartDate
    );
    if (error) throw error;
    for (const row of data || []) map.set(String(row.id), row);
  }
  return map;
}

async function computeCoverageFromRows({ supabase, businessId, taxYear, rows }) {
  const classifications = rows.map((item) => item.classification);
  let eligiblePostedCount = 0;
  const warnings = [];
  try {
    eligiblePostedCount = await countPostedTransactionsForTax({ supabase, businessId, taxYear });
  } catch {
    warnings.push({
      code: "eligible_posted_count_unavailable",
      severity: "low",
      message: "Eligible posted transaction count is temporarily unavailable.",
    });
  }
  const classifiedCount = classifications.filter((row) => row.classification_status !== TAX_CLASSIFICATION_STATUSES.EXCLUDED).length;
  const confirmedCount = classifications.filter((row) => CONFIRMED_STATUSES.has(row.classification_status)).length;
  const autoClassifiedCount = classifications.filter((row) => row.classification_status === TAX_CLASSIFICATION_STATUSES.AUTO_CLASSIFIED).length;
  const needsReviewCount = classifications.filter((row) => row.classification_status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW || row.requires_review === true).length;
  const excludedCount = classifications.filter((row) => row.classification_status === TAX_CLASSIFICATION_STATUSES.EXCLUDED).length;
  const bookAmountCovered = round2(rows.reduce((sum, item) => sum + absExpenseBookAmount(item), 0));
  const needsReviewBookAmount = round2(rows.reduce((sum, item) => sum + (isNeedsReview(item.classification) ? absExpenseBookAmount(item) : 0), 0));
  return {
    eligiblePostedCount,
    classifiedCount,
    confirmedCount,
    autoClassifiedCount,
    needsReviewCount,
    excludedCount,
    classificationCoveragePercent: eligiblePostedCount ? round2((classifiedCount / eligiblePostedCount) * 100) : 0,
    confirmedCoveragePercent: eligiblePostedCount ? round2((confirmedCount / eligiblePostedCount) * 100) : 0,
    bookAmountCovered,
    needsReviewBookAmount,
    warnings,
  };
}

function applyClassificationToTotals({ item, totals, categoryMap, monthList }) {
  const row = item.classification;
  const month = item.transactionDate.slice(0, 7);
  if (!monthList.includes(month)) return;
  const taxCategory = row.tax_category || "unclassified";
  const category = getOrCreateCategory(categoryMap, taxCategory, monthList);
  const contribution = contributionFor(item);
  addContribution(totals, contribution, month);
  addContribution(category, contribution, month);
  category.transactionCount += 1;
  category._deductiblePercentTotal += Number(row.deductible_percent || 0);
  category._confidenceScores.push(Number(row.confidence_score || 0));
  if (CONFIRMED_STATUSES.has(row.classification_status)) category.confirmedCount += 1;
  if (isNeedsReview(row)) category.reviewCount += 1;
  if (row.rule_code) category._rules.set(row.rule_code, (category._rules.get(row.rule_code) || 0) + 1);
  const bookkeepingCategory = row.metadata?.bookkeeping_category || row.metadata?.source_qbo_account_name || row.source_qbo_account_name;
  if (bookkeepingCategory) category._bookkeepingCategories.set(bookkeepingCategory, (category._bookkeepingCategories.get(bookkeepingCategory) || 0) + 1);
}

function contributionFor(item) {
  const row = item.classification;
  const status = row.classification_status;
  const deductibility = row.deductibility_status;
  const absBook = absExpenseBookAmount(item);
  const isConfirmed = CONFIRMED_STATUSES.has(status);
  const isAuto = status === TAX_CLASSIFICATION_STATUSES.AUTO_CLASSIFIED;
  const review = isNeedsReview(row);
  const balanceSheet = deductibility === DEDUCTIBILITY_STATUSES.BALANCE_SHEET ? absBook : 0;
  const capitalizable = Number(row.capitalizable_amount || 0);
  const deductible = review ? 0 : Number(row.deductible_amount || 0);
  const nondeductible = review ? 0 : Number(row.nondeductible_amount || 0);
  return {
    bookExpenseAmount: isCurrentExpense(row, item) ? absBook : 0,
    estimatedDeductibleAmount: isAuto || isConfirmed ? deductible : 0,
    confirmedDeductibleAmount: isConfirmed ? deductible : 0,
    autoClassifiedDeductibleAmount: isAuto ? deductible : 0,
    nondeductibleAmount: nondeductible,
    capitalizableAmount: review ? 0 : capitalizable,
    balanceSheetActivityAmount: balanceSheet,
    needsReviewAmount: review ? absBook : 0,
    excludedAmount: status === TAX_CLASSIFICATION_STATUSES.EXCLUDED ? absBook : 0,
  };
}

function isCurrentExpense(row, item) {
  if (!isExpenseOutflow(item)) return false;
  if ([DEDUCTIBILITY_STATUSES.BALANCE_SHEET, DEDUCTIBILITY_STATUSES.CAPITALIZABLE].includes(row.deductibility_status)) return false;
  if (row.classification_status === TAX_CLASSIFICATION_STATUSES.EXCLUDED) return false;
  if (row.tax_category === "income") return false;
  return true;
}

function absExpenseBookAmount(item) {
  return isExpenseOutflow(item) ? Math.abs(Number(item.classification.book_amount ?? item.bankTransaction.signed_amount ?? 0)) : 0;
}

function isExpenseOutflow(item) {
  const signed = Number(item.classification.book_amount ?? item.bankTransaction.signed_amount);
  if (Number.isFinite(signed) && signed < 0) return true;
  return String(item.bankTransaction.direction || item.classification.metadata?.direction || "").toUpperCase() === "OUTFLOW";
}

function isNeedsReview(row) {
  return row.classification_status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW || row.requires_review === true;
}

function getOrCreateCategory(categoryMap, taxCategory, monthList) {
  if (categoryMap.has(taxCategory)) return categoryMap.get(taxCategory);
  const meta = getTaxCategoryMeta(taxCategory);
  const category = {
    taxCategory,
    displayName: meta.displayName,
    bookExpenseAmount: 0,
    estimatedDeductibleAmount: 0,
    confirmedDeductibleAmount: 0,
    autoClassifiedDeductibleAmount: 0,
    nondeductibleAmount: 0,
    capitalizableAmount: 0,
    balanceSheetActivityAmount: 0,
    needsReviewAmount: 0,
    excludedAmount: 0,
    transactionCount: 0,
    confirmedCount: 0,
    reviewCount: 0,
    averageDeductiblePercent: 0,
    confidenceLevel: "unavailable",
    monthly: buildEmptyMonthMap(monthList),
    warnings: [],
    topRules: [],
    topBookkeepingCategories: [],
    _deductiblePercentTotal: 0,
    _confidenceScores: [],
    _rules: new Map(),
    _bookkeepingCategories: new Map(),
  };
  categoryMap.set(taxCategory, category);
  return category;
}

function addContribution(target, contribution, month) {
  for (const [key, value] of Object.entries(contribution)) {
    target[key] = round2(Number(target[key] || 0) + Number(value || 0));
    if (target.byMonth?.[month]?.[key] != null) target.byMonth[month][key] = round2(target.byMonth[month][key] + Number(value || 0));
    if (target.monthly?.[month]?.[monthKey(key)] != null) target.monthly[month][monthKey(key)] = round2(target.monthly[month][monthKey(key)] + Number(value || 0));
  }
  if (target.monthly?.[month]) target.monthly[month].transactionCount += 1;
}

function monthKey(key) {
  return key === "estimatedDeductibleAmount" ? "deductibleAmount" : key;
}

function finalizeCategory(category) {
  const copy = { ...category };
  copy.averageDeductiblePercent = copy.transactionCount ? round2(copy._deductiblePercentTotal / copy.transactionCount) : 0;
  copy.confidenceLevel = confidenceLevel(copy._confidenceScores);
  copy.topRules = topEntries(copy._rules);
  copy.topBookkeepingCategories = topEntries(copy._bookkeepingCategories);
  delete copy._deductiblePercentTotal;
  delete copy._confidenceScores;
  delete copy._rules;
  delete copy._bookkeepingCategories;
  return copy;
}

function finalizeTotals(totals) {
  return totals;
}

function buildEmptyTotals(monthList) {
  return {
    bookExpenseAmount: 0,
    estimatedDeductibleAmount: 0,
    confirmedDeductibleAmount: 0,
    autoClassifiedDeductibleAmount: 0,
    nondeductibleAmount: 0,
    capitalizableAmount: 0,
    balanceSheetActivityAmount: 0,
    needsReviewAmount: 0,
    excludedAmount: 0,
    byMonth: Object.fromEntries(monthList.map((month) => [month, {
      bookExpenseAmount: 0,
      estimatedDeductibleAmount: 0,
      confirmedDeductibleAmount: 0,
      autoClassifiedDeductibleAmount: 0,
      nondeductibleAmount: 0,
      capitalizableAmount: 0,
      balanceSheetActivityAmount: 0,
      needsReviewAmount: 0,
      excludedAmount: 0,
    }])),
  };
}

function buildEmptyMonthMap(monthList) {
  return Object.fromEntries(monthList.map((month) => [month, {
    bookExpenseAmount: 0,
    deductibleAmount: 0,
    nondeductibleAmount: 0,
    capitalizableAmount: 0,
    needsReviewAmount: 0,
    transactionCount: 0,
  }]));
}

async function buildComparisons({ supabase, businessId, taxYear, asOfDate }) {
  const currentAmount = await sumDeductibleForPeriod({ supabase, businessId, taxYear, dateFrom: `${taxYear}-01-01`, dateTo: asOfDate });
  const priorDate = correspondingDate(asOfDate, taxYear - 1);
  const priorAmount = await sumDeductibleForPeriod({ supabase, businessId, taxYear: taxYear - 1, dateFrom: `${taxYear - 1}-01-01`, dateTo: priorDate });
  const monthStart = `${asOfDate.slice(0, 7)}-01`;
  const priorMonthDate = addMonths(asOfDate, -1);
  const priorMonthStart = `${priorMonthDate.slice(0, 7)}-01`;
  const priorMonthTo = comparableMonthEnd(priorMonthDate, Number(asOfDate.slice(8, 10)));
  const currentMonthAmount = await sumDeductibleForPeriod({ supabase, businessId, taxYear, dateFrom: monthStart, dateTo: asOfDate });
  const priorMonthAmount = await sumDeductibleForPeriod({ supabase, businessId, taxYear: Number(priorMonthDate.slice(0, 4)), dateFrom: priorMonthStart, dateTo: priorMonthTo });
  return {
    currentYtdVsPriorYearYtd: comparison(currentAmount, priorAmount),
    currentMonthVsPriorMonth: comparison(currentMonthAmount, priorMonthAmount),
  };
}

async function sumDeductibleForPeriod({ supabase, businessId, taxYear, dateFrom, dateTo }) {
  const rows = await loadVisibleClassifications({ supabase, businessId, taxYear, asOfDate: dateTo, includeNeedsReview: false, includeExcluded: false });
  return round2(rows
    .filter((item) => item.transactionDate >= dateFrom && item.transactionDate <= dateTo)
    .reduce((sum, item) => sum + contributionFor(item).estimatedDeductibleAmount, 0));
}

function comparison(currentAmount, priorAmount) {
  const absoluteChange = round2(currentAmount - priorAmount);
  return {
    currentAmount,
    priorAmount,
    absoluteChange,
    percentChange: priorAmount ? round2((absoluteChange / priorAmount) * 100) : null,
    comparisonAvailable: priorAmount > 0,
  };
}

function emptyComparisons() {
  return {
    currentYtdVsPriorYearYtd: comparison(0, 0),
    currentMonthVsPriorMonth: comparison(0, 0),
  };
}

function buildContext({ supabase, businessId, taxYear, year, asOfDate }) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const normalizedYear = normalizeTaxYear(taxYear ?? year);
  if (!normalizedYear) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  const date = asOfDate == null || asOfDate === "" ? `${normalizedYear}-12-31` : normalizeDateOnly(asOfDate);
  if (!date) throw validationError("invalid_as_of_date", "asOfDate must be YYYY-MM-DD.", { field: "asOfDate" });
  return { supabase, businessId, taxYear: normalizedYear, asOfDate: date };
}

function buildMonthList(year) {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

function correspondingDate(date, year) {
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return formatDate(year, month, Math.min(day, daysInMonth(year, month)));
}

function addMonths(date, delta) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 10);
}

function comparableMonthEnd(date, day) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return formatDate(year, month, Math.min(day, daysInMonth(year, month)));
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function confidenceLevel(scores) {
  const usable = scores.filter((n) => Number.isFinite(n) && n > 0);
  if (!usable.length) return "unavailable";
  const avg = usable.reduce((a, b) => a + b, 0) / usable.length;
  if (avg >= 85) return "high";
  if (avg >= 60) return "medium";
  return "low";
}

function topEntries(map) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, 5)
    .map(([value, count]) => ({ value, count }));
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}
