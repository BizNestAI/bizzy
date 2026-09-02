import crypto from "node:crypto";
import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { HEALTH_ACCOUNTING_METHOD } from "./healthMonthlySnapshotService.js";
import { monthKeyFromParts, rangeLastNMonths, lastFullMonthParts } from "../../utils/monthKey.js";

export const FORECAST_MODEL_VERSION = "forecast_v1";
export const FORECAST_HISTORY_MONTHS = 12;
export const FORECAST_DEFAULT_HORIZON_MONTHS = 12;
export const FORECAST_GENERATION_LEASE_MS = 10 * 60 * 1000;

export const FORECAST_V1_CONFIG = Object.freeze({
  recent3Weight: 0.5,
  recent6Weight: 0.3,
  fullYearWeight: 0.2,
  priorYearPatternWeight: 0.5,
  trendAdjustedWeight: 0.5,
  revenueTrendCap: { min: -0.03, max: 0.03 },
  expenseTrendCap: { min: -0.02, max: 0.02 },
  winsorMadMultiplier: 2.5,
});

export class ForecastV1Error extends Error {
  constructor(error, status = 400, details = {}) {
    super(error);
    this.name = "ForecastV1Error";
    this.error = error;
    this.status = status;
    this.details = details;
  }
}

export async function getForecastV1Status({
  db = defaultSupabase,
  businessId,
  horizonMonths = FORECAST_DEFAULT_HORIZON_MONTHS,
  now = new Date(),
} = {}) {
  if (!businessId) throw new ForecastV1Error("missing_business_id", 400);
  const horizon = clampHorizon(horizonMonths);
  const cutoff = lastFullMonthParts(now);
  const history = await loadContiguousCashHistory({ db, businessId, cutoffYear: cutoff.year, cutoffMonth: cutoff.month });
  if (!history.complete) {
    const disconnected = await isQuickBooksDisconnected({ db, businessId });
    return {
      data_status: disconnected ? "qbo_disconnected" : "insufficient_history",
      source: "qbo_cash_health_snapshots",
      is_sample: false,
      model_version: FORECAST_MODEL_VERSION,
      history: historyPayload(history),
      forecast: { start: null, end: null, months: [] },
      cash_balance: cashBalanceUnavailable(),
      confidence: confidenceUnavailable(history),
      generated_at: null,
      run_id: null,
    };
  }

  const forecastMonths = monthsAfter(cutoff.year, cutoff.month, horizon);
  const sourceHash = hashSnapshotIds(history.months.map((row) => row.snapshot_id));
  const identity = buildForecastInputIdentity({
    businessId,
    historyStart: history.window.start,
    historyEnd: history.window.end,
    forecastStart: forecastMonths[0]?.monthKey || null,
    forecastEnd: forecastMonths.at(-1)?.monthKey || null,
    sourceSnapshotIdsHash: sourceHash,
  });
  const matchingRun = await getUsableMatchingCompletedForecastRun({
    db,
    ...identity,
    expectedMonths: horizon,
  });
  if (matchingRun?.run?.id) {
    return serializeAvailableForecast({ run: matchingRun.run, rows: matchingRun.rows });
  }
  const activeRun = await getActiveGeneratingForecastRun({ db, businessId, inputFingerprint: identity.inputFingerprint });
  if (activeRun?.id && !isStaleGeneratingRun(activeRun, now)) {
    return serializeGenerationInProgress({ run: activeRun, history, cutoff, horizon });
  }

  return {
    data_status: "generation_required",
    source: "qbo_cash_health_snapshots",
    is_sample: false,
    model_version: FORECAST_MODEL_VERSION,
    history: historyPayload(history),
    forecast: forecastWindowPayload({ cutoffYear: cutoff.year, cutoffMonth: cutoff.month, horizon }),
    cash_balance: cashBalanceUnavailable(),
    confidence: assessConfidence(history.months),
    generated_at: null,
    run_id: null,
  };
}

