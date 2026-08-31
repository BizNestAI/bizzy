// src/services/qboBackfillRunner.js
// Executes a bounded multi-month QBO Health snapshot backfill and updates job progress.

import {
  appendLog,
  createJob,
  getJobById,
  updateJob,
} from "./qboBackfillJobsService.js";
import { qboEnvName } from "../utils/qboEnv.js";
import {
  rangeLastNMonths,
  lastFullMonthParts,
} from "../utils/monthKey.js";
import {
  HEALTH_ACCOUNTING_METHOD,
  refreshMonthlyQboFinancialSnapshot,
} from "./accounting/healthMonthlySnapshotService.js";

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

export async function runQboBackfill({
  jobId,
  business_id,
  months_total = 12,
  startYear,
  startMonth,
  accounting_method = HEALTH_ACCOUNTING_METHOD,
  realmId: _realmIdOverride = null,
  accessToken: _accessTokenOverride = null,
}) {
  if (!jobId) throw new Error("jobId required");
  if (!business_id) throw new Error("business_id required");

  const anchorParts = (Number(startYear) && Number(startMonth))
    ? { year: Number(startYear), month: Number(startMonth) }
    : lastFullMonthParts();
  const months = rangeLastNMonths({ year: anchorParts.year, month: anchorParts.month, n: months_total });
  const job = await getJobById(jobId);
  const alreadyDone = Number(job?.months_done || 0);

  for (let idx = alreadyDone; idx < months.length; idx += 1) {
    const { year, month } = months[idx];
    const monthLabel = `${year}-${pad2(month)}`;

    const latest = await getJobById(jobId);
    if (latest?.status && latest.status !== "running") {
      await appendLog({ id: jobId, message: `stopped at ${monthLabel} status=${latest.status}` });
      return;
    }

    try {
      const summary = await refreshMonthlyQboFinancialSnapshot({
        businessId: business_id,
        year,
        month,
        source: "qbo_backfill",
        accountingMethod: accounting_method,
      });
      const message = `[QBO BACKFILL] month=${monthLabel} revenue=${summary.metrics.totalRevenue} expenses=${summary.metrics.totalExpenses} profit=${summary.metrics.netProfit}`;
      console.log(message);
      await appendLog({ id: jobId, message });
      await updateJob({
        id: jobId,
        patch: {
          months_done: idx + 1,
          last_month_processed: monthLabel,
          last_success_at: summary.snapshot?.last_successful_refresh_at || new Date().toISOString(),
          last_error: null,
        },
      });
    } catch (err) {
      if (isNoDataReportError(err)) {
        const message = `[QBO BACKFILL] month=${monthLabel} no QBO financial activity`;
        console.info(message);
        await appendLog({ id: jobId, message });
        await updateJob({
          id: jobId,
          patch: {
            months_done: idx + 1,
            last_month_processed: monthLabel,
            last_error: null,
          },
        });
      } else {
        await updateJob({
          id: jobId,
          patch: {
            status: "failed",
            last_error: err?.message || String(err),
            finished_at: new Date().toISOString(),
          },
        });
        throw err;
      }
    }

    if (idx < months.length - 1 && MONTH_DELAY_MS > 0) {
      await sleep(MONTH_DELAY_MS);
    }
  }

  await updateJob({
    id: jobId,
    patch: {
      status: "completed",
      months_done: months.length,
      last_month_processed: `${anchorParts.year}-${pad2(anchorParts.month)}`,
      finished_at: new Date().toISOString(),
    },
  });
}

export default runQboBackfill;

export async function backfillLast12Months({
  business_id,
  realmId = null,
  accessToken = null,
  qboEnv = qboEnvName,
  startYear = null,
  startMonth = null,
}) {
  const months = 12;
  const job = await createJob({
    business_id,
    months_requested: months,
    months_total: months,
    start_year: startYear,
    start_month: startMonth,
  });
  try {
    await runQboBackfill({
      jobId: job.id,
      business_id,
      months_total: months,
      startYear,
      startMonth,
      accounting_method: HEALTH_ACCOUNTING_METHOD,
      realmId,
      accessToken,
    });
  } catch (err) {
    console.warn("[BACKFILL] backfillLast12Months failed", err?.message || err, { business_id, qboEnv });
  }
  return job;
}
