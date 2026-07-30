// /src/services/tax/taxableIncome/taxRevenueSource.service.js
import { TAX_CLASSIFICATION_STATUSES } from "../taxDomain.js";
import {
  TAXABLE_INCOME_SOURCES,
  TAXABLE_INCOME_WARNING_CODES,
  round2,
  taxableWarning,
} from "./taxableIncomeDomain.js";
import {
  addMonthly,
  buildTaxableIncomeContext,
  emptyMonthly,
  isBalanceSheetLike,
  isIncomeInflow,
  isNeedsReviewClassification,
  loadAnnualClassificationItems,
} from "./taxableIncomeSourceUtils.js";

const REVENUE_CATEGORIES = new Set(["income", "gross_receipts", "sales", "service_revenue", "other_business_income"]);
const OTHER_INCOME_CATEGORIES = new Set(["other_business_income", "interest_income", "misc_income"]);
const RETURNS_CATEGORIES = new Set(["returns_allowances", "refund_or_reversal", "sales_returns"]);
const EXCLUDED_INFLOW_CATEGORIES = new Set(["owner_contribution", "loan_principal", "transfer", "credit_card_payment"]);

export async function getTaxRevenueSummary({
  supabase,
  businessId,
  taxYear,
  asOfDate,
  accountingMethod,
  includeForecast = false,
} = {}) {
  const context = buildTaxableIncomeContext({ supabase, businessId, taxYear, asOfDate });
  const { items, excludedItems, futureExcludedCount } = await loadAnnualClassificationItems({ ...context, includeExcluded: true });
  const monthly = emptyMonthly(context.taxYear, {
    grossReceipts: 0,
    otherBusinessIncome: 0,
    returnsAndAllowances: 0,
    netBusinessRevenue: 0,
  });
  const sourceBreakdown = {
    [TAXABLE_INCOME_SOURCES.TRANSACTION_CLASSIFICATIONS]: 0,
    [TAXABLE_INCOME_SOURCES.FINANCIAL_METRICS]: 0,
    [TAXABLE_INCOME_SOURCES.PROJECTION]: 0,
  };
  const warnings = [];
  let grossReceipts = 0;
  let otherBusinessIncome = 0;
  let returnsAndAllowances = 0;
  let unclassifiedInflowCount = 0;
  const includedSourceItems = [];
  const excludedSourceItems = [...(excludedItems || []).map((item) => revenueSourceSnapshot(item, {
    treatment: "excluded",
    exclusionReason: item.exclusionReason,
    includedAmount: 0,
  })).filter(Boolean)];

  for (const item of items) {
    const row = item.classification;
    if (!isIncomeInflow(item)) continue;
    if (row.classification_status === TAX_CLASSIFICATION_STATUSES.EXCLUDED) {
      excludedSourceItems.push(revenueSourceSnapshot(item, { treatment: "excluded", exclusionReason: "classification_excluded", includedAmount: 0 }));
      continue;
    }
    if (EXCLUDED_INFLOW_CATEGORIES.has(row.tax_category) || isBalanceSheetLike(row)) {
      excludedSourceItems.push(revenueSourceSnapshot(item, { treatment: "excluded", exclusionReason: excludedIncomeReason(row), includedAmount: 0 }));
      continue;
    }

    const amount = Math.abs(Number(row.book_amount ?? item.bankTransaction.signed_amount ?? 0));
    if (RETURNS_CATEGORIES.has(row.tax_category) || row.tax_treatment?.type === "returns_allowances") {
      returnsAndAllowances = round2(returnsAndAllowances + amount);
      addMonthly(monthly, item.month, { returnsAndAllowances: amount, netBusinessRevenue: -amount });
      includedSourceItems.push(revenueSourceSnapshot(item, { treatment: "returns_allowances", includedAmount: -amount }));
      continue;
    }

    if (isNeedsReviewClassification(row) || !REVENUE_CATEGORIES.has(row.tax_category)) {
      unclassifiedInflowCount += 1;
      excludedSourceItems.push(revenueSourceSnapshot(item, { treatment: "excluded", exclusionReason: "needs_review_or_unsupported_income_category", includedAmount: 0 }));
      continue;
    }

    if (OTHER_INCOME_CATEGORIES.has(row.tax_category) || row.tax_treatment?.type === "other_business_income") {
      otherBusinessIncome = round2(otherBusinessIncome + amount);
      addMonthly(monthly, item.month, { otherBusinessIncome: amount, netBusinessRevenue: amount });
      includedSourceItems.push(revenueSourceSnapshot(item, { treatment: "included_other_business_income", includedAmount: amount }));
    } else {
      grossReceipts = round2(grossReceipts + amount);
      addMonthly(monthly, item.month, { grossReceipts: amount, netBusinessRevenue: amount });
      includedSourceItems.push(revenueSourceSnapshot(item, { treatment: "included_gross_receipts", includedAmount: amount }));
    }
    sourceBreakdown[TAXABLE_INCOME_SOURCES.TRANSACTION_CLASSIFICATIONS] = round2(
      sourceBreakdown[TAXABLE_INCOME_SOURCES.TRANSACTION_CLASSIFICATIONS] + amount
    );
  }

  if (unclassifiedInflowCount > 0) {
    warnings.push(taxableWarning(
      TAXABLE_INCOME_WARNING_CODES.UNSUPPORTED_INCOME_SOURCE,
      "high",
      "Some inflows are not tax-classified as revenue yet.",
      { count: unclassifiedInflowCount }
    ));
  }
  if (futureExcludedCount > 0) {
    warnings.push(taxableWarning(TAXABLE_INCOME_WARNING_CODES.FUTURE_DATA_EXCLUDED, "low", "Future-dated income activity was excluded.", { count: futureExcludedCount }));
  }

  const reconciliation = await buildFinancialMetricsReconciliation({
    supabase,
    businessId,
    taxYear: context.taxYear,
    asOfDate: context.asOfDate,
    transactionRevenue: round2(grossReceipts + otherBusinessIncome - returnsAndAllowances),
  });
  sourceBreakdown[TAXABLE_INCOME_SOURCES.FINANCIAL_METRICS] = reconciliation.financialMetricsRevenue;

  if (!grossReceipts && !otherBusinessIncome && reconciliation.financialMetricsRevenue > 0) {
    warnings.push(taxableWarning(
      TAXABLE_INCOME_WARNING_CODES.MISSING_REVENUE_SOURCE,
      "high",
      "Financial metrics show revenue, but transaction-level revenue classification is incomplete."
    ));
  }
  if (reconciliation.status === "difference_found") {
    warnings.push(taxableWarning(
      TAXABLE_INCOME_WARNING_CODES.SOURCE_RECONCILIATION_DIFFERENCE,
      "medium",
      "Transaction revenue differs from financial metrics revenue.",
      { difference: reconciliation.difference, differencePercent: reconciliation.differencePercent }
    ));
  }
  if (includeForecast) {
    sourceBreakdown[TAXABLE_INCOME_SOURCES.PROJECTION] = 0;
  }

  const netBusinessRevenue = round2(grossReceipts + otherBusinessIncome - returnsAndAllowances);
  return {
    grossReceipts,
    otherBusinessIncome,
    returnsAndAllowances,
    netBusinessRevenue,
    monthly,
    sourceItems: {
      included: includedSourceItems,
      excluded: excludedSourceItems,
      includedCount: includedSourceItems.length,
      excludedCount: excludedSourceItems.length,
    },
    sourceBreakdown,
    sourceConfidence: warnings.some((w) => w.severity === "high") ? "low" : "medium",
    warnings,
    reconciliation: { ...reconciliation, accountingMethod: accountingMethod || null },
  };
}