export async function ensureForecastV1Run({
  db = defaultSupabase,
  businessId,
  createdBy = null,
  horizonMonths = FORECAST_DEFAULT_HORIZON_MONTHS,
  now = new Date(),
} = {}) {
  if (!businessId) throw new ForecastV1Error("missing_business_id", 400);
  const horizon = clampHorizon(horizonMonths);
  const cutoff = lastFullMonthParts(now);
  const history = await loadContiguousCashHistory({ db, businessId, cutoffYear: cutoff.year, cutoffMonth: cutoff.month });
  if (!history.complete) {
    return {
      data_status: "insufficient_history",
      source: "qbo_cash_health_snapshots",
      is_sample: false,
      model_version: FORECAST_MODEL_VERSION,
      history: historyPayload(history),
      forecast: { start: null, end: null, months: [] },
      cash_balance: cashBalanceUnavailable(),
      confidence: confidenceUnavailable(history),
      generated_at: null,
      run_id: null,
    };
  }

  const forecastMonths = buildForecastV1Months({ history: history.months, horizonMonths: horizon });
  const sourceSnapshotIds = history.months.map((row) => row.snapshot_id);
  const sourceHash = hashSnapshotIds(sourceSnapshotIds);
  const forecastStart = forecastMonths[0]?.month || null;
  const forecastEnd = forecastMonths.at(-1)?.month || null;
  const identity = buildForecastInputIdentity({
    businessId,
    historyStart: history.window.start,
    historyEnd: history.window.end,
    forecastStart,
    forecastEnd,
    sourceSnapshotIdsHash: sourceHash,
  });
  const existing = await getUsableMatchingCompletedForecastRun({
    db,
    ...identity,
    expectedMonths: horizon,
  });
  if (existing?.run?.id) {
    return serializeAvailableForecast({ run: existing.run, rows: existing.rows });
  }
  const invalidCompleted = await getMatchingCompletedForecastRun({ db, ...identity });
  if (invalidCompleted?.id) {
    await markForecastRunFailed({
      db,
      businessId,
      forecastRunId: invalidCompleted.id,
      code: "forecast_completed_run_incomplete",
      cause: "Completed forecast run did not have the expected 12 persisted months.",
    });
  }

  const claimNow = new Date(now);
  const confidence = assessConfidence(history.months);
  const activeRun = await getActiveGeneratingForecastRun({ db, businessId, inputFingerprint: identity.inputFingerprint });
  if (activeRun?.id) {
    if (!isStaleGeneratingRun(activeRun, now)) {
      return serializeGenerationInProgress({ run: activeRun, history, cutoff, horizon });
    }
    await markForecastRunFailed({
      db,
      businessId,
      forecastRunId: activeRun.id,
      code: "forecast_generation_lease_expired",
      cause: "Generating claim exceeded its lease before finalization.",
    });
  }
  const runPayload = {
    business_id: businessId,
    status: "generating",
    model_version: FORECAST_MODEL_VERSION,
    accounting_method: HEALTH_ACCOUNTING_METHOD,
    history_start: history.window.start,
    history_end: history.window.end,
    forecast_start: forecastStart,
    forecast_end: forecastEnd,
    historical_months_count: history.months.length,
    source_snapshot_ids: sourceSnapshotIds,
    source_snapshot_ids_hash: sourceHash,
    input_fingerprint: identity.inputFingerprint,
    model_config: FORECAST_V1_CONFIG,
    data_quality: buildDataQuality(history.months),
    confidence,
    starting_cash: null,
    cash_balance_status: "unavailable",
    generated_at: null,
    generation_started_at: claimNow.toISOString(),
    generation_lease_expires_at: new Date(claimNow.getTime() + FORECAST_GENERATION_LEASE_MS).toISOString(),
    attempts: 1,
    created_by: createdBy || null,
    error_metadata: {},
  };

  const { data: insertedRun, error: runError } = await db
    .from("forecast_runs")
    .insert(runPayload)
    .select("*")
    .single();
  if (runError) {
    if (isUniqueViolation(runError)) {
      const duplicate = await getUsableMatchingCompletedForecastRun({
        db,
        ...identity,
        expectedMonths: horizon,
      });
      if (duplicate?.run?.id) {
        return serializeAvailableForecast({ run: duplicate.run, rows: duplicate.rows });
      }
      const active = await getActiveGeneratingForecastRun({ db, businessId, inputFingerprint: identity.inputFingerprint });
      if (active?.id && !isStaleGeneratingRun(active, now)) {
        return serializeGenerationInProgress({ run: active, history, cutoff, horizon });
      }
    }
    throw new ForecastV1Error("forecast_run_insert_failed", 500, { cause: runError.message });
  }

  const rowsPayload = forecastMonths.map((row) => ({
    month: row.month,
    baseline_revenue: row.baseline_revenue,
    baseline_expenses: row.baseline_expenses,
    baseline_operating_net_cash_flow: row.baseline_operating_net_cash_flow,
    effective_revenue: row.revenue,
    effective_expenses: row.expenses,
    effective_operating_net_cash_flow: row.operating_net_cash_flow,
  }));
  try {
    await finalizeForecastV1Run({
      db,
      businessId,
      forecastRunId: insertedRun.id,
      expectedMonths: horizon,
      rows: rowsPayload,
    });
  } catch (error) {
    await markForecastRunFailed({
      db,
      businessId,
      forecastRunId: insertedRun.id,
      code: error?.error || "forecast_finalization_failed",
      cause: error?.details?.cause || error?.message,
    });
    if (error instanceof ForecastV1Error) throw error;
    throw new ForecastV1Error("forecast_finalization_failed", 500, { cause: error?.message });
  }

  const finalizedRun = await getForecastRunById({ db, businessId, forecastRunId: insertedRun.id });
  const rows = await getForecastRunMonths({ db, businessId, forecastRunId: insertedRun.id });
  if (!forecastRowsAreComplete(finalizedRun, rows, horizon)) {
    throw new ForecastV1Error("forecast_finalized_run_incomplete", 500);
  }
  return serializeAvailableForecast({ run: finalizedRun, rows });
}

