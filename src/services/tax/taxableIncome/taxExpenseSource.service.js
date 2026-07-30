// /src/services/tax/taxableIncome/taxExpenseSource.service.js
import { DEDUCTIBILITY_STATUSES, TAX_CLASSIFICATION_STATUSES } from "../taxDomain.js";
import {
  TAXABLE_INCOME_WARNING_CODES,
  round2,
  taxableWarning,
} from "./taxableIncomeDomain.js";
import {
  addMonthly,
  absoluteBookAmount,
  buildTaxableIncomeContext,
  emptyMonthly,
  isAutoClassification,
  isConfirmedClassification,
  isExpenseOutflow,
  isNeedsReviewClassification,
  loadAnnualClassificationItems,
} from "./taxableIncomeSourceUtils.js";

const COGS_CATEGORIES = new Set(["cost_of_goods_sold", "cogs", "job_materials_cogs", "subcontractor_cogs"]);

export async function getTaxExpenseSummary({
  supabase,
  businessId,
  taxYear,
  asOfDate,
  accountingMethod,
} = {}) {
  const context = buildTaxableIncomeContext({ supabase, businessId, taxYear, asOfDate });
  const { items, excludedItems, futureExcludedCount } = await loadAnnualClassificationItems({ ...context, includeExcluded: true });
  const monthly = emptyMonthly(context.taxYear, {
    costOfGoodsSold: 0,
    deductibleOperatingExpenses: 0,
    estimatedDeductibleExpenses: 0,
    confirmedDeductibleExpenses: 0,
    nondeductibleBookExpenses: 0,
    capitalizableExpenditures: 0,
    balanceSheetActivity: 0,
    needsReviewAmount: 0,
  });
  const categoryMap = new Map();
  const warnings = [];
  let costOfGoodsSold = 0;
  let deductibleOperatingExpenses = 0;
  let confirmedDeductibleExpenses = 0;
  let autoClassifiedDeductibleExpenses = 0;
  let nondeductibleBookExpenses = 0;
  let capitalizableExpenditures = 0;
  let balanceSheetActivity = 0;
  let needsReviewAmount = 0;
  const includedSourceItems = [];
  const excludedSourceItems = [...(excludedItems || []).map((item) => expenseSourceSnapshot(item, {
    treatment: "excluded",
    exclusionReason: item.exclusionReason,
    deductibleAmount: 0,
    nondeductibleAmount: 0,
    capitalizableAmount: 0,
  })).filter(Boolean)];

  for (const item of items) {
    const row = item.classification;
    if (!isExpenseOutflow(item)) continue;
    if (row.classification_status === TAX_CLASSIFICATION_STATUSES.EXCLUDED) {
      excludedSourceItems.push(expenseSourceSnapshot(item, {
        treatment: "excluded",
        exclusionReason: excludedExpenseReason(row),
        deductibleAmount: 0,
        nondeductibleAmount: 0,
        capitalizableAmount: 0,
      }));
      continue;
    }
    const absBook = absoluteBookAmount(item);
    const review = isNeedsReviewClassification(row);
    const cogs = isCogs(row);
    const confirmed = isConfirmedClassification(row);
    const auto = isAutoClassification(row);
    const deductible = review ? 0 : Number(row.deductible_amount || 0);
    const nondeductible = review ? 0 : Number(row.nondeductible_amount || 0);
    const capitalizable = review ? 0 : Number(row.capitalizable_amount || 0);
    const balanceSheet = row.deductibility_status === DEDUCTIBILITY_STATUSES.BALANCE_SHEET ? absBook : 0;

    if (review) needsReviewAmount = round2(needsReviewAmount + absBook);
    if (cogs && !review) costOfGoodsSold = round2(costOfGoodsSold + deductible);
    if (!cogs && !review && row.deductibility_status !== DEDUCTIBILITY_STATUSES.BALANCE_SHEET && row.deductibility_status !== DEDUCTIBILITY_STATUSES.CAPITALIZABLE) {
      deductibleOperatingExpenses = round2(deductibleOperatingExpenses + deductible);
    }
    if (confirmed && !review) confirmedDeductibleExpenses = round2(confirmedDeductibleExpenses + deductible);
    if (auto && !review) autoClassifiedDeductibleExpenses = round2(autoClassifiedDeductibleExpenses + deductible);
    nondeductibleBookExpenses = round2(nondeductibleBookExpenses + nondeductible);
    capitalizableExpenditures = round2(capitalizableExpenditures + capitalizable);
    balanceSheetActivity = round2(balanceSheetActivity + balanceSheet);

    addMonthly(monthly, item.month, {
      costOfGoodsSold: cogs && !review ? deductible : 0,
      deductibleOperatingExpenses: !cogs && !review ? deductible : 0,
      estimatedDeductibleExpenses: !review ? deductible : 0,
      confirmedDeductibleExpenses: confirmed && !review ? deductible : 0,
      nondeductibleBookExpenses: nondeductible,
      capitalizableExpenditures: capitalizable,
      balanceSheetActivity: balanceSheet,
      needsReviewAmount: review ? absBook : 0,
    });
    addCategory(categoryMap, row, {
      bookAmount: absBook,
      deductible,
      nondeductible,
      capitalizable,
      balanceSheet,
      needsReview: review ? absBook : 0,
      count: 1,
    });
    includedSourceItems.push(expenseSourceSnapshot(item, {
      treatment: deductionTreatment({ row, review, confirmed, auto, capitalizable, balanceSheet }),
      exclusionReason: review ? "needs_review_excluded_from_deduction" : null,
      deductibleAmount: deductible,
      nondeductibleAmount: nondeductible,
      capitalizableAmount: capitalizable,
      immediateDeductionAmount: row.deductibility_status === DEDUCTIBILITY_STATUSES.CAPITALIZABLE ? deductible : deductible,
      isCogs: cogs,
      confirmed,
      auto,
      needsReview: review,
    }));
  }

  if (needsReviewAmount > 0) {
    warnings.push(taxableWarning(TAXABLE_INCOME_WARNING_CODES.HIGH_NEEDS_REVIEW_AMOUNT, "medium", "Some expense activity still needs tax review.", { amount: needsReviewAmount }));
  }
  if (futureExcludedCount > 0) {
    warnings.push(taxableWarning(TAXABLE_INCOME_WARNING_CODES.FUTURE_DATA_EXCLUDED, "low", "Future-dated expense activity was excluded.", { count: futureExcludedCount }));
  }
  if (capitalizableExpenditures > 0) {
    warnings.push(taxableWarning(TAXABLE_INCOME_WARNING_CODES.MISSING_DEPRECIATION_DATA, "medium", "Capitalizable purchases are not deducted until depreciation, Section 179, or bonus depreciation is separately recorded."));
  }

  return {
    costOfGoodsSold,
    deductibleOperatingExpenses,
    estimatedDeductibleExpenses: round2(costOfGoodsSold + deductibleOperatingExpenses),
    confirmedDeductibleExpenses,
    autoClassifiedDeductibleExpenses,
    nondeductibleBookExpenses,
    capitalizableExpenditures,
    balanceSheetActivity,
    needsReviewAmount,
    monthly,
    categoryBreakdown: Array.from(categoryMap.values()).sort((a, b) => String(a.taxCategory).localeCompare(String(b.taxCategory))),
    sourceItems: {
      included: includedSourceItems,
      excluded: excludedSourceItems,
      includedCount: includedSourceItems.length,
      excludedCount: excludedSourceItems.length,
    },
    sourceConfidence: needsReviewAmount > 0 ? "medium" : "high",
    warnings,
    accountingMethod: accountingMethod || null,
  };
}

