const TREATMENT_LABELS = {
  fully_deductible: "Deductible",
  partially_deductible: "Partially deductible",
  nondeductible: "Nondeductible",
  capitalizable: "Capitalizable",
  balance_sheet: "Balance sheet",
  needs_review: "Needs review",
  excluded: "Excluded",
};

const STATUS_LABELS = {
  user_confirmed: "Confirmed",
  cpa_confirmed: "CPA confirmed",
  auto_classified: "Auto-classified",
  needs_review: "Needs review",
  excluded: "Excluded",
  unsupported: "Unsupported",
};

export function buildDeductionsWorkspaceViewModel({ overview, filters = {}, currentYear = new Date().getFullYear() } = {}) {
  const dto = overview || {};
  const meta = dto.meta || {};
  const totals = dto.totals || {};
  const coverage = dto.coverage || {};
  const eligible = nullableNumber(coverage.eligiblePostedCount);
  const classified = nullableNumber(coverage.classifiedCount);
  const bookAmountCovered = nullableNumber(coverage.bookAmountCovered);
  const needsReviewBookAmount = nullableNumber(coverage.needsReviewBookAmount);

  return {
    meta: {
      taxYear: meta.taxYear ?? currentYear,
      asOfDate: meta.asOfDate ?? null,
      source: meta.source || "transaction_tax_classifications",
      generatedAt: meta.generatedAt ?? null,
      classificationCoveragePercent: nullableNumber(coverage.classificationCoveragePercent),
      classifiedTransactionCount: classified,
      totalEligibleTransactionCount: eligible,
    },
    summary: {
      confirmedDeductibleAmount: nullableNumber(totals.confirmedDeductibleAmount),
      autoClassifiedDeductibleAmount: nullableNumber(totals.autoClassifiedDeductibleAmount),
      estimatedDeductibleAmount: nullableNumber(totals.estimatedDeductibleAmount),
      nondeductibleAmount: nullableNumber(totals.nondeductibleAmount),
      capitalizableAmount: nullableNumber(totals.capitalizableAmount),
      balanceSheetAmount: nullableNumber(totals.balanceSheetActivityAmount),
      excludedAmount: nullableNumber(totals.excludedAmount),
      needsReviewAmount: nullableNumber(totals.needsReviewAmount),
      needsReviewCount: nullableNumber(coverage.needsReviewCount),
    },
    coverage: {
      amountCoveragePercent: percentOf(bookAmountCovered, addNullable(bookAmountCovered, needsReviewBookAmount)),
      transactionCoveragePercent: nullableNumber(coverage.classificationCoveragePercent),
      confirmedCoveragePercent: nullableNumber(coverage.confirmedCoveragePercent),
      reviewExposurePercent: percentOf(needsReviewBookAmount, addNullable(bookAmountCovered, needsReviewBookAmount)),
      materialReviewExposure: isMaterialReviewExposure(needsReviewBookAmount, totals.estimatedDeductibleAmount),
      confidenceLevel: confidenceFromCoverage(coverage),
    },
    categories: normalizeCategories(dto.categories),
    warnings: normalizeList(dto.warnings),
    actions: actionsForSetup(dto.setupState, coverage),
    setupState: normalizeSetupState(dto.setupState, coverage),
    filters,
  };
}

