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
  auto_classified: "Estimated",
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
  return {
    id: row.transactionId,
    date: row.date || null,
    vendor: row.merchantName || row.counterpartyName || row.description || "Unknown",
    description: row.description || row.merchantName || row.counterpartyName || "",
    qboAccountId: row.qboAccountId || null,
    qboAccountName: row.qboAccountName || null,
    qboTxnId: row.qboTxnId || null,
    qboTxnType: row.qboTxnType || null,
    bookAccount: row.qboAccountName || "Unmapped QuickBooks account",
    amount: nullableNumber(row.absoluteAmount ?? Math.abs(Number(row.signedAmount))),
    signedAmount: nullableNumber(row.signedAmount),
    taxCategory: row.taxCategory || "unclassified",
    taxCategoryLabel: labelize(row.taxCategory || "unclassified"),
    taxTreatment: row.deductibilityStatus || row.taxTreatment || null,
    taxTreatmentLabel: TREATMENT_LABELS[row.deductibilityStatus] || TREATMENT_LABELS[row.taxTreatment] || labelize(row.deductibilityStatus || row.taxTreatment),
    deductiblePercent: nullableNumber(row.deductiblePercent),
    deductibleAmount: nullableNumber(row.deductibleAmount),
    confidenceScore: nullableNumber(row.confidenceScore),
    confidenceLevel: row.confidenceLevel || "unavailable",
    status: row.override?.hasOverride ? "overridden" : row.classificationStatus || "unsupported",
    statusLabel: row.override?.hasOverride ? "Overridden" : STATUS_LABELS[row.classificationStatus] || labelize(row.classificationStatus),
    requiresReview: row.requiresReview === true,
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
