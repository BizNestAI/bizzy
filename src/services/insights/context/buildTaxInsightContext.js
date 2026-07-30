import { compareTaxRuns } from "../../tax/runs/taxRunComparison.service.js";

const RUN_STATUSES = ["completed", "partial"];

export async function buildTaxInsightContext({ supabase, businessId, taxYear = null, now = new Date() } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) return emptyContext({ businessId, taxYear, now });

  const runs = await loadRuns({ supabase, businessId, taxYear });
  const currentRun = runs[0] || null;
  const previousRun = runs.find((row) => row.id !== currentRun?.id) || null;
  const resolvedTaxYear = Number(taxYear || currentRun?.tax_year || now.getUTCFullYear());
  const profile = await loadProfile({ supabase, businessId, taxYear: resolvedTaxYear });
  const payments = await loadPayments({ supabase, businessId, taxYear: resolvedTaxYear });
  const deductionsCoverage = await loadDeductionsCoverage({ supabase, businessId, taxYear: resolvedTaxYear, currentRun });

  const summary = extractSection(currentRun, "summary");
  const reserve = extractSection(currentRun, "reserve");
  const safeHarbor = extractSection(currentRun, "safeHarbor") || extractSection(currentRun, "safe_harbor");
  const confidence = extractSection(currentRun, "confidence");
  const readiness = extractSection(currentRun, "readiness") || extractSection(currentRun, "setupState") || {};
  const deadlines = normalizeDeadlines(extractSection(currentRun, "deadlines"));
  const warnings = normalizeArray(currentRun?.warnings || extractSection(currentRun, "warnings"));
  const sourceFreshness = currentRun?.source_freshness || extractSection(currentRun, "sourceFreshness") || {};
  const explanationSummary = extractSection(currentRun, "explanationSummary") || {};
  const changes = previousRun && currentRun ? compareTaxRuns({ previousRun, currentRun }) : null;

  return {
    businessId,
    userId: currentRun?.user_id || profile?.user_id || profile?.created_by || null,
    taxYear: resolvedTaxYear,
    currentRun,
    previousRun,
    changes,
    readiness,
    profile,
    summary,
    payments: normalizePayments({ payments, currentRun }),
    safeHarbor,
    reserve,
    deadlines,
    deductionsCoverage,
    confidence,
    warnings,
    sourceFreshness,
    explanationSummary,
    generatedAt: now.toISOString(),
  };
}

async function loadRuns({ supabase, businessId, taxYear }) {
  if (supabase.store) {
    return (supabase.store.tax_calculation_runs || [])
      .filter((row) => row.business_id === businessId)
      .filter((row) => !taxYear || Number(row.tax_year) === Number(taxYear))
      .filter((row) => RUN_STATUSES.includes(String(row.status || "").toLowerCase()))
      .sort((a, b) => new Date(b.completed_at || b.created_at || 0) - new Date(a.completed_at || a.created_at || 0))
      .slice(0, 2);
  }
  let query = supabase
    .from("tax_calculation_runs")
    .select("*")
    .eq("business_id", businessId)
    .in("status", RUN_STATUSES)
    .order("completed_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(2);
  if (taxYear) query = query.eq("tax_year", taxYear);
  const { data, error } = await query;
  if (error) return [];
  return Array.isArray(data) ? data : [];
}

async function loadProfile({ supabase, businessId, taxYear }) {
  if (supabase.store) {
    return (supabase.store.tax_profiles || [])
      .filter((row) => row.business_id === businessId && Number(row.tax_year) === Number(taxYear))
      .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))[0] || null;
  }
  const { data } = await supabase
    .from("tax_profiles")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .order("updated_at", { ascending: false })
    .limit(1);
  return Array.isArray(data) ? data[0] || null : null;
}

async function loadPayments({ supabase, businessId, taxYear }) {
  if (supabase.store) {
    return (supabase.store.tax_payments || []).filter((row) => row.business_id === businessId && Number(row.tax_year) === Number(taxYear));
  }
  const { data } = await supabase
    .from("tax_payments")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .limit(200);
  return Array.isArray(data) ? data : [];
}