function isCogs(row) {
  if (COGS_CATEGORIES.has(row.tax_category)) return true;
  const treatment = row.tax_treatment || {};
  if (treatment.type === "cogs" || treatment.componentType === "cost_of_goods_sold") return true;
  const accountType = String(row.metadata?.qbo_account_type || row.metadata?.source_qbo_account_type || "").toLowerCase();
  return accountType.includes("cost of goods");
}

function addCategory(map, row, contribution) {
  const key = row.tax_category || "unclassified";
  if (!map.has(key)) {
    map.set(key, {
      taxCategory: key,
      bookAmount: 0,
      deductibleAmount: 0,
      nondeductibleAmount: 0,
      capitalizableAmount: 0,
      balanceSheetActivity: 0,
      needsReviewAmount: 0,
      transactionCount: 0,
    });
  }
  const target = map.get(key);
  target.bookAmount = round2(target.bookAmount + contribution.bookAmount);
  target.deductibleAmount = round2(target.deductibleAmount + contribution.deductible);
  target.nondeductibleAmount = round2(target.nondeductibleAmount + contribution.nondeductible);
  target.capitalizableAmount = round2(target.capitalizableAmount + contribution.capitalizable);
  target.balanceSheetActivity = round2(target.balanceSheetActivity + contribution.balanceSheet);
  target.needsReviewAmount = round2(target.needsReviewAmount + contribution.needsReview);
  target.transactionCount += contribution.count;
}

