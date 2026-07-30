import { TAX_SCHEDULE_JOB_TYPES } from "./taxScheduleDomain.js";

const WINDOWS = [
  { key: "due_today", maxDays: 0 },
  { key: "due_within_3_days", maxDays: 3 },
  { key: "due_within_7_days", maxDays: 7 },
  { key: "due_within_14_days", maxDays: 14 },
  { key: "due_within_30_days", maxDays: 30 },
];

export async function runTaxDeadlineScan({ supabase, businessId, taxYear, now = new Date() } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const deadlines = await loadCanonicalDeadlines({ supabase, businessId, taxYear });
  const scanned = deadlines
    .filter((deadline) => deadline.dueDate || deadline.due_date || deadline.date)
    .map((deadline) => classifyDeadline(deadline, now))
    .filter(Boolean);
  const actionable = scanned.filter((item) => item.status !== "future");
  return {
    jobType: TAX_SCHEDULE_JOB_TYPES.DAILY_DEADLINE_SCAN,
    businessId,
    taxYear,
    scannedCount: deadlines.length,
    actionableCount: actionable.length,
    deadlines: actionable,
    insightContexts: actionable.map((item) => ({
      sourceEventId: `tax:deadline:${businessId}:${taxYear}:${item.id || item.name}:${item.window}`,
      businessId,
      taxYear,
      category: "tax_deadline",
      severity: item.status === "overdue" ? "high" : item.window === "due_today" ? "medium" : "low",
      deadline: item,
    })),
  };
}

async function loadCanonicalDeadlines({ supabase, businessId, taxYear }) {
  if (supabase.store) {
    if (supabase.store.tax_deadlines?.length) {
      return supabase.store.tax_deadlines.filter((row) =>
        (!businessId || row.business_id === businessId || row.businessId === businessId) &&
        (!taxYear || Number(row.tax_year || row.taxYear) === Number(taxYear))
      ).map(normalizeDeadline);
    }
    const latest = latestRun(supabase.store.tax_calculation_runs || [], businessId, taxYear);
    return normalizeDeadlinesFromRun(latest);
  }

  const latest = await selectLatestRun({ supabase, businessId, taxYear });
  const fromRun = normalizeDeadlinesFromRun(latest);
  if (fromRun.length) return fromRun;
  try {
    const { data, error } = await supabase
      .from("tax_deadlines")
      .select("*")
      .eq("business_id", businessId)
      .eq("tax_year", taxYear)
      .order("due_date", { ascending: true })
      .limit(100);
    if (!error) return (data || []).map(normalizeDeadline);
  } catch {
    // Deadline table is optional; canonical runs remain the preferred source.
  }
  return [];
}

function normalizeDeadlinesFromRun(run) {
  const deadlines = run?.deadlines || run?.calculation_result?.deadlines || run?.result?.deadlines || run?.metadata?.deadlines || [];
  return Array.isArray(deadlines) ? deadlines.map(normalizeDeadline) : [];
}

async function selectLatestRun({ supabase, businessId, taxYear }) {
  const { data } = await supabase
    .from("tax_calculation_runs")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .in("status", ["completed", "partial"])
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

function latestRun(rows, businessId, taxYear) {
  return rows
    .filter((row) => row.business_id === businessId && Number(row.tax_year) === Number(taxYear) && ["completed", "partial"].includes(row.status))
    .sort((a, b) => new Date(b.completed_at || b.created_at || 0) - new Date(a.completed_at || a.created_at || 0))[0] || null;
}

function normalizeDeadline(row) {
  return {
    id: row.id || null,
    name: row.name || row.label || row.type || "Tax deadline",
    jurisdiction: row.jurisdiction || null,
    type: row.type || row.metadata?.type || null,
    dueDate: row.dueDate || row.due_date || row.date || null,
    amount: row.amount ?? row.paymentAmount ?? row.payment_amount ?? null,
    status: row.status || null,
    source: row.source || "canonical_tax",
  };
}

function classifyDeadline(deadline, now) {
  const due = new Date(deadline.dueDate);
  if (!Number.isFinite(due.getTime())) return null;
  due.setUTCHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const daysUntil = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (daysUntil < 0) return { ...deadline, daysUntil, status: "overdue", window: "overdue" };
  const window = WINDOWS.find((item) => daysUntil <= item.maxDays);
  if (window) return { ...deadline, daysUntil, status: "upcoming", window: window.key };
  return { ...deadline, daysUntil, status: "future", window: "future" };
}

export default runTaxDeadlineScan;