export async function upsertForecastV1Overrides({
  db = defaultSupabase,
  businessId,
  forecastRunId,
  createdBy = null,
  rows = [],
} = {}) {
  if (!businessId) throw new ForecastV1Error("missing_business_id", 400);
  if (!forecastRunId) throw new ForecastV1Error("missing_forecast_run_id", 400);
  if (!Array.isArray(rows) || rows.length === 0) throw new ForecastV1Error("missing_override_rows", 400);
  const run = await getForecastRunById({ db, businessId, forecastRunId });
  if (!run?.id || run.status !== "completed" || run.accounting_method !== HEALTH_ACCOUNTING_METHOD) {
    throw new ForecastV1Error("forecast_run_not_available", 404);
  }
  const monthRows = await getForecastRunMonths({ db, businessId, forecastRunId });
  const validMonths = new Set(monthRows.map((row) => normalizeMonthDate(row.month)));
  const overridePayload = rows
    .map((row) => ({
      forecast_run_id: forecastRunId,
      business_id: businessId,
      month: normalizeMonthDate(row.month),
      revenue_override: optionalMoney(row.revenue_override ?? row.revenue),
      expense_override: optionalMoney(row.expense_override ?? row.expenses),
      reason: row.reason || null,
      created_by: createdBy || null,
      updated_at: new Date().toISOString(),
    }))
    .filter((row) => validMonths.has(row.month));
  if (!overridePayload.length) throw new ForecastV1Error("no_valid_override_months", 400);

  const { error } = await db
    .from("forecast_overrides")
    .upsert(overridePayload, { onConflict: "forecast_run_id,business_id,month" });
  if (error) throw new ForecastV1Error("forecast_override_upsert_failed", 500, { cause: error.message });

  await applyOverridesToForecastMonths({ db, businessId, forecastRunId });
  const updatedRows = await getForecastRunMonths({ db, businessId, forecastRunId });
  return serializeAvailableForecast({ run, rows: updatedRows });
}

export async function resetForecastV1Overrides({
  db = defaultSupabase,
  businessId,
  forecastRunId,
  month = null,
} = {}) {
  if (!businessId) throw new ForecastV1Error("missing_business_id", 400);
  if (!forecastRunId) throw new ForecastV1Error("missing_forecast_run_id", 400);
  let query = db.from("forecast_overrides").delete().eq("business_id", businessId).eq("forecast_run_id", forecastRunId);
  if (month) query = query.eq("month", normalizeMonthDate(month));
  const { error } = await query;
  if (error) throw new ForecastV1Error("forecast_override_reset_failed", 500, { cause: error.message });
  await applyOverridesToForecastMonths({ db, businessId, forecastRunId });
  const run = await getForecastRunById({ db, businessId, forecastRunId });
  const rows = await getForecastRunMonths({ db, businessId, forecastRunId });
  return serializeAvailableForecast({ run, rows });
}

