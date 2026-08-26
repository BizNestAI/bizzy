import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { computeReconciliationRun } from "../../../services/bookkeeping/reconciliationRunService.js";
import { evaluateReconciliationStatus } from "../../../services/bookkeeping/reconciliationEvaluator.js";
import { triggerContractorCfoInsightsBestEffort } from "../../../services/insights/contractorCfoTriggerService.js";
import { loadMonthlyReconciliationPipeline } from "../../../services/bookkeeping/monthlyReconciliationPipelineService.js";

const router = Router();

const FIVE_MIN_MS = 5 * 60 * 1000;
const ACCOUNT_HEALTH_STALE_MS = 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SAFE_RECONCILIATION_ERROR_MESSAGE =
  "An internal issue occurred during reconciliation. Bizzi will retry automatically.";

function parseLimit(val, def = DEFAULT_LIMIT) {
  const n = Number.parseInt(val, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

function parseOffset(val) {
  const n = Number.parseInt(val, 10);
  if (Number.isNaN(n) || n < 0) return 0;
  return n;
}

function parseDate(d) {
  if (!d) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? d : null;
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function monthKeyFromDate(value) {
  const date = parseDate(String(value || "").slice(0, 10));
  return date ? date.slice(0, 7) : null;
}

function parseStatuses(input) {
  if (!input) return [];
  const raw = String(input)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!raw.length) return [];
  if (raw.includes("all")) return [];
  return Array.from(new Set(raw));
}

function parseRange(range, dateFrom, dateTo) {
  const from = parseDate(dateFrom);
  const to = parseDate(dateTo);
  if (from && to) return { date_from: from, date_to: to, scope: "custom" };
  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  let start = null;
  const r = (range || "").toLowerCase();
  const isAll = ["all", "all_dates", "all_time"].includes(r);
  const isThisMonth = ["this_month", "current_month", "month"].includes(r);
  const is90 = ["last_90", "last90", "last_90_days", "90"].includes(r);
  const is30 = ["last_30", "last30", "last_30_days", "30", ""].includes(r);
  if (isAll) {
    return { date_from: null, date_to: null, scope: "all" };
  }
  if (isThisMonth) {
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    return {
      date_from: monthStart.toISOString().slice(0, 10),
      date_to: monthEnd.toISOString().slice(0, 10),
      scope: "this_month",
    };
  }
  if (is90) {
    start = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
  } else if (is30) {
    start = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else {
    start = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  return { date_from: start.toISOString().slice(0, 10), date_to: end, scope: range || "last_30_days" };
}

function sameRunRequestScope(run, opts = {}) {
  if (!run) return false;
  const runStart = run.period_start ? String(run.period_start).slice(0, 10) : null;
  const runEnd = run.period_end ? String(run.period_end).slice(0, 10) : null;
  const requestedStart = opts.date_from ? String(opts.date_from).slice(0, 10) : null;
  const requestedEnd = opts.date_to ? String(opts.date_to).slice(0, 10) : null;
  const requestedScope = opts.scope || null;
  const runScope = run.scope || null;

  if (requestedStart || requestedEnd) {
    return runStart === requestedStart && runEnd === requestedEnd;
  }
  return runScope === requestedScope;
}

async function pickLatestRun(businessId) {
  const { data, error } = await supabase
    .from("reconciliation_runs")
    .select("*")
    .eq("business_id", businessId)
    .order("last_checked_at", { ascending: false, nullsLast: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function pickLatestMatchingRun(businessId, opts = {}) {
  let query = supabase
    .from("reconciliation_runs")
    .select("*")
    .eq("business_id", businessId)
    .order("last_checked_at", { ascending: false, nullsLast: true });

  if (opts.date_from) query = query.eq("period_start", opts.date_from);
  if (opts.date_to) query = query.eq("period_end", opts.date_to);
  if (!opts.date_from && !opts.date_to && opts.scope) query = query.eq("scope", opts.scope);

  const { data, error } = await query.limit(10);
  if (error) throw error;

  const requestedAccountId = opts.plaid_account_id || null;
  return (
    (data || []).find((row) => (row?.details?.opts?.plaid_account_id || null) === requestedAccountId) ||
    data?.[0] ||
    null
  );
}

function shapeRunSummary(run) {
  if (!run) return null;
  const detailsCounts = run.details?.counts || {};
  return {
    run_id: run.id,
    status: run.status || "unknown",
    overall_status: run.status || "unknown",
    overall_note: run.overall_note || null,
    last_checked_at: run.last_checked_at || run.updated_at || null,
    scope: run.scope || null,
    period_start: run.period_start || null,
    period_end: run.period_end || null,
    details: run.details || null,
    counts: {
      total_seen: run.total_seen || 0,
      matched_count: run.matched_count || 0,
      needs_review_count: run.needs_review_count || 0,
      handled_not_posted_count: detailsCounts.handled_not_posted_count || 0,
      approved_waiting_post_count: run.approved_waiting_post_count || 0,
      pending_count: run.pending_count || 0,
      failed_post_count: run.failed_post_count || 0,
      missing_in_qbo_count: run.missing_in_qbo_count || 0,
      duplicate_in_qbo_count: run.duplicate_in_qbo_count || 0,
    },
  };
}

function calmCopy(status, hasRun) {
  if (!hasRun) return { headline: "Status unavailable", subtext: "Bizzi will run monitoring automatically." };
  if (status === "ok") {
    return { headline: "All eligible transactions matched", subtext: "Some items may still be pending review." };
  }
  if (status === "investigating") {
    return { headline: "Investigating discrepancy", subtext: "Bizzi is retrying quietly and watching integrity." };
  }
  if (status === "partial") {
    return { headline: "Partial status", subtext: "Bizzi is still collecting enough data to confirm integrity." };
  }
  if (status === "failed") {
    return { headline: "Monitoring paused", subtext: "Bizzi will retry automatically." };
  }
  return { headline: "Status unavailable", subtext: "Bizzi will run monitoring automatically." };
}

function shapeAccountHealthRows(rows = []) {
  const SENTINEL_ACCOUNT_ID = "__recon_sentinel__";
  return (rows || [])
    .filter((row) => row?.plaid_account_id !== SENTINEL_ACCOUNT_ID)
    .map((row) => {
      const details = row?.details || {};
      const notesText = Array.isArray(details?.notes)
        ? details.notes.join("; ")
        : details?.note || null;
      return {
        plaid_account_id: row?.plaid_account_id || null,
        plaid_account_name: details?.plaid_account_name || row?.plaid_account_name || null,
        plaid_account_mask: details?.plaid_account_mask || row?.plaid_account_mask || null,
        status: row?.status || "unknown",
        diff_amount: row?.diff_amount != null ? Number(row.diff_amount) : null,
        bank_balance:
          row?.bank_balance != null
            ? Number(row.bank_balance)
            : details?.bank_balance != null
            ? Number(details.bank_balance)
            : null,
        book_balance:
          row?.book_balance != null
            ? Number(row.book_balance)
            : details?.book_balance != null
            ? Number(details.book_balance)
            : null,
        last_checked_at: row?.last_checked_at || null,
        explanation_summary: details?.explanation_summary || notesText || null,
        linked_qbo_account_id: details?.linked_qbo_account_id || details?.qbo_account_id || row?.linked_qbo_account_id || null,
        linked_qbo_account_name:
          details?.linked_qbo_account_name || details?.qbo_account_name || row?.linked_qbo_account_name || null,
        linked_qbo_account_type:
          details?.linked_qbo_account_type || details?.qbo_account_type || row?.linked_qbo_account_type || null,
        comparison_mode: details?.comparison_mode || row?.comparison_mode || null,
        balance_source: details?.balance_source || details?.book_balance_source || row?.balance_source || null,
        pending_txn_count: details?.pending_txn_count ?? row?.pending_txn_count ?? null,
        needs_review_count: details?.needs_review_count ?? row?.needs_review_count ?? null,
        approved_waiting_to_post_count:
          details?.approved_waiting_to_post_count ?? row?.approved_waiting_to_post_count ?? null,
        posted_txn_count: details?.posted_txn_count ?? row?.posted_txn_count ?? null,
        last_posted_at: details?.last_posted_at || row?.last_posted_at || null,
        last_sync_at: details?.last_sync_at || row?.last_sync_at || null,
        notes: Array.isArray(details?.explanation_notes)
          ? details.explanation_notes
          : Array.isArray(details?.notes)
          ? details.notes
          : Array.isArray(row?.notes)
          ? row.notes
          : [],
        note: notesText || null,
        details: details || null,
      };
    });
}

async function fetchStoredAccountHealth(businessId) {
  const { data: healthRows, error } = await supabase
    .from("reconciliation_health")
    .select("plaid_account_id,status,diff_amount,bank_balance,book_balance,last_checked_at,details")
    .eq("business_id", businessId);
  if (error) throw error;
  const rows = shapeAccountHealthRows(healthRows || []);
  const latestCheckedAt = rows
    .map((row) => row?.last_checked_at || null)
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0] || null;
  return { rows, latestCheckedAt };
}

function computeAccountHealthStale({ latestRun, latestHealthCheckedAt, healthRowCount }) {
  if (!latestRun) return false;
  if (!healthRowCount) return false;

  const runTs = latestRun?.last_checked_at ? Date.parse(latestRun.last_checked_at) : null;
  const healthTs = latestHealthCheckedAt || null;
  const now = Date.now();

  if (!Number.isFinite(healthTs)) return false;
  if (Number.isFinite(runTs) && healthTs < runTs) return true;
  if (now - healthTs > ACCOUNT_HEALTH_STALE_MS) return true;
  return false;
}

async function summarizeAccountsFromItems(businessId, runId) {
  const { data, error } = await supabase
    .from("reconciliation_items")
    .select("plaid_account_id,status")
    .eq("business_id", businessId)
    .eq("run_id", runId);
  if (error) return [];
  const map = new Map();
  (data || []).forEach((row) => {
    const key = row.plaid_account_id || "unknown";
    const entry = map.get(key) || { plaid_account_id: row.plaid_account_id, status: row.status, count: 0 };
    entry.count += 1;
    map.set(key, entry);
  });
  return Array.from(map.values());
}

async function fetchLatestRunSummary(businessId) {
  const latest = await pickLatestRun(businessId);
  const summary = shapeRunSummary(latest);
  return { latest, summary };
}

async function pickRunById(businessId, runId) {
  if (!runId) return null;
  const { data, error } = await supabase
    .from("reconciliation_runs")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", runId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

router.post("/reconciliations/run", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const body = req.body || {};
    const range = body.range || "last_30_days";
    const parsedRange = parseRange(range, body.date_from, body.date_to);
    const opts = {
      scope: parsedRange.scope,
      date_from: parsedRange.date_from,
      date_to: parsedRange.date_to,
      plaid_account_id: body.plaid_account_id || null,
      include_pending: body.include_pending !== false,
      include_archived: body.include_archived !== false,
    };

    const latest = await pickLatestMatchingRun(businessId, opts);
    const now = Date.now();
    const latestTs = latest?.last_checked_at ? Date.parse(latest.last_checked_at) : null;
    if (latest && latestTs && sameRunRequestScope(latest, opts) && now - latestTs < FIVE_MIN_MS) {
      const summary = shapeRunSummary(latest);
      const accounts_summary = latest ? await summarizeAccountsFromItems(businessId, latest.id) : [];
      let account_health = [];
      let account_health_error = false;
      try {
        const result = await fetchStoredAccountHealth(businessId);
        account_health = result.rows;
      } catch (healthErr) {
        console.error("[reconciliations][run] account health fetch failed", healthErr?.message || healthErr);
        account_health_error = true;
      }
      return res.json({
        ok: true,
        run_id: latest?.id || null,
        overall_status: summary?.overall_status || "unknown",
        overall_note: summary?.overall_note || null,
        last_checked_at: summary?.last_checked_at || null,
        counts: summary?.counts || {},
        accounts_summary,
        account_health,
        account_health_error,
        rate_limited: true,
      });
    }

    const computed = await computeReconciliationRun(businessId, opts);
    let account_health = [];
    let account_health_error = false;
    try {
      const healthResult = await evaluateReconciliationStatus(businessId);
      account_health = shapeAccountHealthRows(healthResult?.perAccount || []);
    } catch (healthErr) {
      console.error("[reconciliations][run] account health refresh failed", healthErr?.message || healthErr);
      account_health = [];
      account_health_error = true;
    }
    const latestAfter = computed?.run_id
      ? await pickRunById(businessId, computed.run_id)
      : await pickLatestMatchingRun(businessId, opts);
    const summaryAfter = shapeRunSummary(latestAfter);
    const accounts_summary = latestAfter ? await summarizeAccountsFromItems(businessId, latestAfter.id) : [];
    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "reconciliation",
      force: false,
    });

    return res.json({
      ok: true,
      run_id: summaryAfter?.run_id || null,
      overall_status: summaryAfter?.overall_status || "unknown",
      overall_note: summaryAfter?.overall_note || null,
      last_checked_at: summaryAfter?.last_checked_at || null,
      counts: summaryAfter?.counts || {},
      accounts_summary,
      account_health,
      account_health_error,
    });
  } catch (err) {
    console.error("[reconciliations][run] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "reconciliation_run_failed", message: SAFE_RECONCILIATION_ERROR_MESSAGE });
  }
});

router.get("/reconciliations/status", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const { latest, summary } = await fetchLatestRunSummary(businessId);
    let account_health = [];
    let account_health_error = false;
    let account_health_stale = false;
    try {
      const healthResult = await fetchStoredAccountHealth(businessId);
      account_health = healthResult.rows;
      account_health_stale = computeAccountHealthStale({
        latestRun: summary,
        latestHealthCheckedAt: healthResult.latestCheckedAt,
        healthRowCount: healthResult.rows.length,
      });
    } catch (healthErr) {
      console.error("[reconciliations][status] account health fetch failed", healthErr?.message || healthErr);
      account_health_error = true;
    }

    const copy = calmCopy(summary?.overall_status || "unknown", !!latest);

    return res.json({
      ok: true,
      latest_run: summary,
      account_health,
      account_health_error,
      account_health_stale,
      calm_copy: copy,
    });
  } catch (err) {
    console.error("[reconciliations][status] failed", err?.message || err);
    return res
      .status(500)
      .json({ ok: false, error: "reconciliation_status_failed", message: SAFE_RECONCILIATION_ERROR_MESSAGE });
  }
});

router.get("/reconciliations/transactions", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const limit = parseLimit(req.query?.limit);
    const offset = parseOffset(req.query?.offset);
    const plaidAccountId = req.query?.plaid_account_id || null;
    const statusFilters = parseStatuses(req.query?.status);
    const runId = req.query?.run_id || null;
    const range = req.query?.range || "last_30_days";
    const parsed = parseRange(range, req.query?.date_from, req.query?.date_to);
    const dateFrom = parsed.date_from;
    const dateTo = parsed.date_to;
    const search = (req.query?.search || "").trim();

    if (globalThis?.process?.env?.NODE_ENV !== "production") {
      console.info("[reconciliations][transactions] resolved_range", {
        businessId,
        requested_range: range || null,
        requested_date_from: req.query?.date_from || null,
        requested_date_to: req.query?.date_to || null,
        resolved_scope: parsed?.scope || null,
        resolved_date_from: dateFrom || null,
        resolved_date_to: dateTo || null,
      });
    }

    const runSummaryRow = runId ? await pickRunById(businessId, runId) : await pickLatestRun(businessId);
    const month =
      req.query?.month ||
      monthKeyFromDate(dateFrom) ||
      monthKeyFromDate(runSummaryRow?.period_start || runSummaryRow?.period_end || runSummaryRow?.last_checked_at) ||
      currentMonthKey();
    const pipeline = await loadMonthlyReconciliationPipeline(businessId, {
      month,
      plaid_account_id: plaidAccountId || null,
      status: statusFilters.length ? statusFilters.join(",") : null,
      search,
      limit,
      offset,
    });
    const run_summary = shapeRunSummary(runSummaryRow) || {
      run_id: null,
      status: "not_run",
      overall_status: "not_run",
      overall_note: "No reconciliation run exists for this month yet.",
      last_checked_at: null,
      scope: "month",
      period_start: pipeline.start,
      period_end: new Date(Date.parse(`${pipeline.end}T00:00:00.000Z`) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      details: { source: "monthly_reconciliation_pipeline" },
      counts: {
        total_seen: pipeline.totals.plaid_transactions_count || 0,
        needs_review_count: pipeline.totals.needs_review_count || 0,
        handled_not_posted_count: pipeline.totals.handled_not_posted_count || 0,
        matched_count: pipeline.totals.posted_matched_count || 0,
        failed_post_count: pipeline.totals.posting_failed_count || 0,
        duplicate_in_qbo_count: 0,
        missing_in_qbo_count: 0,
      },
    };

    return res.json({
      ok: true,
      rows: pipeline.rows,
      total: pipeline.total,
      run_summary,
      pipeline_totals: pipeline.totals,
      source_contract: pipeline.source_contract,
      month: pipeline.month,
    });
  } catch (err) {
    console.error("[reconciliations][transactions] failed", err?.message || err);
    return res
      .status(500)
      .json({ ok: false, error: "reconciliation_transactions_failed", message: SAFE_RECONCILIATION_ERROR_MESSAGE });
  }
});

router.get("/reconciliations/runs", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const limit = parseLimit(req.query?.limit, 10);
    const { data, error } = await supabase
      .from("reconciliation_runs")
      .select("*")
      .eq("business_id", businessId)
      .order("last_checked_at", { ascending: false, nullsLast: true })
      .limit(limit);
    if (error) throw error;
    const runs = (data || []).map((r) => shapeRunSummary(r));
    return res.json({ ok: true, runs });
  } catch (err) {
    console.error("[reconciliations][runs] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "reconciliation_runs_failed", message: SAFE_RECONCILIATION_ERROR_MESSAGE });
  }
});

export default router;