export function mapDeductionTransactionRow(row = {}) {
  const transactionId = firstValue(row.transactionId, row.transaction_id, row.id);
  const classificationStatus = firstValue(row.classificationStatus, row.classification_status);
  const taxCategoryValue = firstValue(row.taxCategory, row.tax_category);
  const deductibilityStatus = firstValue(row.deductibilityStatus, row.deductibility_status);
  const signedAmount = nullableNumber(firstValue(row.signedAmount, row.signed_amount, row.book_amount));
  const absoluteAmount = nullableNumber(firstValue(row.absoluteAmount, row.absolute_amount)) ?? Math.abs(Number(signedAmount || 0));
  const isUnresolvedFallback = String(classificationStatus || "").toLowerCase() === "needs_review" &&
    String(taxCategoryValue || "").toLowerCase() === "unclassified";
  const hasClassificationAuthority = Boolean(classificationStatus) &&
    !isUnresolvedFallback &&
    !["unclassified", "unsupported"].includes(String(classificationStatus));
  const taxCategory = isUnresolvedFallback ? "unresolved" : hasClassificationAuthority ? taxCategoryValue || "unclassified" : "pending";
  const taxTreatment = isUnresolvedFallback ? "not_determined" : hasClassificationAuthority ? deductibilityStatus || row.taxTreatment || row.tax_treatment || null : "pending_classification";
  return {
    id: transactionId,
    date: firstValue(row.date, row.transactionDate, row.transaction_date) || null,
    vendor: firstValue(row.merchantName, row.merchant_name, row.counterpartyName, row.counterparty_name, row.description) || "Unknown",
    description: firstValue(row.description, row.merchantName, row.merchant_name, row.counterpartyName, row.counterparty_name) || "",
    qboAccountId: firstValue(row.qboAccountId, row.qbo_account_id, row.source_qbo_account_id, row.metadata?.source_qbo_account_id) || null,
    qboAccountName: firstValue(row.qboAccountName, row.qbo_account_name, row.source_qbo_account_name, row.metadata?.source_qbo_account_name) || null,
    qboTxnId: firstValue(row.qboTxnId, row.qbo_txn_id, row.source_qbo_txn_id, row.metadata?.source_qbo_txn_id) || null,
    qboTxnType: firstValue(row.qboTxnType, row.qbo_txn_type, row.source_qbo_txn_type, row.metadata?.source_qbo_txn_type) || null,
    bookAccount: firstValue(row.qboAccountName, row.qbo_account_name, row.source_qbo_account_name, row.metadata?.source_qbo_account_name) || "Unmapped QuickBooks account",
    amount: absoluteAmount,
    signedAmount,
    taxCategory,
    taxCategoryLabel: isUnresolvedFallback ? "Unresolved" : hasClassificationAuthority ? labelize(taxCategoryValue || "unclassified") : "Pending",
    taxTreatment,
    taxTreatmentLabel: hasClassificationAuthority
      ? TREATMENT_LABELS[deductibilityStatus] || TREATMENT_LABELS[row.taxTreatment] || labelize(deductibilityStatus || row.taxTreatment)
      : isUnresolvedFallback
        ? "Not determined"
      : "Pending classification",
    deductiblePercent: nullableNumber(firstValue(row.deductiblePercent, row.deductible_percent)),
    deductibleAmount: nullableNumber(firstValue(row.deductibleAmount, row.deductible_amount)),
    confidenceScore: nullableNumber(firstValue(row.confidenceScore, row.confidence_score)),
    confidenceLevel: firstValue(row.confidenceLevel, row.confidence_level) || "unavailable",
    classificationSource: firstValue(row.classificationSource, row.classification_source, row.sourceType, row.source_type, row.source) || null,
    matchedRuleCode: firstValue(row.matchedRuleCode, row.matched_rule_code, row.ruleCode, row.rule_code) || null,
    ruleVersion: firstValue(row.ruleVersion, row.rule_version) || null,
    status: row.override?.hasOverride ? "overridden" : isUnresolvedFallback ? "unclassified" : hasClassificationAuthority ? classificationStatus : "unclassified",
    statusLabel: row.override?.hasOverride ? "Overridden" : isUnresolvedFallback ? "Needs classification" : hasClassificationAuthority ? STATUS_LABELS[classificationStatus] || labelize(classificationStatus) : "Unclassified",
    requiresReview: hasClassificationAuthority && (row.requiresReview === true || row.requires_review === true),
    warnings: normalizeList(row.warnings),
    raw: row,
  };
}