export async function loadContiguousCashHistory({
  db = defaultSupabase,
  businessId,
  cutoffYear,
  cutoffMonth,
  monthsRequired = FORECAST_HISTORY_MONTHS,
} = {}) {
  const expected = rangeLastNMonths({ year: Number(cutoffYear), month: Number(cutoffMonth), n: monthsRequired });
  const rows = await selectRows(
    db
      .from("monthly_review_qbo_pnl_snapshots")
      .select("id,review_year,review_month,accounting_method,status,is_current,revenue,expenses,net_profit,pulled_at,metadata")
      .eq("business_id", businessId)
      .eq("accounting_method", HEALTH_ACCOUNTING_METHOD)
      .eq("is_current", true)
      .eq("status", "current")
  );
  const byMonth = new Map(
    rows
      .filter(isEligibleForecastHistorySnapshot)
      .map((row) => [monthKeyFromParts(row.review_year, row.review_month), row])
  );
  const months = expected
    .map((entry) => {
      const snapshot = byMonth.get(entry.monthKey);
      if (!snapshot) return null;
      return {
        year: entry.year,
        month: entry.month,
        month_key: entry.monthKey,
        snapshot_id: snapshot.id,
        revenue: roundMoney(snapshot.revenue),
        expenses: roundMoney(snapshot.expenses),
        net_profit: roundMoney(snapshot.net_profit),
      };
    })
    .filter(Boolean);
  const missing = expected
    .filter((entry) => !byMonth.has(entry.monthKey))
    .map((entry) => entry.monthKey.slice(0, 7));
  return {
    complete: missing.length === 0 && months.length === monthsRequired,
    months,
    missing_months: missing,
    months_available: months.length,
    months_required: monthsRequired,
    window: {
      start: expected[0]?.monthKey || null,
      end: expected.at(-1)?.monthKey || null,
    },
  };
}

export function buildForecastV1Months({
  history,
  horizonMonths = FORECAST_DEFAULT_HORIZON_MONTHS,
  config = FORECAST_V1_CONFIG,
} = {}) {
  if (!Array.isArray(history) || history.length !== FORECAST_HISTORY_MONTHS) {
    throw new ForecastV1Error("forecast_history_requires_12_contiguous_months", 409);
  }
  const revenueModel = buildMetricModel(history.map((row) => row.revenue), config.revenueTrendCap, config);
  const expenseModel = buildMetricModel(history.map((row) => row.expenses), config.expenseTrendCap, config);
  const forecastMonths = monthsAfter(history.at(-1).year, history.at(-1).month, clampHorizon(horizonMonths));
  return forecastMonths.map((entry, index) => {
    const priorYearIndex = index % FORECAST_HISTORY_MONTHS;
    const revenue = forecastMetric({ priorYearValue: history[priorYearIndex].revenue, model: revenueModel, index, config });
    const expenses = forecastMetric({ priorYearValue: history[priorYearIndex].expenses, model: expenseModel, index, config });
    const net = roundMoney(revenue - expenses);
    return {
      month: entry.monthKey,
      baseline_revenue: revenue,
      baseline_expenses: expenses,
      baseline_operating_net_cash_flow: net,
      revenue,
      expenses,
      operating_net_cash_flow: net,
      cash_in: null,
      cash_out: null,
      ending_cash: null,
      has_override: false,
    };
  });
}

async function getMatchingCompletedForecastRun({ db, businessId, historyStart, historyEnd, forecastStart, forecastEnd, sourceSnapshotIdsHash, inputFingerprint = null }) {
  let query = db
    .from("forecast_runs")
    .select("*")
    .eq("business_id", businessId)
    .eq("model_version", FORECAST_MODEL_VERSION)
    .eq("accounting_method", HEALTH_ACCOUNTING_METHOD)
    .eq("status", "completed");
  if (inputFingerprint) {
    query = query.eq("input_fingerprint", inputFingerprint);
  } else {
    query = query
      .eq("history_start", historyStart)
      .eq("history_end", historyEnd)
      .eq("forecast_start", forecastStart)
      .eq("forecast_end", forecastEnd)
      .eq("source_snapshot_ids_hash", sourceSnapshotIdsHash);
  }
  const result = await query
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (isMissingForecastTable(result.error)) return null;
  if (result.error) throw new ForecastV1Error("forecast_run_query_failed", 500, { cause: result.error.message });
  return result.data || null;
}

