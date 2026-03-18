import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { computeReconciliationRun } from "../../../services/bookkeeping/reconciliationRunService.js";

const router = Router();

const FIVE_MIN_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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

function parseRange(range, dateFrom, dateTo) {
  const from = parseDate(dateFrom);
  const to = parseDate(dateTo);
  if (from && to) return { date_from: from, date_to: to, scope: "custom" };
  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  let start = null;
  const r = (range || "").toLowerCase();
  const is90 = ["last_90", "last90", "last_90_days", "90"].includes(r);
  const is30 = ["last_30", "last30", "last_30_days", "30", ""].includes(r);
  if (is90) {
    start = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
  } else if (is30) {
    start = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else {
    start = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  return { date_from: start.toISOString().slice(0, 10), date_to: end, scope: range || "last_30_days" };
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

function shapeRunSummary(run) {
  if (!run) return null;
  return {
    run_id: run.id,
    overall_status: run.status || "unknown",
    overall_note: run.overall_note || null,
    last_checked_at: run.last_checked_at || run.updated_at || null,
    scope: run.scope || null,
    period_start: run.period_start || null,
    period_end: run.period_end || null,
    counts: {
      total_seen: run.total_seen || 0,
      matched_count: run.matched_count || 0,
      needs_review_count: run.needs_review_count || 0,
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
      include_pending: body.include_pending === true,
    };

    const latest = await pickLatestRun(businessId);
    const now = Date.now();
    const latestTs = latest?.last_checked_at ? Date.parse(latest.last_checked_at) : null;
    if (latest && latestTs && now - latestTs < FIVE_MIN_MS) {
      const summary = shapeRunSummary(latest);
      const accounts_summary = latest ? await summarizeAccountsFromItems(businessId, latest.id) : [];
      return res.json({
        ok: true,
        run_id: latest?.id || null,
        overall_status: summary?.overall_status || "unknown",
        overall_note: summary?.overall_note || null,
        last_checked_at: summary?.last_checked_at || null,
        counts: summary?.counts || {},
        accounts_summary,
        rate_limited: true,
      });
    }

    const result = await computeReconciliationRun(businessId, opts);
    const latestAfter = await pickLatestRun(businessId);
    const summaryAfter = shapeRunSummary(latestAfter);
    const accounts_summary = latestAfter ? await summarizeAccountsFromItems(businessId, latestAfter.id) : [];

    return res.json({
      ok: true,
      run_id: summaryAfter?.run_id || null,
      overall_status: summaryAfter?.overall_status || "unknown",
      overall_note: summaryAfter?.overall_note || null,
      last_checked_at: summaryAfter?.last_checked_at || null,
      counts: summaryAfter?.counts || {},
      accounts_summary,
    });
  } catch (err) {
    console.error("[reconciliations][run] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "reconciliation_run_failed", message: err?.message || "failed" });
  }
});

router.get("/reconciliations/status", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const SENTINEL_ACCOUNT_ID = "__recon_sentinel__";
  try {
    const { latest, summary } = await fetchLatestRunSummary(businessId);

    const { data: healthRows } = await supabase
      .from("reconciliation_health")
      .select("plaid_account_id,status,diff_amount,last_checked_at,details")
      .eq("business_id", businessId);

    const account_health = (healthRows || [])
      .filter((row) => row.plaid_account_id !== SENTINEL_ACCOUNT_ID)
      .map((row) => {
        const notes = Array.isArray(row.details?.notes) ? row.details.notes.join("; ") : row.details?.note || null;
        return {
          plaid_account_id: row.plaid_account_id,
          status: row.status || "unknown",
          diff_amount: row.diff_amount != null ? Number(row.diff_amount) : null,
          last_checked_at: row.last_checked_at || null,
          note: notes || null,
        };
      });

    const copy = calmCopy(summary?.overall_status || "unknown", !!latest);

    return res.json({
      ok: true,
      latest_run: summary,
      account_health,
      calm_copy: copy,
    });
  } catch (err) {
    console.error("[reconciliations][status] failed", err?.message || err);
    return res
      .status(500)
      .json({ ok: false, error: "reconciliation_status_failed", message: err?.message || "failed" });
  }
});

router.get("/reconciliations/transactions", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const limit = parseLimit(req.query?.limit);
    const offset = parseOffset(req.query?.offset);
    const plaidAccountId = req.query?.plaid_account_id || null;
    const statusFilter = req.query?.status || "matched";
    const runId = req.query?.run_id || null;
    const range = req.query?.range || "last_30_days";
    const parsed = parseRange(range, req.query?.date_from, req.query?.date_to);
    const dateFrom = parsed.date_from;
    const dateTo = parsed.date_to;
    const search = (req.query?.search || "").trim();

    let resolvedRunId = runId;
    if (!resolvedRunId) {
      const latest = await pickLatestRun(businessId);
      resolvedRunId = latest?.id || null;
    }
    if (!resolvedRunId) {
      return res.json({ ok: true, rows: [], total: 0, run_summary: null });
    }

    const baseFilters = supabase
      .from("reconciliation_items")
      .select(
        "id,run_id,plaid_account_id,txn_date,merchant,description,amount,direction,category_name,posted_at,reconciled_at,qbo_txn_id,qbo_txn_type,status,note",
        { count: "exact" }
      )
      .eq("business_id", businessId)
      .eq("run_id", resolvedRunId);

    let query = baseFilters;
    if (plaidAccountId) query = query.eq("plaid_account_id", plaidAccountId);
    if (statusFilter) query = query.eq("status", statusFilter);
    if (dateFrom) query = query.gte("txn_date", dateFrom);
    if (dateTo) query = query.lte("txn_date", dateTo);
    const safeSearch = String(search || "").replace(/[,]/g, " ").trim();
    if (safeSearch) {
      query = query.or(`merchant.ilike.%${safeSearch}%,description.ilike.%${safeSearch}%`);
    }
    query = query.order("txn_date", { ascending: false, nullsLast: true }).range(offset, offset + limit - 1);

    const { data: rows, error, count } = await query;
    if (error) throw error;

    const runSummaryRow = await pickRunById(businessId, resolvedRunId);
    const run_summary = shapeRunSummary(runSummaryRow);

    return res.json({
      ok: true,
      rows: rows || [],
      total: count || 0,
      run_summary,
    });
  } catch (err) {
    console.error("[reconciliations][transactions] failed", err?.message || err);
    return res
      .status(500)
      .json({ ok: false, error: "reconciliation_transactions_failed", message: err?.message || "failed" });
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
    return res.status(500).json({ ok: false, error: "reconciliation_runs_failed", message: err?.message || "failed" });
  }
});

export default router;
