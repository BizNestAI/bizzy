// /src/services/tax/taxDeductionsReconciliation.js
import { computeTaxDeductionsSummary } from "./taxDeductionsEngine.js";
import { normalizeDateOnly, normalizeTaxYear } from "./taxDomain.js";
import { validationError } from "./taxErrors.js";

export async function compareTaxClassificationsToBookkeepingRollups({
  supabase,
  businessId,
  taxYear,
  asOfDate,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const year = normalizeTaxYear(taxYear);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  const cutoff = asOfDate == null || asOfDate === "" ? `${year}-12-31` : normalizeDateOnly(asOfDate);
  if (!cutoff) throw validationError("invalid_as_of_date", "asOfDate must be YYYY-MM-DD.", { field: "asOfDate" });
  const summary = await computeTaxDeductionsSummary({ supabase, businessId, taxYear: year, asOfDate: cutoff, includeComparisons: false });
  const bookkeeping = await loadBookkeepingRollups({ supabase, businessId, taxYear: year, asOfDate: cutoff });
  const bookkeepingExpenseTotal = round2(bookkeeping.rows.reduce((sum, row) => sum + Number(row.amount || 0), 0));
  const classifiedBookExpenseTotal = summary.totals.bookExpenseAmount;
  const difference = round2(classifiedBookExpenseTotal - bookkeepingExpenseTotal);
  const differencePercent = bookkeepingExpenseTotal ? round2((difference / bookkeepingExpenseTotal) * 100) : null;
  return {
    bookkeepingExpenseTotal,
    classifiedBookExpenseTotal,
    difference,
    differencePercent,
    status: Math.abs(difference) < 1 ? "in_balance" : "difference_found",
    likelyReasons: likelyReasons({ summary, bookkeepingExpenseTotal, classifiedBookExpenseTotal }),
    monthlyDifferences: compareMonthly(summary, bookkeeping.rows, year),
    categoryDifferences: compareCategories(summary, bookkeeping.rows),
  };
}

async function loadBookkeepingRollups({ supabase, businessId, taxYear, asOfDate }) {
  const { data, error } = await supabase
    .from("expense_totals_monthly")
    .select("month,category,amount,source")
    .eq("business_id", businessId)
    .gte("month", `${taxYear}-01-01`)
    .lte("month", `${asOfDate.slice(0, 7)}-31`);
  if (error) throw error;
  return { rows: data || [] };
}

function likelyReasons({ summary, bookkeepingExpenseTotal, classifiedBookExpenseTotal }) {
  const reasons = [];
  if (!summary.coverage.classifiedCount) reasons.push("classifications_not_run");
  if (summary.totals.needsReviewAmount > 0) reasons.push("needs_review_transactions");
  if (summary.totals.nondeductibleAmount > 0) reasons.push("non-deductible_book_expenses");
  if (summary.totals.capitalizableAmount > 0) reasons.push("capitalizable_book_expenses");
  if (summary.totals.balanceSheetActivityAmount > 0) reasons.push("balance_sheet_activity_in_expense_rollup");
  if (Math.abs(bookkeepingExpenseTotal - classifiedBookExpenseTotal) > 1) reasons.push("category_mapping_difference");
  return reasons;
}

function compareMonthly(summary, bookkeepingRows, year) {
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  return Object.fromEntries(months.map((month) => {
    const bookkeeping = round2(bookkeepingRows.filter((row) => String(row.month || "").slice(0, 7) === month).reduce((sum, row) => sum + Number(row.amount || 0), 0));
    const classified = summary.totals.byMonth[month]?.bookExpenseAmount || 0;
    return [month, { bookkeepingExpenseTotal: bookkeeping, classifiedBookExpenseTotal: classified, difference: round2(classified - bookkeeping) }];
  }));
}

function compareCategories(summary, bookkeepingRows) {
  const byCategory = new Map();
  for (const row of bookkeepingRows) {
    const key = String(row.category || "Uncategorized");
    byCategory.set(key, round2((byCategory.get(key) || 0) + Number(row.amount || 0)));
  }
  const result = {};
  for (const category of summary.categories) {
    result[category.displayName] = {
      bookkeepingExpenseTotal: byCategory.get(category.displayName) || 0,
      classifiedBookExpenseTotal: category.bookExpenseAmount,
      difference: round2(category.bookExpenseAmount - (byCategory.get(category.displayName) || 0)),
    };
  }
  for (const [category, amount] of byCategory.entries()) {
    if (!result[category]) result[category] = { bookkeepingExpenseTotal: amount, classifiedBookExpenseTotal: 0, difference: round2(0 - amount) };
  }
  return result;
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}