async function loadDeductionsCoverage({ supabase, businessId, taxYear, currentRun }) {
  const fromRun = extractSection(currentRun, "deductionsCoverage") || extractSection(currentRun, "deductions")?.coverage || null;
  if (fromRun) return normalizeCoverage(fromRun);

  const rows = supabase.store
    ? (supabase.store.transaction_tax_classifications || [])
        .filter((row) => row.business_id === businessId && Number(row.tax_year) === Number(taxYear))
    : await selectClassifications({ supabase, businessId, taxYear });

  if (!rows.length) return { needsReviewAmount: null, needsReviewCount: 0, classifiedTransactionCount: 0, totalEligibleTransactionCount: 0 };
  const needsReviewRows = rows.filter((row) => String(row.status || row.classification_status || "").toLowerCase() === "needs_review");
  const needsReviewAmount = needsReviewRows.reduce((sum, row) => sum + absNumber(row.needs_review_amount ?? row.amount ?? row.gross_amount), 0);
  return {
    needsReviewAmount,
    needsReviewCount: needsReviewRows.length,
    classifiedTransactionCount: rows.length - needsReviewRows.length,
    totalEligibleTransactionCount: rows.length,
    classificationCoveragePercent: rows.length ? Math.round(((rows.length - needsReviewRows.length) / rows.length) * 100) : null,
  };
}

async function selectClassifications({ supabase, businessId, taxYear }) {
  try {
    const { data } = await supabase
      .from("transaction_tax_classifications")
      .select("*")
      .eq("business_id", businessId)
      .eq("tax_year", taxYear)
      .limit(1000);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function extractSection(run, key) {
  if (!run) return null;
  return run[key] ?? run.metadata?.[key] ?? run.result?.[key] ?? run.calculation_result?.[key] ?? run.summary_json?.[key] ?? null;
}

function normalizePayments({ payments, currentRun }) {
  const section = extractSection(currentRun, "payments") || {};
  const recent = [...payments].sort((a, b) => new Date(b.payment_date || b.date || b.created_at || 0) - new Date(a.payment_date || a.date || a.created_at || 0))[0] || null;
  return {
    ...section,
    rows: payments,
    recentPayment: recent,
    totalPaidAndWithheldYtd: numberOrNull(section.totalPaidAndWithheldYtd ?? section.total_paid_and_withheld_ytd ?? section.totalApplied),
  };
}

function normalizeCoverage(value) {
  return {
    ...value,
    needsReviewAmount: numberOrNull(value.needsReviewAmount ?? value.needs_review_amount ?? value.reviewExposureAmount),
    needsReviewCount: numberOrNull(value.needsReviewCount ?? value.needs_review_count ?? value.reviewExposureCount),
    classificationCoveragePercent: numberOrNull(value.classificationCoveragePercent ?? value.classification_coverage_percent),
  };
}

function normalizeDeadlines(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : Array.isArray(value?.upcoming) ? value.upcoming : [];
  return rows.map((row) => ({
    id: row.id || row.key || null,
    name: row.name || row.label || row.type || "Tax deadline",
    jurisdiction: row.jurisdiction || null,
    dueDate: row.dueDate || row.due_date || row.date || row.due_on || null,
    amount: numberOrNull(row.amount ?? row.paymentAmount ?? row.payment_amount),
    status: row.status || null,
    type: row.type || row.metadata?.type || null,
  }));
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function absNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

function emptyContext({ businessId, taxYear, now }) {
  return {
    businessId,
    userId: null,
    taxYear: taxYear || now.getUTCFullYear(),
    currentRun: null,
    previousRun: null,
    changes: null,
    readiness: {},
    summary: {},
    payments: { rows: [] },
    safeHarbor: {},
    reserve: {},
    deadlines: [],
    deductionsCoverage: {},
    confidence: {},
    warnings: [],
    sourceFreshness: {},
    explanationSummary: {},
    generatedAt: now.toISOString(),
  };
}

export default buildTaxInsightContext;