function revenueSourceSnapshot(item, { treatment, exclusionReason = null, includedAmount = null } = {}) {
  const row = item?.classification || {};
  const bank = item?.bankTransaction || {};
  const rawAmount = Number(row.book_amount ?? bank.signed_amount ?? 0);
  const transactionDate = item?.transactionDate || row.transaction_date || bank.date || null;
  const metadata = row.metadata || {};
  return {
    classificationId: row.id || null,
    classificationVersion: row.version || row.updated_at || row.created_at || null,
    classificationStatus: row.classification_status || null,
    bankTransactionId: row.transaction_id || bank.id || null,
    plaidTransactionId: bank.plaid_transaction_id || row.plaid_transaction_id || metadata.plaid_transaction_id || null,
    qboTransactionId: row.source_qbo_txn_id || row.qbo_transaction_id || row.qbo_txn_id || metadata.source_qbo_txn_id || metadata.qbo_transaction_id || metadata.qbo_txn_id || null,
    qboAccountId: row.source_qbo_account_id || row.qbo_account_id || metadata.source_qbo_account_id || metadata.qbo_account_id || null,
    transactionDate,
    month: transactionDate ? String(transactionDate).slice(0, 7) : null,
    transactionAmount: Number.isFinite(rawAmount) ? round2(rawAmount) : null,
    includedAmount: includedAmount == null ? null : round2(includedAmount),
    taxCategory: row.tax_category || null,
    ruleCode: row.rule_code || metadata.rule_code || null,
    ruleVersion: row.rule_version || metadata.rule_version || null,
    overrideId: row.override_id || metadata.override_id || null,
    overrideVersion: row.override_version || metadata.override_version || null,
    sourceSystem: row.source_system || metadata.source_system || (bank.id ? "bank_transaction" : null),
    confirmationState: row.classification_status || null,
    treatment,
    exclusionReason,
    sourceLabel: bank.merchant_name || bank.counterparty_name || bank.name || row.description || null,
  };
}

