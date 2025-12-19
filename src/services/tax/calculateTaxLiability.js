/* -------------------------------------------------------------
 * /services/tax/calculateTaxLiability.js
 * -----------------------------------------------------------*/
import { computeSETax, computeTaxFromBrackets } from "./taxLiabilityEngine.js";
import { getStateRule } from "../tax/stateTaxRules.js";
import { syncTaxDeadlinesToCalendar } from "../tax/calendarSync.js";

const USE_MOCK = String(process.env.MOCK_TAX || "").toLowerCase() === "true";

export async function calculateTaxLiability({
  supabase,
  businessId,
  projectionOverride,
  year = new Date().getFullYear(),
  userId, // optional
}) {
  if (!supabase) throw new Error("supabase client (service-role) is required");
  if (!businessId) throw new Error("businessId required");

  // 1) Tax profile
  const taxProfile = await getTaxProfile(supabase, businessId);

  // 2) Accounting series (YTD)
  const { monthly, ytd } = await getAccountingYTD(supabase, businessId, year);

  // --- MOCK SWITCH if no data ---
  if (USE_MOCK || !monthly?.length) {
    return buildMockLiability(year);
  }

  // 3) Apply scenario overrides
  const projected = applyOverrides(monthly, projectionOverride);

  // 4) Config (federal, std deduction, fica, quarterly dates)
  const config = await getTaxConfig(supabase, year, taxProfile?.filing_status || "single");

  // 5) State
  const stateRule = safeGetStateRule(taxProfile?.state);

  // 6) Annual estimate + monthly series
  const { annualEstimate, monthlyTaxSeries } = computeAnnualEstimate({
    series: projected,
    taxProfile,
    config,
    stateRule,
  });

  // 7) Safe harbor
  const safeHarbor = computeSafeHarbor({
    annualEstimate,
    method: taxProfile?.safe_harbor_mode || "110pct_prior",
    priorYearTotalTax: toNumber(taxProfile?.prior_year_total_tax),
  });

  // 8) Payments made
  const payments = await getTaxPayments(supabase, businessId, year);
  const ytdPaid = sum(payments.map((p) => toNumber(p.amount)));

  // 9) Quarterly schedule
  const quarterly = buildQuarterly({
    requiredAnnual: safeHarbor.requiredAnnual,
    config,
    payments,
    year,
  });

  // 10) Cash flow overlay
  const cashFlow = await getCashFlowOverlay(supabase, businessId, year);
  const cashFlowOverlay = markAtRiskMonths(cashFlow, quarterly);

  // 11) Summary
  const ytdEstimated = sum(
    monthlyTaxSeries
      .filter((m) => (m.month || "").startsWith(String(year)))
      .map((m) => m.estTax)
  );
  const balanceDue = Math.max(0, ytdEstimated - ytdPaid);

  // 12) Insights
  const insights = buildInsights({ annualEstimate, ytdEstimated, taxProfile, monthlyTaxSeries });

  // 13) Calendar sync (idempotent)
  try {
    await syncTaxDeadlinesToCalendar?.({ businessId, year, quarterly });
  } catch (e) {
    console.warn("[tax] calendar sync warning:", e?.message || e);
  }

  return {
    meta: { year, generatedAt: new Date().toISOString() },
    summary: {
      annualEstimate: round2(annualEstimate),
      ytdEstimated: round2(ytdEstimated),
      ytdPaid: round2(ytdPaid),
      balanceDue: round2(balanceDue),
    },
    safeHarbor,
    quarterly,
    trend: monthlyTaxSeries,
    cashFlowOverlay,
    insights,
  };
}

/* ---------------- MOCK LIABILITY ---------------- */
function buildMockLiability(year) {
  const monthly = Array.from({ length: 12 }, (_, i) => ({
    month: `${year}-${String(i + 1).padStart(2, "0")}`,
    estTax: 3200 + Math.round(Math.sin(i / 2.5) * 900),
  }));
  const annual = monthly.reduce((s, m) => s + m.estTax, 0);
  const qDue = { 1: `${year}-04-15`, 2: `${year}-06-15`, 3: `${year}-09-15`, 4: `${year + 1}-01-15` };
  const quarterly = [1, 2, 3, 4].map((q) => ({
    quarter: `Q${q}`,
    due: qDue[q],
    amount: 9500,
    paid: 0,
    remaining: 9500,
  }));
  return {
    meta: { year, generatedAt: new Date().toISOString() },
    summary: {
      annualEstimate: annual,
      ytdEstimated: Math.round(annual * 0.65),
      ytdPaid: Math.round(annual * 0.55),
      balanceDue: Math.round(annual * 0.10),
    },
    safeHarbor: { method: "prior_year_100_percent", requiredAnnual: Math.round(annual * 0.95) },
    quarterly,
    trend: monthly,
    cashFlowOverlay: [],
    insights: [
      `You’re projected to owe $${annual.toLocaleString()} this year.`,
      "Tax load increases in Q3—consider adjusting estimates.",
    ],
  };
}

