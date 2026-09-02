/* global process */
// src/services/qboBackfillRunner.js
// Executes a bounded multi-month QBO Health snapshot backfill and updates job progress.

import {
  appendLog,
  createJob,
  getLatestActiveJob,
  getJobById,
  updateJob,
} from "./qboBackfillJobsService.js";
import { qboEnvName } from "../utils/qboEnv.js";
import {
  trailingMonthWindow,
} from "../utils/monthKey.js";
import { getLatestMonthlyPnlSnapshot } from "./bookkeeping/qboMonthlyPnlSnapshotService.js";
import {
  HEALTH_ACCOUNTING_METHOD,
  refreshMonthlyQboFinancialSnapshot,
} from "./accounting/healthMonthlySnapshotService.js";
import { ensureForecastV1Run } from "./accounting/forecastV1Service.js";

const MONTH_DELAY_MS = Number(process.env.QBO_BACKFILL_DELAY_MS || 300);

function pad2(n) {
  return String(n).padStart(2, "0");
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNoDataReportError(err) {
  return err?.error === "qbo_summary_required_total_missing";
}

function padMonthKey(year, month) {
  return `${year}-${pad2(month)}`;
}

function normalizeResultList(value) {
  return Array.isArray(value) ? value : [];
}

function buildResultDetail({ monthKey, status, snapshotId = null, error = null, reused = false }) {
  return {
    month: monthKey,
    status,
    snapshot_id: snapshotId,
    reused: Boolean(reused),
    error: error || null,
    finished_at: new Date().toISOString(),
  };
}

function processAnchorFirst(months = []) {
  if (months.length <= 1) return months;
  const anchor = months[months.length - 1];
  return [anchor, ...months.slice(0, -1)];
}

function countResults(details = []) {
  const result = {
    attempted: details.filter((row) => row.status !== "pending").length,
    succeeded: details.filter((row) => row.status === "succeeded").length,
    skipped: details.filter((row) => row.status === "skipped").length,
    failed: details.filter((row) => row.status === "failed").length,
  };
  result.covered = result.succeeded + result.skipped;
  return result;
}

function mergeResultDetail(existing = [], detail) {
  const map = new Map(normalizeResultList(existing).map((row) => [row.month, row]));
  map.set(detail.month, detail);
  return Array.from(map.values()).sort((a, b) => String(a.month).localeCompare(String(b.month)));
}

async function verifyEligibleHealthSnapshot({ businessId, year, month, db = undefined }) {
  const snapshot = await getLatestMonthlyPnlSnapshot({
    db,
    businessId,
    reviewYear: year,
    reviewMonth: month,
    accountingMethod: HEALTH_ACCOUNTING_METHOD,
    includeAccounts: true,
    includeTransactions: false,
  });
  if (!snapshot || snapshot.status !== "current" || snapshot.is_current !== true) return null;
  if (snapshot.accounting_method !== HEALTH_ACCOUNTING_METHOD) return null;
  const revenue = Number(snapshot.revenue || 0);
  const cogs = Number(snapshot.cogs || 0);
  const expenses = Number(snapshot.expenses || 0);
  const netProfit = Number(snapshot.net_profit || 0);
  if (![revenue, cogs, expenses, netProfit].every(Number.isFinite)) return null;
  const hasActivity = revenue !== 0 || cogs !== 0 || expenses !== 0 || netProfit !== 0;
  const accountRows = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
  if (hasActivity && accountRows.length === 0) return null;
  return snapshot;
}

function finalJobStatus({ counts, expectedTotal }) {
  if (counts.covered === expectedTotal && counts.failed === 0) return "completed";
  if (counts.covered > 0) return "partial";
  return "failed";
}

function isDuplicateActiveJobError(err) {
  return /23505|duplicate key|unique constraint/i.test(String(err?.message || err || ""));
}

async function persistJobProgress({ jobId, expectedMonths, details, currentMonth = null, status = "running", finished = false }) {
  const counts = countResults(details);
  const succeeded = details.filter((row) => row.status === "succeeded").map((row) => row.month);
  const skipped = details.filter((row) => row.status === "skipped").map((row) => row.month);
  const failed = details.filter((row) => row.status === "failed").map((row) => ({ month: row.month, error: row.error || null }));
  const patch = {
    status,
    months_done: counts.attempted,
    months_attempted: counts.attempted,
    months_succeeded: counts.succeeded,
    months_skipped: counts.skipped,
    months_failed: counts.failed,
    expected_months: expectedMonths,
    succeeded_months: succeeded,
    skipped_months: skipped,
    failed_months: failed,
    result_details: details,
    last_month_processed: currentMonth,
    last_success_month: [...succeeded, ...skipped].sort().at(-1) || null,
    last_error: failed.at(-1)?.error || null,
  };
  if (finished) patch.finished_at = new Date().toISOString();
  if (succeeded.length > 0 || skipped.length > 0) patch.last_success_at = new Date().toISOString();
  await updateJob({ id: jobId, patch });
}

export async function runQboBackfill({
  jobId,
  business_id,
  months_total = 12,
  startYear,
  startMonth,
  accounting_method = HEALTH_ACCOUNTING_METHOD,
  force = false,
  realmId: _realmIdOverride = null,
  accessToken: _accessTokenOverride = null,
}) {
  void _realmIdOverride;
  void _accessTokenOverride;
  if (!jobId) throw new Error("jobId required");
  if (!business_id) throw new Error("business_id required");

  const now = new Date();
  const anchorParts = (Number(startYear) && Number(startMonth))
    ? { year: Number(startYear), month: Number(startMonth) }
    : { year: now.getFullYear(), month: now.getMonth() + 1 };
  if (accounting_method !== HEALTH_ACCOUNTING_METHOD) {
    throw new Error("qbo_health_backfill_cash_basis_required");
  }
  const months = trailingMonthWindow({ anchorYear: anchorParts.year, anchorMonth: anchorParts.month, count: months_total });
  const expectedMonths = months.map((entry) => entry.monthKey.slice(0, 7));
  const processMonths = processAnchorFirst(months);
  const job = await getJobById(jobId);
  const existingDetails = normalizeResultList(job?.result_details);
  let details = expectedMonths.map((month) => existingDetails.find((row) => row.month === month) || { month, status: "pending" });

  await updateJob({
    id: jobId,
    patch: {
      status: "running",
      accounting_method: HEALTH_ACCOUNTING_METHOD,
      force: Boolean(force),
      anchor_year: anchorParts.year,
      anchor_month: anchorParts.month,
      window_start_month: expectedMonths[0] || null,
      window_end_month: expectedMonths.at(-1) || null,
      months_total: months.length,
      expected_months: expectedMonths,
      result_details: details,
    },
  });

  for (const entry of processMonths) {
    const { year, month } = entry;
    const monthLabel = padMonthKey(year, month);
    const priorResult = details.find((row) => row.month === monthLabel);
    if (priorResult && priorResult.status !== "pending") continue;

    const latest = await getJobById(jobId);
    if (latest?.status && !["queued", "running"].includes(latest.status)) {
      await appendLog({ id: jobId, message: `stopped at ${monthLabel} status=${latest.status}` });
      return;
    }

    try {
      if (!force) {
        const existing = await verifyEligibleHealthSnapshot({ businessId: business_id, year, month });
        if (existing?.id) {
          const detail = buildResultDetail({ monthKey: monthLabel, status: "skipped", snapshotId: existing.id, reused: true });
          details = mergeResultDetail(details, detail);
          await persistJobProgress({ jobId, expectedMonths, details, currentMonth: monthLabel });
          continue;
        }
      }

      const summary = await refreshMonthlyQboFinancialSnapshot({
        businessId: business_id,
        year,
        month,
        source: "qbo_backfill",
        accountingMethod: accounting_method,
      });
      const verified = await verifyEligibleHealthSnapshot({ businessId: business_id, year, month });
      if (!verified?.id) throw new Error("current_cash_snapshot_verification_failed");
      const message = `[QBO BACKFILL] month=${monthLabel} revenue=${summary.metrics.totalRevenue} expenses=${summary.metrics.totalExpenses} profit=${summary.metrics.netProfit}`;
      console.log(message);
      await appendLog({ id: jobId, message });
      const detail = buildResultDetail({ monthKey: monthLabel, status: "succeeded", snapshotId: verified.id });
      details = mergeResultDetail(details, detail);
      await persistJobProgress({ jobId, expectedMonths, details, currentMonth: monthLabel });
    } catch (err) {
      const message = isNoDataReportError(err)
        ? `[QBO BACKFILL] month=${monthLabel} no eligible QBO Cash snapshot`
        : `[QBO BACKFILL] month=${monthLabel} failed ${err?.message || err}`;
      console.warn(message);
      await appendLog({ id: jobId, message });
      const afterFailure = await verifyEligibleHealthSnapshot({ businessId: business_id, year, month });
      const detail = afterFailure?.id
        ? buildResultDetail({ monthKey: monthLabel, status: "skipped", snapshotId: afterFailure.id, reused: true, error: err?.message || String(err) })
        : buildResultDetail({ monthKey: monthLabel, status: "failed", error: err?.error || err?.message || String(err) });
      details = mergeResultDetail(details, detail);
      await persistJobProgress({ jobId, expectedMonths, details, currentMonth: monthLabel });
    }

    if (MONTH_DELAY_MS > 0) {
      await sleep(MONTH_DELAY_MS);
    }
  }

  const finalDetails = expectedMonths.map((month) => details.find((row) => row.month === month) || { month, status: "failed", error: "month_not_attempted" });
  const finalCounts = countResults(finalDetails);
  const finalStatus = finalJobStatus({ counts: finalCounts, expectedTotal: expectedMonths.length });
  await persistJobProgress({
    jobId,
    expectedMonths,
    details: finalDetails,
    currentMonth: padMonthKey(anchorParts.year, anchorParts.month),
    status: finalStatus,
    finished: true,
  });
  if (finalStatus === "completed") {
    await ensureForecastV1Run({ businessId: business_id, horizonMonths: 12 }).catch((err) => {
      console.warn("[QBO BACKFILL] forecast_v1 generation skipped", err?.message || err);
    });
  }
}

export default runQboBackfill;

export async function createTrackedQboHealthBackfill({
  business_id,
  months = 12,
  startYear = null,
  startMonth = null,
  source = "qbo_connection_bootstrap",
  force = false,
  started_by = null,
}) {
  if (!business_id) throw new Error("business_id required");
  const active = await getLatestActiveJob({ business_id }).catch(() => null);
  if (active?.id) return { job: active, reused: true };

  const now = new Date();
  const anchorYear = Number(startYear) || now.getFullYear();
  const anchorMonth = Number(startMonth) || now.getMonth() + 1;
  const safeMonths = Math.max(1, Math.min(36, Number(months || 12)));
  const expectedMonths = trailingMonthWindow({ anchorYear, anchorMonth, count: safeMonths }).map((entry) => entry.monthKey.slice(0, 7));
  let job;
  try {
    job = await createJob({
      business_id,
      months_requested: safeMonths,
      months_total: safeMonths,
      start_year: anchorYear,
      start_month: anchorMonth,
      source,
      accounting_method: HEALTH_ACCOUNTING_METHOD,
      force,
      expected_months: expectedMonths,
      started_by,
    });
  } catch (err) {
    if (!isDuplicateActiveJobError(err)) throw err;
    const duplicateActive = await getLatestActiveJob({ business_id });
    if (!duplicateActive?.id) throw err;
    return { job: duplicateActive, reused: true };
  }
  return { job, reused: false };
}

export async function backfillLast12Months({
  business_id,
  realmId = null,
  accessToken = null,
  qboEnv = qboEnvName,
  startYear = null,
  startMonth = null,
  force = false,
}) {
  const months = 12;
  const now = new Date();
  const anchorYear = Number(startYear) || now.getFullYear();
  const anchorMonth = Number(startMonth) || now.getMonth() + 1;
  const { job } = await createTrackedQboHealthBackfill({
    business_id,
    months,
    startYear: anchorYear,
    startMonth: anchorMonth,
    source: "legacy_backfill_last_12_months",
    force,
  });
  try {
    await runQboBackfill({
      jobId: job.id,
      business_id,
      months_total: months,
      startYear: anchorYear,
      startMonth: anchorMonth,
      accounting_method: HEALTH_ACCOUNTING_METHOD,
      force,
      realmId,
      accessToken,
    });
  } catch (err) {
    console.warn("[BACKFILL] backfillLast12Months failed", err?.message || err, { business_id, qboEnv });
  }
  return job;
}
