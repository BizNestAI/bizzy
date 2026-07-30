// /src/services/tax/deductions.service.js
/* global process */
// Composes the deductions matrix for the current Tax page. The authoritative
// source is transaction_tax_classifications; expense_totals_monthly remains only
// a bookkeeping comparison/backfill table.

import { computeTaxDeductionsSummary } from "./taxDeductionsEngine.js";
import { toLegacyDeductionsMatrix } from "./taxDeductionsLegacyAdapter.js";
import { normalizeDateOnly, normalizeTaxYear } from "./taxDomain.js";

const USE_MOCK = String(process.env.MOCK_TAX_DEDUCTIONS || process.env.MOCK_TAX || "").toLowerCase() === "true";

/**
 * getDeductionsMatrix({ supabase, businessId, year })
 * Returns:
 * {
 *   meta: { year, generatedAt, source, month_list: ["2025-01", ... "2025-12"], current_month: "2025-09" },
 *   categories: ["Vehicle Expenses", "Contractors", ...],
 *   grid: [
 *     { category, monthly: { "2025-01": 1200, ... }, ytdTotal: 8400 },
 *     ...
 *   ],
 *   totals: { monthly: { "2025-01": 5200, ... }, ytdTotal: 84500 },
 *   series: [
 *     { category:"Vehicle Expenses", data: [1200,900,....(12)] },
 *     ...
 *   ]
 * }
 */
export async function getDeductionsMatrix({ supabase, businessId, year, asOfDate, format = "legacy" }) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw new Error("businessId required");
  const taxYear = normalizeTaxYear(year || new Date().getFullYear());
  if (!taxYear) throw new Error("Invalid tax year");

  if (USE_MOCK) {
    const mock = buildDeterministicMockMatrix({ businessId, year: taxYear, asOfDate });
    return format === "canonical" ? mock.canonical : mock.legacy;
  }

  const canonical = await computeTaxDeductionsSummary({
    supabase,
    businessId,
    taxYear,
    asOfDate: resolveAsOfDate(asOfDate, taxYear),
  });
  return format === "canonical" ? canonical : toLegacyDeductionsMatrix(canonical);
}

/**
 * Upsert monthly expense rollups (used by QBO ingest or manual backfill)
 * payload: [{ month:'2025-01', category:'Vehicle Expenses', amount:1200, source:'qbo' }, ...]
 * NOTE: We store precise amounts; rounding is applied when composing the matrix above.
 */
