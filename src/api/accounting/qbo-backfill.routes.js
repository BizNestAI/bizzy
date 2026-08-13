// /src/api/accounting/qbo-backfill.routes.js
import express from "express";

import {
  appendLog,
  createJob,
  getLatestJob,
  updateJob,
} from "../../services/qboBackfillJobsService.js";
import { runQboBackfill } from "../../services/qboBackfillRunner.js";

const router = express.Router();
const activeRuns = new Set();

function readBusinessId(req) {
  return (
    req.business?.id ||
    req.auth?.businessId ||
    req.body?.business_id ||
    req.body?.businessId ||
    req.query?.business_id ||
    req.query?.businessId ||
    req.headers["x-business-id"] ||
    null
  );
}

function readUserId(req) {
  return (
    req.auth?.userId ||
    req.user?.id ||
    req.body?.user_id ||
    req.body?.userId ||
    req.headers["x-user-id"] ||
    null
  );
}

function kickOff(job, opts) {
  const key = job.id;
  if (activeRuns.has(key)) return;
  activeRuns.add(key);
  runQboBackfill({
    jobId: job.id,
    business_id: job.business_id,
    months_total: opts.months,
    startYear: opts.startYear,
    startMonth: opts.startMonth,
    accounting_method: opts.accounting_method,
  })
    .catch((err) => {
      updateJob({
        id: job.id,
        patch: {
          status: "failed",
          last_error: err?.message || String(err),
          last_log: err?.message || "backfill failed",
          finished_at: new Date().toISOString(),
        },
      }).catch(() => {});
    })
    .finally(() => {
      activeRuns.delete(key);
    });
}

router.post("/start", async (req, res) => {
  try {
    const business_id = readBusinessId(req);
    if (!business_id) return res.status(400).json({ error: "missing_business_id" });

    const months = Number(req.body?.months || 12) || 12;
    const mode = String(req.body?.mode || "cash").toLowerCase();
    const accounting_method = mode === "accrual" ? "Accrual" : "Cash";
    const startYear = req.body?.start_year || req.body?.startYear || null;
    const startMonth = req.body?.start_month || req.body?.startMonth || null;

    const latest = await getLatestJob({ business_id, status: "running" }).catch(() => null);
    if (latest && latest.status === "running") {
      return res.status(200).json({ job_id: latest.id, status: latest.status });
    }

    const job = await createJob({
      business_id,
      months_requested: months,
      months_total: months,
      start_year: startYear ? Number(startYear) : null,
      start_month: startMonth ? Number(startMonth) : null,
    });

    kickOff(job, { months, startYear, startMonth, accounting_method });
    return res.status(200).json({ job_id: job.id });
  } catch (err) {
    console.error("[qbo/backfill/start] failed", err?.message || err);
    return res.status(500).json({ error: err?.message || "backfill_start_failed" });
  }
});

router.get("/status", async (req, res) => {
  try {
    const business_id = readBusinessId(req);
    if (!business_id) return res.status(400).json({ error: "missing_business_id" });
    const job = await getLatestJob({ business_id });
    if (!job) return res.status(200).json({ status: "idle" });
    const {
      id,
      status = "unknown",
      months_total,
      months_done,
      last_month_processed,
      started_at,
      finished_at,
      last_error,
      last_log,
      months_requested,
    } = job;
    return res.status(200).json({
      job_id: id,
      status: status || "unknown",
      months_total: months_total ?? months_requested ?? null,
      months_done: months_done ?? 0,
      current_month: last_month_processed,
      started_at,
      finished_at,
      last_error,
      last_log,
    });
  } catch (err) {
    console.error("[qbo/backfill/status] failed", err?.message || err);
    return res.status(500).json({ error: err?.message || "backfill_status_failed" });
  }
});

router.post("/cancel", async (req, res) => {
  try {
    const business_id = readBusinessId(req);
    if (!business_id) return res.status(400).json({ error: "missing_business_id" });
    const job = await getLatestJob({ business_id });
    if (!job) return res.status(404).json({ error: "no_job" });
    if (job.status !== "running") {
      return res.status(200).json({ job_id: job.id, status: job.status });
    }
    await updateJob({
      id: job.id,
      patch: {
        status: "cancelled",
        last_error: "cancelled by user",
        last_log: "cancelled by user",
        finished_at: new Date().toISOString(),
      },
    });
    await appendLog({ id: job.id, message: "cancelled by user" });
    return res.status(200).json({ job_id: job.id, status: "cancelled" });
  } catch (err) {
    console.error("[qbo/backfill/cancel] failed", err?.message || err);
    return res.status(500).json({ error: err?.message || "backfill_cancel_failed" });
  }
});

export default router;