/* ---------------------- data access + logic (unchanged) ---------------------- */

async function getTaxProfile(supabase, businessId) {
  const { data, error } = await supabase
    .from("tax_profiles")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw error;
  return data || {};
}

async function getAccountingYTD(supabase, businessId, year) {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const { data, error } = await supabase
    .from("monthly_metrics")
    .select("month, revenue, expenses, profit, taxes_paid")
    .eq("business_id", businessId)
    .gte("month", start)
    .lte("month", end)
    .order("month", { ascending: true });

  if (error) throw error;
  const monthly = (data || []).map((r) => {
    const m = normalizeMonth(r.month);
    return {
      month: m,
      revenue: toNumber(r.revenue),
      expenses: toNumber(r.expenses),
      profit: toNumber(r.profit),
      taxes_paid: toNumber(r.taxes_paid),
    };
  });

  const ytd = {
    revenue: sum(monthly.map((m) => m.revenue)),
    expenses: sum(monthly.map((m) => m.expenses)),
    profit: sum(monthly.map((m) => m.profit)),
    taxes_paid: sum(monthly.map((m) => m.taxes_paid)),
  };
  return { monthly, ytd };
}

async function getTaxConfig(supabase, year, filingStatus) {
  const { data, error } = await supabase
    .from("tax_config")
    .select("config")
    .eq("year", year)
    .eq("filing_status", filingStatus)
    .maybeSingle();
  if (error) throw error;
  if (!data?.config) return defaultConfig(filingStatus, year);
  const cfg = { ...data.config };
  if (!Array.isArray(cfg.quarterlySchedule) || cfg.quarterlySchedule.length !== 4) {
    cfg.quarterlySchedule = defaultQuarterlySchedule(year);
  }
  return cfg;
}

async function getTaxPayments(supabase, businessId, year) {
  const { data, error } = await supabase
    .from("tax_payments")
    .select("id, payment_date, amount, quarter")
    .eq("business_id", businessId)
    .gte("payment_date", `${year}-01-01`)
    .lte("payment_date", `${year}-12-31`);
  if (error) throw error;
  return data || [];
}

async function getCashFlowOverlay(supabase, businessId, year) {
  const { data, error } = await supabase
    .from("cashflow_forecast")
    .select("month, net_cash")
    .eq("business_id", businessId)
    .gte("month", `${year}-01-01`)
    .lte("month", `${year}-12-31`)
    .order("month", { ascending: true });

  if (error) throw error;

  return (data || []).map((r) => ({
    month: normalizeMonth(r.month),
    netCash: toNumber(r.net_cash),
    atRisk: false,
  }));
}

/* ---------------------- compute helpers (unchanged) ---------------------- */
function computeAnnualEstimate({ series, taxProfile, config, stateRule }) {
  const { qbi_eligible = true, se_tax_applies = true } = taxProfile || {};
  const federalBrackets = config.federalBrackets;
  const standardDeduction = toNumber(config.standardDeduction);
  const fica = config.fica;

  const monthlyTaxSeries = series.map((m) => {
    const profit = Math.max(0, toNumber(m.profit));
    const qbiDeduction = qbi_eligible ? Math.max(0, profit * 0.2) : 0;
    const taxableBase = Math.max(0, profit - standardDeduction / 12 - qbiDeduction / 12);

    const federal = computeTaxFromBrackets(taxableBase, federalBrackets) || 0;
    const seTax = se_tax_applies ? computeSETax(profit * 12, fica) / 12 : 0;

    let state = 0;
    if (stateRule?.flatRate) state = taxableBase * stateRule.flatRate;
    else if (Array.isArray(stateRule?.brackets)) state = computeTaxFromBrackets(taxableBase, stateRule.brackets) || 0;

    const estTax = Math.max(0, federal + seTax + state);
    return { month: m.month, estTax: round2(estTax) };
  });

  const annualEstimate = round2(sum(monthlyTaxSeries.map((m) => m.estTax)));
  return { annualEstimate, monthlyTaxSeries };
}