function expenseSourceSnapshot(item, {
  treatment,
  exclusionReason = null,
  deductibleAmount = null,
  nondeductibleAmount = null,
  capitalizableAmount = null,
  immediateDeductionAmount = null,
  isCogs = false,
  confirmed = false,
  auto = false,
  needsReview = false,
} = {}) {
  const row = item?.classification || {};
  const bank = item?.bankTransaction || {};
  const metadata = row.metadata || {};
  const rawGross = Math.abs(Number(row.book_amount ?? bank.signed_amount ?? 0));
  const grossAmount = Number.isFinite(rawGross) ? round2(rawGross) : 0;
  const transactionDate = item?.transactionDate || row.transaction_date || bank.date || null;
  const deductiblePercent = row.deductible_percent == null ? null : Number(row.deductible_percent);
  return {
    classificationId: row.id || null,
    classificationVersion: row.version || row.updated_at || row.created_at || null,
    classificationStatus: row.classification_status || null,
    bankTransactionId: row.transaction_id || bank.id || null,
    plaidTransactionId: bank.plaid_transaction_id || row.plaid_transaction_id || metadata.plaid_transaction_id || null,
    qboTransactionId: row.source_qbo_txn_id || row.qbo_transaction_id || row.qbo_txn_id || metadata.source_qbo_txn_id || metadata.qbo_transaction_id || metadata.qbo_txn_id || null,
    qboAccountId: row.source_qbo_account_id || row.qbo_account_id || metadata.source_qbo_account_id || metadata.qbo_account_id || null,
    sourceDate: transactionDate,
    month: transactionDate ? String(transactionDate).slice(0, 7) : null,
    grossAmount,
    deductiblePercent: Number.isFinite(deductiblePercent) ? deductiblePercent : null,
    deductibleAmount: deductibleAmount == null ? null : round2(deductibleAmount),
    nondeductibleAmount: nondeductibleAmount == null ? null : round2(nondeductibleAmount),
    capitalizableAmount: capitalizableAmount == null ? null : round2(capitalizableAmount),
    immediateDeductionAmount: immediateDeductionAmount == null ? null : round2(immediateDeductionAmount),
    taxCategory: row.tax_category || null,
    deductibilityStatus: row.deductibility_status || null,
    ruleId: row.rule_id || metadata.rule_id || null,
    ruleCode: row.rule_code || metadata.rule_code || null,
    ruleVersion: row.rule_version || metadata.rule_version || null,
    confirmationStatus: row.classification_status || null,
    confidenceScore: row.confidence_score == null ? null : Number(row.confidence_score),
    classificationMethod: row.classification_method || metadata.classification_method || null,
    reviewStatus: needsReview ? "needs_review" : "included",
    overrideId: row.override_id || metadata.override_id || null,
    overrideVersion: row.override_version || metadata.override_version || null,
    previousTreatment: metadata.previous_tax_treatment || metadata.previousTreatment || null,
    newTreatment: metadata.new_tax_treatment || metadata.newTreatment || null,
    changedBy: metadata.override_changed_by || metadata.changedBy || null,
    changedAt: metadata.override_changed_at || metadata.changedAt || null,
    sourceSystem: row.source_system || metadata.source_system || (bank.id ? "bank_transaction" : null),
    sourceLabel: bank.merchant_name || bank.counterparty_name || bank.name || row.description || null,
    treatment,
    exclusionReason,
    isCogs,
    confirmed,
    auto,
    needsReview,
  };
}

function deductionTreatment({ row, review, confirmed, auto, capitalizable, balanceSheet }) {
  if (review) return "needs_review";
  if (balanceSheet) return "excluded";
  if (row.deductibility_status === DEDUCTIBILITY_STATUSES.CAPITALIZABLE || capitalizable > 0) return "capitalized";
  if (confirmed) return "confirmed";
  if (auto) return "estimated";
  return "calculated";
}

function excludedExpenseReason(row = {}) {
  if (row.tax_category === "transfer") return "transfer_excluded";
  if (row.tax_category === "owner_draw" || row.tax_category === "owner_distribution") return "owner_activity_excluded";
  if (row.tax_category === "loan_principal") return "loan_principal_excluded";
  if (row.deductibility_status === DEDUCTIBILITY_STATUSES.BALANCE_SHEET) return "balance_sheet_activity_excluded";
  return "classification_excluded";
}