async function getUsableMatchingCompletedForecastRun({
  db,
  businessId,
  historyStart,
  historyEnd,
  forecastStart,
  forecastEnd,
  sourceSnapshotIdsHash,
  inputFingerprint = null,
  expectedMonths = FORECAST_DEFAULT_HORIZON_MONTHS,
}) {
  const run = await getMatchingCompletedForecastRun({
    db,
    businessId,
    historyStart,
    historyEnd,
    forecastStart,
    forecastEnd,
    sourceSnapshotIdsHash,
    inputFingerprint,
  });
  if (!run?.id) return null;
  const rows = await getForecastRunMonths({ db, businessId, forecastRunId: run.id });
  if (!forecastRowsAreComplete(run, rows, expectedMonths)) return null;
  return { run, rows };
}

async function getActiveGeneratingForecastRun({ db, businessId, inputFingerprint }) {
  if (!inputFingerprint) return null;
  const { data, error } = await db
    .from("forecast_runs")
    .select("*")
    .eq("business_id", businessId)
    .eq("model_version", FORECAST_MODEL_VERSION)
    .eq("accounting_method", HEALTH_ACCOUNTING_METHOD)
    .eq("status", "generating")
    .eq("input_fingerprint", inputFingerprint)
    .order("generation_started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (isMissingForecastTable(error)) return null;
  if (error) throw new ForecastV1Error("forecast_generation_claim_query_failed", 500, { cause: error.message });
  return data || null;
}

async function finalizeForecastV1Run({ db, businessId, forecastRunId, expectedMonths, rows }) {
  if (!forecastRunId) throw new ForecastV1Error("missing_forecast_run_id", 400);
  if (!Array.isArray(rows) || rows.length !== expectedMonths) {
    throw new ForecastV1Error("forecast_month_count_invalid", 500, { expected: expectedMonths, actual: rows?.length || 0 });
  }
  if (typeof db.rpc === "function") {
    const { error } = await db.rpc("finalize_forecast_v1_run", {
      p_business_id: businessId,
      p_forecast_run_id: forecastRunId,
      p_expected_months: expectedMonths,
      p_months: rows,
    });
    if (error) throw new ForecastV1Error("forecast_finalization_failed", 500, { cause: error.message });
    return;
  }

  const rowPayload = rows.map((row) => ({
    forecast_run_id: forecastRunId,
    business_id: businessId,
    ...row,
  }));
  const { error: monthError } = await db.from("forecast_months").insert(rowPayload);
  if (monthError) throw new ForecastV1Error("forecast_months_insert_failed", 500, { cause: monthError.message });
  const { error: runError } = await db
    .from("forecast_runs")
    .update({ status: "completed", generated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", forecastRunId)
    .eq("business_id", businessId);
  if (runError) throw new ForecastV1Error("forecast_run_completion_failed", 500, { cause: runError.message });
}

async function markForecastRunFailed({ db, businessId, forecastRunId, code, cause }) {
  if (!forecastRunId) return;
  await db
    .from("forecast_runs")
    .update({
      status: "failed",
      error_metadata: { code, cause: String(cause || code || "forecast_generation_failed").slice(0, 500) },
      generation_lease_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", forecastRunId)
    .eq("business_id", businessId);
}

async function getForecastRunById({ db, businessId, forecastRunId }) {
  const { data, error } = await db
    .from("forecast_runs")
    .select("*")
    .eq("id", forecastRunId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new ForecastV1Error("forecast_run_query_failed", 500, { cause: error.message });
  return data || null;
}

async function getForecastRunMonths({ db, businessId, forecastRunId }) {
  const monthRows = await selectRows(
    db
      .from("forecast_months")
      .select("*")
      .eq("business_id", businessId)
      .eq("forecast_run_id", forecastRunId)
      .order("month", { ascending: true })
  );
  const overrides = await selectRows(
    db
      .from("forecast_overrides")
      .select("*")
      .eq("business_id", businessId)
      .eq("forecast_run_id", forecastRunId)
  ).catch(() => []);
  const overrideByMonth = new Map(overrides.map((row) => [normalizeMonthDate(row.month), row]));
  return monthRows.map((row) => {
    const override = overrideByMonth.get(normalizeMonthDate(row.month));
    const revenue = override?.revenue_override != null ? roundMoney(override.revenue_override) : roundMoney(row.effective_revenue ?? row.baseline_revenue);
    const expenses = override?.expense_override != null ? roundMoney(override.expense_override) : roundMoney(row.effective_expenses ?? row.baseline_expenses);
    return serializeForecastMonth({
      ...row,
      effective_revenue: revenue,
      effective_expenses: expenses,
      effective_operating_net_cash_flow: roundMoney(revenue - expenses),
      has_override: Boolean(override),
    });
  });
}

async function applyOverridesToForecastMonths({ db, businessId, forecastRunId }) {
  const rows = await selectRows(
    db
      .from("forecast_months")
      .select("*")
      .eq("business_id", businessId)
      .eq("forecast_run_id", forecastRunId)
  );
  const overrides = await selectRows(
    db
      .from("forecast_overrides")
      .select("*")
      .eq("business_id", businessId)
      .eq("forecast_run_id", forecastRunId)
  );
  const overrideByMonth = new Map(overrides.map((row) => [normalizeMonthDate(row.month), row]));
  for (const row of rows) {
    const override = overrideByMonth.get(normalizeMonthDate(row.month));
    const revenue = override?.revenue_override != null ? roundMoney(override.revenue_override) : roundMoney(row.baseline_revenue);
    const expenses = override?.expense_override != null ? roundMoney(override.expense_override) : roundMoney(row.baseline_expenses);
    await db
      .from("forecast_months")
      .update({
        effective_revenue: revenue,
        effective_expenses: expenses,
        effective_operating_net_cash_flow: roundMoney(revenue - expenses),
      })
      .eq("id", row.id)
      .eq("business_id", businessId)
      .eq("forecast_run_id", forecastRunId);
  }
}

async function isQuickBooksDisconnected({ db, businessId }) {
  const { data, error } = await db
    .from("quickbooks_tokens")
    .select("business_id")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .eq("status", "active")
    .limit(1);
  if (error) return false;
  return !Array.isArray(data) || data.length === 0;
}

function serializeAvailableForecast({ run, rows }) {
  const months = rows.map(serializeForecastMonth);
  return {
    data_status: "available",
    source: "qbo_cash_health_snapshots",
    is_sample: false,
    model_version: run.model_version || FORECAST_MODEL_VERSION,
    history: {
      start: normalizeMonthDate(run.history_start),
      end: normalizeMonthDate(run.history_end),
      months_available: Number(run.historical_months_count || FORECAST_HISTORY_MONTHS),
      months_required: FORECAST_HISTORY_MONTHS,
      missing_months: [],
      source_snapshot_ids: run.source_snapshot_ids || [],
    },
    forecast: {
      start: normalizeMonthDate(run.forecast_start),
      end: normalizeMonthDate(run.forecast_end),
      months,
    },
    forecast_rows: months,
    cash_balance: {
      status: run.cash_balance_status || "unavailable",
      starting_cash: nullableNumber(run.starting_cash),
      ending_cash: null,
    },
    confidence: run.confidence || {},
    generated_at: run.generated_at || run.created_at || null,
    run_id: run.id,
  };
}

function serializeForecastMonth(row) {
  const revenue = roundMoney(row.effective_revenue ?? row.revenue ?? row.baseline_revenue);
  const expenses = roundMoney(row.effective_expenses ?? row.expenses ?? row.baseline_expenses);
  const operatingNet = roundMoney(row.effective_operating_net_cash_flow ?? row.operating_net_cash_flow ?? revenue - expenses);
  const month = normalizeMonthDate(row.month);
  return {
    month,
    baseline_revenue: roundMoney(row.baseline_revenue ?? revenue),
    baseline_expenses: roundMoney(row.baseline_expenses ?? expenses),
    baseline_operating_net_cash_flow: roundMoney(row.baseline_operating_net_cash_flow ?? operatingNet),
    revenue,
    expenses,
    operating_net_cash_flow: operatingNet,
    cash_in: null,
    cash_out: null,
    net_cash: operatingNet,
    ending_cash: null,
    has_override: Boolean(row.has_override),
  };
}

function historyPayload(history) {
  return {
    start: history.window.start,
    end: history.window.end,
    months_available: history.months_available,
    months_required: history.months_required,
    missing_months: history.missing_months,
    source_snapshot_ids: history.months.map((row) => row.snapshot_id),
  };
}

function forecastWindowPayload({ cutoffYear, cutoffMonth, horizon }) {
  const months = monthsAfter(cutoffYear, cutoffMonth, horizon);
  return {
    start: months[0]?.monthKey || null,
    end: months.at(-1)?.monthKey || null,
    months: [],
  };
}

function buildMetricModel(values, cap, config) {
  const recent3 = average(values.slice(-3));
  const recent6 = average(values.slice(-6));
  const fullYear = average(values);
  const blendedLevel = roundMoney(
    recent3 * config.recent3Weight +
    recent6 * config.recent6Weight +
    fullYear * config.fullYearWeight
  );
  const robust = winsorizeByMad(values, config.winsorMadMultiplier);
  return {
    blendedLevel,
    trend: clamp(estimateMonthlyTrend(robust), cap.min, cap.max),
    recent3: roundMoney(recent3),
    recent6: roundMoney(recent6),
    fullYear: roundMoney(fullYear),
  };
}

function forecastMetric({ priorYearValue, model, index, config }) {
  const trendAdjusted = model.blendedLevel * Math.pow(1 + model.trend, index + 1);
  return roundMoney(Math.max(0, priorYearValue * config.priorYearPatternWeight + trendAdjusted * config.trendAdjustedWeight));
}

function estimateMonthlyTrend(values) {
  if (!Array.isArray(values) || values.length < 3) return 0;
  const first = average(values.slice(0, 6));
  const last = average(values.slice(-6));
  const denominator = Math.max(1, Math.abs(first));
  return (last - first) / denominator / Math.max(1, values.length - 1);
}

function winsorizeByMad(values, multiplier) {
  const medianValue = median(values);
  const deviations = values.map((value) => Math.abs(value - medianValue));
  const mad = median(deviations);
  if (!(mad > 0)) return values.map((value) => Number(value || 0));
  const low = medianValue - multiplier * mad;
  const high = medianValue + multiplier * mad;
  return values.map((value) => clamp(Number(value || 0), low, high));
}

function assessConfidence(history) {
  const revenue = history.map((row) => row.revenue);
  const expenses = history.map((row) => row.expenses);
  const revenueVolatility = coefficientOfVariation(revenue);
  const expenseVolatility = coefficientOfVariation(expenses);
  const zeroActivityMonths = history.filter((row) => row.revenue === 0 && row.expenses === 0 && row.net_profit === 0).length;
  const outlierMonths = countOutliers(revenue) + countOutliers(expenses);
  const volatility = roundMoney((revenueVolatility + expenseVolatility) / 2);
  let level = "medium";
  if (volatility > 1 || zeroActivityMonths >= 3 || outlierMonths >= 4) level = "low";
  return {
    level,
    coverage: 1,
    volatility: {
      revenue: roundMoney(revenueVolatility),
      expenses: roundMoney(expenseVolatility),
      combined: volatility,
    },
    zero_activity_months: zeroActivityMonths,
    outlier_months: outlierMonths,
    explanation: level === "medium"
      ? "Uses one complete 12-month Cash-basis QuickBooks cycle with a conservative bounded trend."
      : "Uses complete Cash-basis QuickBooks history, but volatility limits forecast confidence.",
  };
}

function confidenceUnavailable(history) {
  return {
    level: "low",
    coverage: roundMoney((history.months_available || 0) / Math.max(1, history.months_required || FORECAST_HISTORY_MONTHS)),
    volatility: {},
    explanation: "Forecast requires 12 contiguous completed Cash-basis QuickBooks months.",
  };
}

function buildDataQuality(history) {
  return {
    coverage: 1,
    months_available: history.length,
    months_required: FORECAST_HISTORY_MONTHS,
    zero_revenue_months: history.filter((row) => row.revenue === 0).length,
    zero_activity_months: history.filter((row) => row.revenue === 0 && row.expenses === 0 && row.net_profit === 0).length,
  };
}

function cashBalanceUnavailable() {
  return {
    status: "unavailable",
    starting_cash: null,
    ending_cash: null,
    explanation: "QBO cash-balance history is required before Bizzi can project ending cash.",
  };
}

function serializeGenerationInProgress({ run, history, cutoff, horizon }) {
  return {
    data_status: "generation_in_progress",
    source: "qbo_cash_health_snapshots",
    is_sample: false,
    model_version: run?.model_version || FORECAST_MODEL_VERSION,
    history: historyPayload(history),
    forecast: forecastWindowPayload({ cutoffYear: cutoff.year, cutoffMonth: cutoff.month, horizon }),
    cash_balance: cashBalanceUnavailable(),
    confidence: assessConfidence(history.months),
    generated_at: null,
    run_id: run?.id || null,
    generation_started_at: run?.generation_started_at || run?.created_at || null,
    generation_lease_expires_at: run?.generation_lease_expires_at || null,
  };
}

function isEligibleForecastHistorySnapshot(row) {
  return Boolean(
    row &&
    row.business_id &&
    row.accounting_method === HEALTH_ACCOUNTING_METHOD &&
    row.status === "current" &&
    row.is_current === true &&
    row.review_year &&
    row.review_month
  );
}

function monthsAfter(year, month, count) {
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    const date = new Date(Date.UTC(Number(year), Number(month) - 1 + i, 1));
    out.push({
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      monthKey: monthKeyFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1),
    });
  }
  return out;
}

function buildForecastInputIdentity({ businessId, historyStart, historyEnd, forecastStart, forecastEnd, sourceSnapshotIdsHash }) {
  const modelConfigHash = stableHash(FORECAST_V1_CONFIG);
  const inputFingerprint = crypto
    .createHash("sha256")
    .update([
      businessId,
      FORECAST_MODEL_VERSION,
      HEALTH_ACCOUNTING_METHOD,
      historyStart,
      historyEnd,
      forecastStart,
      forecastEnd,
      sourceSnapshotIdsHash,
      modelConfigHash,
    ].join("|"))
    .digest("hex");
  return {
    businessId,
    historyStart,
    historyEnd,
    forecastStart,
    forecastEnd,
    sourceSnapshotIdsHash,
    inputFingerprint,
  };
}

function forecastRowsAreComplete(run, rows, expectedMonths) {
  if (!run?.id || run.status !== "completed") return false;
  if (!Array.isArray(rows) || rows.length !== expectedMonths) return false;
  const expected = [];
  const start = normalizeMonthDate(run.forecast_start);
  for (let i = 0; i < expectedMonths; i += 1) {
    const date = new Date(`${start}T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + i);
    expected.push(monthKeyFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1));
  }
  const actual = rows.map((row) => normalizeMonthDate(row.month));
  return expected.every((month, index) => actual[index] === month) && new Set(actual).size === expectedMonths;
}

function isStaleGeneratingRun(run, now = new Date()) {
  const expiresAt = run?.generation_lease_expires_at ? new Date(run.generation_lease_expires_at) : null;
  if (expiresAt && !Number.isNaN(expiresAt.getTime())) return expiresAt.getTime() <= new Date(now).getTime();
  const startedAt = run?.generation_started_at || run?.created_at;
  if (!startedAt) return true;
  return new Date(startedAt).getTime() + FORECAST_GENERATION_LEASE_MS <= new Date(now).getTime();
}

function hashSnapshotIds(ids = []) {
  return crypto.createHash("sha256").update(ids.join("|")).digest("hex");
}

function stableHash(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function selectRows(query) {
  const { data, error } = await query;
  if (error) throw new ForecastV1Error("forecast_query_failed", 500, { cause: error.message });
  return Array.isArray(data) ? data : [];
}

function isMissingForecastTable(error) {
  return error && ["42P01", "42703", "PGRST200", "PGRST204", "PGRST205"].includes(error.code);
}

function isUniqueViolation(error) {
  return error?.code === "23505" || String(error?.message || "").toLowerCase().includes("duplicate key");
}

function normalizeMonthDate(value) {
  if (!value) return null;
  const text = String(value);
  if (/^\d{4}-\d{2}$/.test(text)) return `${text}-01`;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 7) + "-01";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return monthKeyFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1);
}

function optionalMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  return roundMoney(value);
}

function nullableNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function average(values = []) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (!finite.length) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function median(values = []) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function coefficientOfVariation(values = []) {
  const avg = average(values);
  if (!(Math.abs(avg) > 0)) return 0;
  const variance = average(values.map((value) => (Number(value || 0) - avg) ** 2));
  return Math.sqrt(variance) / Math.abs(avg);
}

function countOutliers(values = []) {
  const med = median(values);
  const mad = median(values.map((value) => Math.abs(Number(value || 0) - med)));
  if (!(mad > 0)) return 0;
  return values.filter((value) => Math.abs(Number(value || 0) - med) > 3 * mad).length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function clampHorizon(value) {
  return Math.max(2, Math.min(12, Number(value) || FORECAST_DEFAULT_HORIZON_MONTHS));
}

export default {
  FORECAST_MODEL_VERSION,
  FORECAST_V1_CONFIG,
  getForecastV1Status,
  ensureForecastV1Run,
  upsertForecastV1Overrides,
  resetForecastV1Overrides,
  loadContiguousCashHistory,
  buildForecastV1Months,
};
