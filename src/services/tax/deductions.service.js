// /src/services/tax/deductions.service.js
// Composes the matrix for the Deductions page + chart-ready series.
// Pulls from expense_totals_monthly; uses mock if flag active or no data.
// Optionally bootstrap from account_breakdown (see stub).

const USE_MOCK = String(process.env.MOCK_TAX || "").toLowerCase() === "true";

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
export async function getDeductionsMatrix({ supabase, businessId, year }) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw new Error("businessId required");
  year = Number(year || new Date().getFullYear());

  const monthList = buildMonthList(year); // ["2025-01", ...]
  const todayIso = new Date().toISOString().slice(0, 7);

  // 1) Pull real rollups
  const { data: rows, error } = await supabase
    .from("expense_totals_monthly")
    .select("month, category, amount, source")
    .eq("business_id", businessId)
    .gte("month", `${year}-01-01`)
    .lte("month", `${year}-12-31`);

  if (error) throw error;

  const noRealData = !rows?.length;

  // 2) Fallback / mock
  const useMock = USE_MOCK || noRealData;
  const source = useMock ? "mock" : "live";
  const rollups = useMock ? buildMockRows({ year, monthList }) : rows;

  // 3) Compose matrix (rounded to nearest dollar for UI)
  const categoriesSet = new Set(rollups.map(r => r.category));
  const categories = Array.from(categoriesSet).sort();

  const matrix = categories.map(cat => {
    const monthly = {};
    let total = 0;
    for (const m of monthList) {
      const amt = sum(
        rollups
          .filter(r => r.category === cat && isoMonth(r.month) === m)
          .map(r => Number(r.amount || 0))
      );
      const rounded = round0(amt);      // nearest dollar
      monthly[m] = rounded;
      total += rounded;
    }
    return { category: cat, monthly, ytdTotal: round0(total) };
  });

  // 4) Totals row (sum across categories) — rounded
  const totalsMonthly = {};
  for (const m of monthList) {
    totalsMonthly[m] = round0(sum(matrix.map(r => r.monthly[m])));
  }
  const totals = { monthly: totalsMonthly, ytdTotal: round0(sum(Object.values(totalsMonthly))) };

  // 5) Chart series (per category, 12 integers)
  const series = matrix.map(row => ({
    category: row.category,
    data: monthList.map(m => round0(row.monthly[m] || 0)),
  }));

  return {
    meta: {
      year,
      generatedAt: new Date().toISOString(),
      source,
      month_list: monthList,
      current_month: todayIso,
    },
    categories,
    grid: matrix,
    totals,
    series,
  };
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

  const { error, count } = await supabase
    .from("expense_totals_monthly")
    .upsert(rows, { onConflict: "business_id,month,category" });

  if (error) throw error;
  return { ok: true, count: rows.length };
}

/**
 * (Optional) Bootstrap adapter from account_breakdown if you have monthly snapshots
 * Not used by default, but you can wire this into your QBO ingest task if helpful.
 */
export async function bootstrapFromAccountBreakdown({ supabase, businessId, year, categoryMap = {} }) {
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
function isoMonth(d) {
  if (!d) return "";
  const s = String(d);
  return s.length >= 7 ? s.slice(0, 7) : s;
}
function startOfMonthDate(yyyymm) {
  const s = String(yyyymm);
  const y = s.slice(0, 4);
  const m = s.slice(5, 7);
  return `${y}-${m}-01`;
}
function sum(arr) { return arr.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0); }
function round0(n) { return Math.round(Number(n || 0)); } // nearest dollar
function round2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; } // kept for compatibility

function buildMockRows({ year, monthList }) {
  // A handful of construction-relevant categories with gentle seasonality
  const cats = [
    "Vehicle Expenses",
    "Contractors",
    "Meals & Entertainment",
    "Office Supplies",
    "Tools & Equipment",
    "Insurance",
    "Rent",
  ];
  const rows = [];
  for (const cat of cats) {
    for (let i = 0; i < monthList.length; i++) {
      const m = monthList[i];
      // crude seasonal function (busier in spring/summer)
      const base =
        cat === "Contractors" ? 3000 :
        cat === "Vehicle Expenses" ? 900 :
        cat === "Tools & Equipment" ? 700 :
        cat === "Rent" ? 2500 :
        cat === "Insurance" ? 800 :
        cat === "Office Supplies" ? 200 : 350;

      const seasonal = 1 + 0.25 * Math.sin((i / 12) * Math.PI * 2 + Math.PI / 3);
      const amt = Math.max(0, Math.round(base * seasonal + (Math.random() * 120 - 60)));
      rows.push({ month: `${m}-01`, category: cat, amount: amt, source: "mock" });
    }
  }
  return rows;
}
