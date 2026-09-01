// /src/api/accounting/qbo-backfill.routes.js
/* global process */
import express from "express";

import {
  appendLog,
  createJob,
  getLatestActiveJob,
  getLatestJob,
  updateJob,
} from "../../services/qboBackfillJobsService.js";
import { runQboBackfill } from "../../services/qboBackfillRunner.js";
import { HEALTH_ACCOUNTING_METHOD } from "../../services/accounting/healthMonthlySnapshotService.js";
import { trailingMonthWindow } from "../../utils/monthKey.js";

const router = express.Router();
const activeRuns = new Set();
const ACTIVE_JOB_STALE_MS = Number(process.env.QBO_BACKFILL_ACTIVE_STALE_MS || 2 * 60 * 60 * 1000);

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
    force: Boolean(opts.force),
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

function readBool(value) {
  return ["true", "1", "yes", "y", "on"].includes(String(value || "").toLowerCase());
}

function defaultAnchor() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function readAnchor(req) {
  const fallback = defaultAnchor();
  const year = Number(req.body?.anchor_year || req.body?.anchorYear || req.body?.start_year || req.body?.startYear || req.query?.anchor_year || req.query?.anchorYear || fallback.year);
  const month = Number(req.body?.anchor_month || req.body?.anchorMonth || req.body?.start_month || req.body?.startMonth || req.query?.anchor_month || req.query?.anchorMonth || fallback.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    const err = new Error("invalid_anchor_year");
    err.status = 400;
    throw err;
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    const err = new Error("invalid_anchor_month");
    err.status = 400;
    throw err;
  }
  return { year, month };
}

function isStaleActiveJob(job) {
  if (!job || !["queued", "running"].includes(job.status)) return false;
  const started = Date.parse(job.started_at || job.created_at || "");
  if (!Number.isFinite(started)) return false;
  return Date.now() - started > ACTIVE_JOB_STALE_MS;
}

function normalizeStatus(job) {
  if (!job) return { status: "idle" };
  const expected = Array.isArray(job.expected_months) ? job.expected_months : [];
  const succeeded = Array.isArray(job.succeeded_months) ? job.succeeded_months : [];
  const skipped = Array.isArray(job.skipped_months) ? job.skipped_months : [];
  const failed = Array.isArray(job.failed_months) ? job.failed_months : [];
  const coverage = succeeded.length + skipped.length;
  return {
    job_id: job.id,
    status: job.status || "unknown",
    accounting_method: job.accounting_method || HEALTH_ACCOUNTING_METHOD,
    force: Boolean(job.force),
    source: job.source || null,
    anchor: {
      year: job.anchor_year || null,
      month: job.anchor_month || null,
    },
    window: {
      start_month: job.window_start_month || expected[0] || null,
      end_month: job.window_end_month || expected.at(-1) || null,
      expected_months: expected,
    },
    months_total: job.months_total ?? (expected.length || null),
    months_done: job.months_done ?? 0,
    months_attempted: job.months_attempted ?? job.months_done ?? 0,
    months_succeeded: job.months_succeeded ?? succeeded.length,
    months_skipped: job.months_skipped ?? skipped.length,
    months_failed: job.months_failed ?? failed.length,
    snapshot_coverage_count: coverage,
    succeeded,
    skipped,
    failed,
    result_details: Array.isArray(job.result_details) ? job.result_details : [],
    current_month: job.last_month_processed || null,
    started_at: job.started_at || null,
    finished_at: job.finished_at || null,
    last_success_at: job.last_success_at || null,
    last_error: job.last_error || job.error || null,
    last_log: job.last_log || null,
    terminal: ["completed", "partial", "failed", "canceled", "cancelled"].includes(job.status),
  };
}

function isDuplicateActiveJobError(err) {
  return /23505|duplicate key|unique constraint/i.test(String(err?.message || err || ""));
}