function normalizeCategories(categories) {
  return normalizeList(categories).map((category) => {
    const needsReviewAmount = nullableNumber(category.needsReviewAmount);
    const estimated = nullableNumber(category.estimatedDeductibleAmount);
    const confirmed = nullableNumber(category.confirmedDeductibleAmount);
    const auto = nullableNumber(category.autoClassifiedDeductibleAmount);
    return {
      categoryKey: category.taxCategory || category.categoryKey || "unclassified",
      categoryLabel: category.displayName || labelize(category.taxCategory || category.categoryKey || "unclassified"),
      transactionCount: nullableNumber(category.transactionCount),
      confirmedDeductibleAmount: confirmed,
      autoClassifiedDeductibleAmount: auto,
      estimatedDeductibleAmount: estimated,
      nondeductibleAmount: nullableNumber(category.nondeductibleAmount),
      capitalizableAmount: nullableNumber(category.capitalizableAmount),
      balanceSheetAmount: nullableNumber(category.balanceSheetActivityAmount),
      excludedAmount: nullableNumber(category.excludedAmount),
      needsReviewAmount,
      needsReviewCount: nullableNumber(category.reviewCount),
      confidenceLevel: category.confidenceLevel || confidenceFromCategory(category),
      status: categoryStatus({ needsReviewAmount, estimated, confirmed }),
      topRules: normalizeList(category.topRules),
      warnings: normalizeList(category.warnings),
    };
  });
}

function categoryStatus({ needsReviewAmount, estimated, confirmed }) {
  if (needsReviewAmount > 0) return "needs_review";
  if (confirmed != null && confirmed > 0 && (estimated == null || confirmed >= estimated)) return "confirmed";
  if (estimated != null && estimated > 0) return "estimated";
  return "classified";
}

function normalizeSetupState(setupState, coverage) {
  const raw = typeof setupState === "object" && setupState ? setupState : {};
  return {
    state: raw.state || raw.code || (coverage?.classifiedCount ? "ready" : "classifications_missing"),
    message: raw.message || setupMessage(raw.state || raw.code, coverage),
    warnings: normalizeList(raw.warnings),
  };
}

function actionsForSetup(setupState, coverage) {
  const state = setupState?.state || setupState?.code;
  if (state === "no_posted_transactions") return [{ code: "refresh_books", label: "Refresh books" }];
  if (state === "classifications_missing" || !coverage?.classifiedCount) return [{ code: "run_classification", label: "Run tax classification" }];
  if (state === "needs_review" || coverage?.needsReviewCount > 0) return [{ code: "review_transactions", label: "Review transactions" }];
  return [];
}

function setupMessage(state, coverage) {
  if (state === "no_posted_transactions" || (!coverage?.eligiblePostedCount && !coverage?.classifiedCount)) {
    return "Bizzi does not have posted QuickBooks transactions for this tax year yet.";
  }
  if (state === "classifications_missing") return "Run tax classification to estimate deductible treatment.";
  if (state === "needs_review") return "Some tax classifications need review before they can be treated as confirmed.";
  return null;
}

function confidenceFromCoverage(coverage) {
  const review = nullableNumber(coverage?.needsReviewCount);
  const pct = nullableNumber(coverage?.classificationCoveragePercent);
  if (pct == null) return "unavailable";
  if (review > 0 || pct < 70) return "low";
  if (pct < 95) return "medium";
  return "high";
}

function confidenceFromCategory(category) {
  if (category.reviewCount > 0 || category.needsReviewAmount > 0) return "low";
  if (category.confirmedCount && category.confirmedCount === category.transactionCount) return "high";
  return "medium";
}

function isMaterialReviewExposure(needsReviewAmount, estimatedDeductibleAmount) {
  if (needsReviewAmount == null || needsReviewAmount <= 0) return false;
  if (estimatedDeductibleAmount == null || estimatedDeductibleAmount <= 0) return true;
  return needsReviewAmount / estimatedDeductibleAmount >= 0.15;
}

function percentOf(numerator, denominator) {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return Math.round((Number(numerator) / Number(denominator)) * 1000) / 10;
}

function addNullable(a, b) {
  if (a == null && b == null) return null;
  return Number(a || 0) + Number(b || 0);
}

function firstValue(...values) {
  return values.find((value) => value != null && value !== "");
}

function nullableNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}

function labelize(value) {
  if (!value) return "Unavailable";
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default buildDeductionsWorkspaceViewModel;