export async function upsertExpenseTotals({ supabase, businessId, payload = [] }) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw new Error("businessId required");
  if (!Array.isArray(payload) || !payload.length) return { ok: true, count: 0 };

  const rows = payload.map(p => ({
    business_id: businessId,
    month: startOfMonthDate(p.month),
    category: String(p.category || "").trim(),
    amount: Number(p.amount || 0), // keep raw; do not round on write
    source: p.source || "qbo",
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("expense_totals_monthly")
    .upsert(rows, { onConflict: "business_id,month,category" });

  if (error) throw error;
  return { ok: true, count: rows.length };
}

/**
 * (Optional) Bootstrap adapter from account_breakdown if you have monthly snapshots
 * Not used by default, but you can wire this into your QBO ingest task if helpful.
 */
export async function bootstrapFromAccountBreakdown() {
  // Example: read from 'account_breakdown' where account_type in ('Expense','Cost of Goods Sold')
  // Summarize by month/account → map to normalized category.
  // Upsert into expense_totals_monthly.
  // Keeping as a stub because 'account_breakdown' schemas vary across projects.
  return { ok: true, count: 0 };
}

/* ---------------- helpers & mock ---------------- */

function buildMonthList(year) {
  const list = [];
  for (let m = 1; m <= 12; m++) list.push(`${year}-${String(m).padStart(2, "0")}`);
  return list;
}
function startOfMonthDate(yyyymm) {
  const s = String(yyyymm);
  const y = s.slice(0, 4);
  const m = s.slice(5, 7);
  return `${y}-${m}-01`;
}

function resolveAsOfDate(value, taxYear) {
  if (value == null || value === "") return `${taxYear}-12-31`;
  const normalized = normalizeDateOnly(value);
  if (!normalized) throw new Error("Invalid asOfDate");
  return normalized;
}
function buildDeterministicMockMatrix({ businessId, year, asOfDate }) {
  const monthList = buildMonthList(year);
  const categories = [
    { taxCategory: "contract_labor", displayName: "Contract Labor", base: 2800 },
    { taxCategory: "supplies_materials", displayName: "Materials & Supplies", base: 1750 },
    { taxCategory: "vehicle", displayName: "Vehicle Expenses", base: 620 },
  ];
  const canonical = {
    meta: {
      businessId,
      taxYear: year,
      asOfDate: normalizeDateOnly(asOfDate) || `${year}-12-31`,
      generatedAt: new Date().toISOString(),
      source: "mock",
      engineVersion: "tax-deductions-demo",
      isLive: false,
      is_demo: true,
    },
    coverage: {
      eligiblePostedCount: 36,
      classifiedCount: 36,
      confirmedCount: 0,
      autoClassifiedCount: 36,
      needsReviewCount: 0,
      excludedCount: 0,
      classificationCoveragePercent: 100,
      confirmedCoveragePercent: 0,
      bookAmountCovered: 0,
      needsReviewBookAmount: 0,
      warnings: [],
    },
    totals: {
      bookExpenseAmount: 0,
      estimatedDeductibleAmount: 0,
      confirmedDeductibleAmount: 0,
      autoClassifiedDeductibleAmount: 0,
      nondeductibleAmount: 0,
      capitalizableAmount: 0,
      balanceSheetActivityAmount: 0,
      needsReviewAmount: 0,
      excludedAmount: 0,
      byMonth: Object.fromEntries(monthList.map((m) => [m, {
        bookExpenseAmount: 0,
        estimatedDeductibleAmount: 0,
        confirmedDeductibleAmount: 0,
        nondeductibleAmount: 0,
        capitalizableAmount: 0,
        needsReviewAmount: 0,
      }])),
    },
    categories: [],
    comparisons: {
      currentYtdVsPriorYearYtd: { currentAmount: 0, priorAmount: 0, absoluteChange: 0, percentChange: null, comparisonAvailable: false },
      currentMonthVsPriorMonth: { currentAmount: 0, priorAmount: 0, absoluteChange: 0, percentChange: null, comparisonAvailable: false },
    },
    warnings: [{ code: "demo_deductions", severity: "low", message: "Demo deductions are enabled." }],
  };
  for (const category of categories) {
    const monthly = {};
    let total = 0;
    for (let i = 0; i < monthList.length; i++) {
      const amount = Math.round(category.base * (1 + ((i % 4) * 0.04)));
      total += amount;
      canonical.totals.byMonth[monthList[i]].bookExpenseAmount += amount;
      canonical.totals.byMonth[monthList[i]].estimatedDeductibleAmount += amount;
      canonical.totals.byMonth[monthList[i]].autoClassifiedDeductibleAmount = (canonical.totals.byMonth[monthList[i]].autoClassifiedDeductibleAmount || 0) + amount;
      monthly[monthList[i]] = {
        bookExpenseAmount: amount,
        deductibleAmount: amount,
        nondeductibleAmount: 0,
        capitalizableAmount: 0,
        needsReviewAmount: 0,
        transactionCount: 1,
      };
    }
    canonical.categories.push({
      taxCategory: category.taxCategory,
      displayName: category.displayName,
      bookExpenseAmount: total,
      estimatedDeductibleAmount: total,
      confirmedDeductibleAmount: 0,
      autoClassifiedDeductibleAmount: total,
      nondeductibleAmount: 0,
      capitalizableAmount: 0,
      needsReviewAmount: 0,
      transactionCount: 12,
      confirmedCount: 0,
      reviewCount: 0,
      averageDeductiblePercent: 100,
      confidenceLevel: "medium",
      monthly,
      warnings: [],
      topRules: [],
      topBookkeepingCategories: [],
    });
    canonical.totals.bookExpenseAmount += total;
    canonical.totals.estimatedDeductibleAmount += total;
    canonical.totals.autoClassifiedDeductibleAmount += total;
  }
  canonical.coverage.bookAmountCovered = canonical.totals.bookExpenseAmount;
  return { canonical, legacy: toLegacyDeductionsMatrix(canonical) };
}