router.post("/start", async (req, res) => {
  try {
    const business_id = readBusinessId(req);
    if (!business_id) return res.status(400).json({ error: "missing_business_id" });

    const actor = readUserId(req);
    const months = Math.max(1, Math.min(36, Number(req.body?.months || req.query?.months || 12) || 12));
    const accounting_method = HEALTH_ACCOUNTING_METHOD;
    const force = readBool(req.body?.force ?? req.query?.force);
    const anchor = readAnchor(req);
    const expectedMonths = trailingMonthWindow({ anchorYear: anchor.year, anchorMonth: anchor.month, count: months }).map((entry) => entry.monthKey.slice(0, 7));
    const source = req.body?.source || req.query?.source || (force ? "settings_force_reimport" : "settings_import_missing_history");

    const active = await getLatestActiveJob({ business_id }).catch(() => null);
    if (active) {
      if (isStaleActiveJob(active)) {
        await updateJob({
          id: active.id,
          patch: {
            status: "failed",
            last_error: "active job expired before completion",
            finished_at: new Date().toISOString(),
          },
        });
      } else {
        kickOff(active, {
          months: active.months_total || months,
          startYear: active.anchor_year || anchor.year,
          startMonth: active.anchor_month || anchor.month,
          accounting_method: active.accounting_method || accounting_method,
          force: Boolean(active.force),
        });
        return res.status(202).json(normalizeStatus(active));
      }
    }

    let job;
    try {
      job = await createJob({
        business_id,
        months_requested: months,
        months_total: months,
        start_year: anchor.year,
        start_month: anchor.month,
        source,
        accounting_method,
        force,
        expected_months: expectedMonths,
        started_by: actor,
      });
    } catch (createErr) {
      if (!isDuplicateActiveJobError(createErr)) throw createErr;
      const duplicateActive = await getLatestActiveJob({ business_id });
      if (!duplicateActive) throw createErr;
      kickOff(duplicateActive, {
        months: duplicateActive.months_total || months,
        startYear: duplicateActive.anchor_year || anchor.year,
        startMonth: duplicateActive.anchor_month || anchor.month,
        accounting_method: duplicateActive.accounting_method || accounting_method,
        force: Boolean(duplicateActive.force),
      });
      return res.status(202).json(normalizeStatus(duplicateActive));
    }

    kickOff(job, { months, startYear: anchor.year, startMonth: anchor.month, accounting_method, force });
    return res.status(202).json(normalizeStatus(job));
  } catch (err) {
    console.error("[qbo/backfill/start] failed", err?.message || err);
    return res.status(err?.status || 500).json({ error: err?.message || "backfill_start_failed" });
  }
});

router.get("/status", async (req, res) => {
  try {
    const business_id = readBusinessId(req);
    if (!business_id) return res.status(400).json({ error: "missing_business_id" });
    const job = await getLatestJob({ business_id });
    if (!job) return res.status(200).json({ status: "idle", terminal: true });
    if (["queued", "running"].includes(job.status)) {
      if (isStaleActiveJob(job)) {
        const expired = await updateJob({
          id: job.id,
          patch: {
            status: "failed",
            last_error: "active job expired before completion",
            finished_at: new Date().toISOString(),
          },
        });
        return res.status(200).json(normalizeStatus(expired || job));
      }
      kickOff(job, {
        months: job.months_total || 12,
        startYear: job.anchor_year,
        startMonth: job.anchor_month,
        accounting_method: job.accounting_method || HEALTH_ACCOUNTING_METHOD,
        force: Boolean(job.force),
      });
    }
    return res.status(200).json(normalizeStatus(job));
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
    if (!["queued", "running"].includes(job.status)) {
      return res.status(200).json({ job_id: job.id, status: job.status });
    }
    await updateJob({
      id: job.id,
      patch: {
        status: "canceled",
        last_error: "cancelled by user",
        last_log: "cancelled by user",
        finished_at: new Date().toISOString(),
      },
    });
    await appendLog({ id: job.id, message: "cancelled by user" });
    return res.status(200).json({ job_id: job.id, status: "canceled" });
  } catch (err) {
    console.error("[qbo/backfill/cancel] failed", err?.message || err);
    return res.status(500).json({ error: err?.message || "backfill_cancel_failed" });
  }
});

export default router;