function excludedIncomeReason(row = {}) {
  if (row.tax_category === "transfer") return "transfer_excluded";
  if (row.tax_category === "owner_contribution") return "owner_contribution_excluded";
  if (row.tax_category === "loan_principal") return "loan_proceeds_excluded";
  if (row.tax_category === "credit_card_payment") return "credit_card_payment_excluded";
  if (isBalanceSheetLike(row)) return "balance_sheet_activity_excluded";
  return "excluded_income_category";
}

async function buildFinancialMetricsReconciliation({ supabase, businessId, taxYear, asOfDate, transactionRevenue }) {
  const rows = await fetchFinancialMetrics({ supabase, businessId, taxYear, asOfDate });
  const financialMetricsRevenue = round2(rows.reduce((sum, row) => sum + metricRevenue(row), 0));
  const difference = round2(transactionRevenue - financialMetricsRevenue);
  const differencePercent = financialMetricsRevenue ? round2((difference / financialMetricsRevenue) * 100) : null;
  const status = Math.abs(difference) > Math.max(10, Math.abs(financialMetricsRevenue) * 0.05) ? "difference_found" : "reconciled";
  return {
    transactionRevenue,
    financialMetricsRevenue,
    difference,
    differencePercent,
    status,
    likelyReasons: status === "difference_found"
      ? ["income_classifications_incomplete", "timing_difference", "category_mapping_difference"]
      : [],
  };
}

async function fetchFinancialMetrics({ supabase, businessId, taxYear, asOfDate }) {
  let query = supabase
    .from("financial_metrics")
    .select("*")
    .eq("business_id", businessId);
  if (typeof query.gte === "function") query = query.gte("month", `${taxYear}-01`);
  if (typeof query.lte === "function") query = query.lte("month", asOfDate.slice(0, 7));
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).filter((row) => metricMonth(row)?.startsWith(`${taxYear}-`) && metricMonth(row) <= asOfDate.slice(0, 7));
}

function metricMonth(row) {
  return String(row.month || row.period || row.as_of || row.as_of_date || "").slice(0, 7);
}

function metricRevenue(row) {
  if (row.key && !["revenue", "income", "gross_revenue", "total_revenue"].includes(row.key)) return 0;
  const value = row.revenue ?? row.income ?? row.gross_revenue ?? row.total_revenue ?? row.value ?? 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
