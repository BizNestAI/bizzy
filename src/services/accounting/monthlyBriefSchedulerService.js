import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { qboEnvName } from "../../utils/qboEnv.js";
import {
  generateFinancialPulseSnapshot,
  scheduledPulseTargetMonth,
} from "../../api/accounting/monthlyFinancialPulse.js";
import {
  getMonthlyHealthSummary,
  HEALTH_ACCOUNTING_METHOD,
} from "./healthMonthlySnapshotService.js";

const JOB_TABLE = "monthly_financial_pulse_jobs";
const PULSE_TABLE = "monthly_financial_pulse";
const DEFAULT_LOOKBACK_DAYS = 35;

function nyDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function dateKey({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function dueMonthlyBriefTargets({ now = new Date(), lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  const targets = new Map();
  for (let i = 0; i <= lookbackDays; i += 1) {
    const date = addDays(now, -i);
    const target = scheduledPulseTargetMonth(date);
    if (!target) continue;
    const due = nyDateParts(date);
    const key = `${target.monthText}:${target.cadence}`;
    if (!targets.has(key)) {
      targets.set(key, {
        target_month: target.monthText,
        cadence: target.cadence,
        due_on: dateKey(due),
      });
    }
  }
  return Array.from(targets.values()).sort((a, b) => a.target_month.localeCompare(b.target_month));
}

export async function runMonthlyBriefSchedulerSweepOnce({
  db = defaultSupabase,
  now = new Date(),
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  generatePulse = generateFinancialPulseSnapshot,
} = {}) {
  const targets = dueMonthlyBriefTargets({ now, lookbackDays });
  if (!targets.length) return { ok: true, targets: 0, businesses: 0, completed: 0, waiting: 0, failed: 0 };

  const { data: tokenRows, error } = await db
    .from("quickbooks_tokens")
    .select("business_id,user_id")
    .eq("qbo_env", qboEnvName)
    .eq("is_active", true)
    .eq("status", "active")
    .not("business_id", "is", null);
  if (error) throw new Error(`monthly_brief_active_business_lookup_failed: ${error.message || error}`);

  const businesses = dedupeBusinesses(tokenRows || []);
  let completed = 0;
  let waiting = 0;
  let failed = 0;

  for (const business of businesses) {
    for (const target of targets) {
      const result = await ensureMonthlyBriefForTarget({ db, business, target, generatePulse });
      if (result.status === "completed" || result.status === "already_available") completed += 1;
      else if (result.status === "waiting_for_snapshot") waiting += 1;
      else if (result.status === "failed") failed += 1;
    }
  }

  return { ok: failed === 0, targets: targets.length, businesses: businesses.length, completed, waiting, failed };
}

export async function ensureMonthlyBriefForTarget({ db = defaultSupabase, business, target, generatePulse = generateFinancialPulseSnapshot }) {
  const businessId = business?.business_id || business?.businessId;
  const userId = business?.user_id || business?.userId || null;
  if (!businessId) throw new Error("missing_business_id");
  if (!userId) throw new Error("missing_user_id");

  const existingPulse = await readPulse({ db, businessId, target });
  if (existingPulse?.status === "available") {
    await upsertJob({ db, businessId, userId, target, status: "completed", result: { pulse_id: existingPulse.id, reused: true } });
    return { status: "already_available", pulse_id: existingPulse.id };
  }

  const job = await upsertJob({ db, businessId, userId, target, status: "running", started: true });
  const { year, month } = partsFromMonthText(target.target_month);
  try {
    const summary = await getMonthlyHealthSummary({ db, businessId, year, month });
    if (!["available", "empty"].includes(summary?.data_status) || !summary?.snapshot?.id) {
      await upsertPulseStatus({
        db,
        businessId,
        userId,
        target,
        status: "waiting_for_snapshot",
        metadata: { reason: "current_cash_snapshot_required", data_status: summary?.data_status || null },
      });
      await upsertJob({
        db,
        businessId,
        userId,
        target,
        status: "waiting_for_snapshot",
        result: { reason: "current_cash_snapshot_required", data_status: summary?.data_status || null },
      });
      return { status: "waiting_for_snapshot" };
    }

    const pulse = await generatePulse({
      monthlyMetrics: {
        total_revenue: summary.metrics?.totalRevenue,
        total_expenses: summary.metrics?.totalExpenses,
        net_profit: summary.metrics?.netProfit,
        profit_margin: summary.metrics?.profitMargin,
        top_spending_category: summary.metrics?.top_spending_category || summary.metrics?.topSpendingCategory?.name || null,
        accounting_method: HEALTH_ACCOUNTING_METHOD,
        source_snapshot_id: summary.snapshot.id,
      },
      forecastData: {},
      priorMonthMetrics: summary.prior_month?.metrics || {},
      user_id: userId,
      business_id: businessId,
      month: target.target_month,
      cadence: target.cadence,
      sourceSnapshotId: summary.snapshot.id,
    });
    const saved = await readPulse({ db, businessId, target });
    await upsertJob({
      db,
      businessId,
      userId,
      target,
      status: "completed",
      sourceSnapshotId: summary.snapshot.id,
      result: { pulse_id: saved?.id || null, generated: Boolean(pulse) },
      finished: true,
    });
    return { status: "completed", pulse_id: saved?.id || null };
  } catch (err) {
    await upsertPulseStatus({
      db,
      businessId,
      userId,
      target,
      status: "failed",
      metadata: { error: err?.message || String(err) },
    }).catch(() => {});
    await upsertJob({
      db,
      businessId,
      userId,
      target,
      status: "failed",
      error: err?.message || String(err),
      result: { error: err?.message || String(err), job_id: job?.id || null },
      finished: true,
    });
    return { status: "failed", error: err?.message || String(err) };
  }
}

async function upsertPulseStatus({ db, businessId, userId, target, status, metadata = {} }) {
  const { error } = await db
    .from(PULSE_TABLE)
    .upsert({
      business_id: businessId,
      user_id: userId,
      month: target.target_month,
      cadence: target.cadence,
      status,
      accounting_method: HEALTH_ACCOUNTING_METHOD,
      generated_at: null,
      data_through_date: target.target_month,
      generation_metadata: metadata,
      created_at: new Date().toISOString(),
      revenue_summary: null,
      spending_trend: null,
      variance_from_forecast: null,
      business_insights: [],
      motivational_message: null,
      embedding_text: null,
      embedding: null,
    }, { onConflict: "business_id,month,cadence" });
  if (error) throw new Error(`monthly_brief_status_upsert_failed: ${error.message || error}`);
}

async function readPulse({ db, businessId, target }) {
  const { data, error } = await db
    .from(PULSE_TABLE)
    .select("*")
    .eq("business_id", businessId)
    .eq("month", target.target_month)
    .eq("cadence", target.cadence)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`monthly_brief_read_failed: ${error.message || error}`);
  return data || null;
}

async function upsertJob({
  db,
  businessId,
  userId,
  target,
  status,
  sourceSnapshotId = null,
  error = null,
  result = {},
  started = false,
  finished = false,
}) {
  const now = new Date().toISOString();
  const payload = {
    business_id: businessId,
    user_id: userId,
    target_month: target.target_month,
    cadence: target.cadence,
    status,
    source_snapshot_id: sourceSnapshotId,
    accounting_method: HEALTH_ACCOUNTING_METHOD,
    due_on: target.due_on,
    last_error: error,
    result,
    updated_at: now,
  };
  if (started) payload.started_at = now;
  if (finished) payload.finished_at = now;
  const { data, error: upsertError } = await db
    .from(JOB_TABLE)
    .upsert(payload, { onConflict: "business_id,target_month,cadence" })
    .select("*")
    .maybeSingle();
  if (upsertError) throw new Error(`monthly_brief_job_upsert_failed: ${upsertError.message || upsertError}`);
  return data || null;
}

function dedupeBusinesses(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row?.business_id || map.has(row.business_id)) continue;
    map.set(row.business_id, { business_id: row.business_id, user_id: row.user_id || null });
  }
  return Array.from(map.values());
}

function partsFromMonthText(monthText) {
  const [year, month] = String(monthText || "").split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month)) throw new Error("invalid_target_month");
  return { year, month };
}

export default {
  dueMonthlyBriefTargets,
  ensureMonthlyBriefForTarget,
  runMonthlyBriefSchedulerSweepOnce,
};
