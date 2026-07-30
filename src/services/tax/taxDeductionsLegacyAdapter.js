// /src/services/tax/taxDeductionsLegacyAdapter.js

export function toLegacyDeductionsMatrix(canonicalSummary) {
  const monthList = buildMonthList(canonicalSummary.meta.taxYear);
  const grid = (canonicalSummary.categories || []).map((category) => {
    const monthly = {};
    for (const month of monthList) monthly[month] = round0(category.monthly?.[month]?.deductibleAmount || 0);
    return {
      category: category.displayName,
      taxCategory: category.taxCategory,
      monthly,
      ytdTotal: round0(category.estimatedDeductibleAmount),
      bookSpendYtd: round0(category.bookExpenseAmount),
      nondeductibleYtd: round0(category.nondeductibleAmount),
      capitalizableYtd: round0(category.capitalizableAmount),
      needsReviewYtd: round0(category.needsReviewAmount),
      transactionCount: category.transactionCount,
      confidenceLevel: category.confidenceLevel,
      warnings: category.warnings || [],
    };
  });
  const totalsMonthly = {};
  for (const month of monthList) totalsMonthly[month] = round0(canonicalSummary.totals.byMonth?.[month]?.estimatedDeductibleAmount || 0);
  const totals = {
    monthly: totalsMonthly,
    ytdTotal: round0(canonicalSummary.totals.estimatedDeductibleAmount),
    bookSpendYtd: round0(canonicalSummary.totals.bookExpenseAmount),
    nondeductibleYtd: round0(canonicalSummary.totals.nondeductibleAmount),
    capitalizableYtd: round0(canonicalSummary.totals.capitalizableAmount),
    needsReviewYtd: round0(canonicalSummary.totals.needsReviewAmount),
  };
  return {
    meta: {
      ...canonicalSummary.meta,
      year: canonicalSummary.meta.taxYear,
      source: "tax_classifications",
      semantics: "estimated_deductible_amount",
      classification_coverage_percent: canonicalSummary.coverage.classificationCoveragePercent,
      needs_review_amount: canonicalSummary.totals.needsReviewAmount,
      is_legacy_adapter: true,
      month_list: monthList,
      current_month: canonicalSummary.meta.asOfDate.slice(0, 7),
      coverage: canonicalSummary.coverage,
      warnings: canonicalSummary.warnings,
    },
    categories: grid.map((row) => row.category),
    grid,
    totals,
    series: grid.map((row) => ({
      category: row.category,
      taxCategory: row.taxCategory,
      data: monthList.map((month) => row.monthly[month] || 0),
    })),
  };
}

function buildMonthList(year) {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

function round0(n) {
  return Math.round(Number(n || 0));
}