function computeSafeHarbor({ annualEstimate, method, priorYearTotalTax }) {
  const current90 = 0.9 * annualEstimate;
  const prior110 = priorYearTotalTax ? 1.1 * toNumber(priorYearTotalTax) : Infinity;
  let requiredAnnual = current90;
  let picked = "90pct_current";
  if (method === "110pct_prior" && isFinite(prior110)) {
    requiredAnnual = Math.min(current90, prior110);
    picked = "110pct_prior";
  }
  return {
    method: picked,
    requiredAnnual: round2(requiredAnnual),
    note:
      picked === "110pct_prior"
        ? "Using 110% of prior-year tax safe harbor (or 90% of current if lower)."
        : "Using 90% of current-year estimate safe harbor.",
  };
}

function buildQuarterly({ requiredAnnual, config, payments, year }) {
  const perQuarter = round2(requiredAnnual / 4);
  const schedule = (config.quarterlySchedule || defaultQuarterlySchedule(year)).map((iso, idx) => ({
    quarter: `Q${idx + 1}`,
    due: iso,
    amount: perQuarter,
    paid: round2(sum(payments.filter((p) => toNumber(p.quarter) === idx + 1).map((p) => toNumber(p.amount)))),
  }));
  return schedule.map((q) => ({ ...q, remaining: round2(Math.max(0, q.amount - q.paid)) }));
}

function buildInsights({ annualEstimate, ytdEstimated, taxProfile, monthlyTaxSeries }) {
  const prevHalf = sum(monthlyTaxSeries.slice(0, 6).map((m) => m.estTax));
  const nextHalf = sum(monthlyTaxSeries.slice(6).map((m) => m.estTax));
  const delta = round2(nextHalf - prevHalf);

  const insights = [];
  insights.push(`You’re projected to owe ${fmtUSD(annualEstimate)} this year.`);
  insights.push(
    delta > 0
      ? `Tax load is trending up by ~${fmtUSD(delta)} in the back half of the year. Consider increasing Q3/Q4 estimates.`
      : `Tax load is trending down in the back half of the year.`
  );
  return insights;
}

function applyOverrides(monthly, projectionOverride) {
  if (!projectionOverride?.overrides) return monthly;
  const map = new Map(monthly.map((m) => [m.month, { ...m }]));
  for (const [month, obj] of Object.entries(projectionOverride.overrides)) {
    const existing = map.get(month) || { month, revenue: 0, expenses: 0, profit: 0, taxes_paid: 0 };
    map.set(month, { ...existing, ...obj });
  }
  return Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month));
}

/* ---------------------- helpers & defaults ---------------------- */
function defaultConfig(_filingStatus, year) {
  return {
    federalBrackets: [
      { upTo: 11000, rate: 0.10 },
      { upTo: 44725, rate: 0.12 },
      { upTo: 95375, rate: 0.22 },
      { upTo: 182100, rate: 0.24 },
      { upTo: 231250, rate: 0.32 },
      { upTo: 578125, rate: 0.35 },
      { upTo: null, rate: 0.37 },
    ],
    standardDeduction: 14600,
    fica: { ssWageBase: 168600, ssRate: 0.062, medicareRate: 0.0145 },
    quarterlySchedule: defaultQuarterlySchedule(year),
  };
}
function defaultQuarterlySchedule(year) {
  return [`${year}-04-15`, `${year}-06-15`, `${year}-09-15`, `${year + 1}-01-15`];
}
function safeGetStateRule(state) { try { return getStateRule(state || "") || null; } catch { return null; } }
function normalizeMonth(value) { if (!value) return ""; const s = String(value); if (s.length >= 7 && s[4] === "-") return s.slice(0, 7); return s; }
const toNumber = (n) => (typeof n === "number" ? n : Number(n || 0));
const sum = (arr) => arr.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
const round2 = (n) => Math.round((toNumber(n) + Number.EPSILON) * 100) / 100;
const fmtUSD = (n) => toNumber(n).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
