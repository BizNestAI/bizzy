import { supabase } from "../services/supabaseAdmin.js";
import { reconcileOperatorRequestSummariesForBusinesses } from "../services/bookkeeping/operatorRequestSummaryService.js";

const DISABLED = String(process.env.DISABLE_OPERATOR_REQUEST_SUMMARY_CRON || "").toLowerCase() === "true";
const INTERVAL_MINUTES = Number(process.env.OPERATOR_REQUEST_SUMMARY_CRON_INTERVAL_MINUTES || 15);
const BUSINESS_LIMIT = Number(process.env.OPERATOR_REQUEST_SUMMARY_BUSINESS_LIMIT || 100);

let timer = null;

async function discoverBusinessIds() {
  const ids = new Set();
  const { data: items, error: itemErr } = await supabase
    .from("plaid_items")
    .select("business_id")
    .eq("is_active", true)
    .not("business_id", "is", null)
    .limit(BUSINESS_LIMIT);
  if (itemErr) {
    console.warn("[operator-summary-cron] active business discovery failed", itemErr?.message || itemErr);
  }
  (items || []).forEach((row) => {
    if (row.business_id) ids.add(row.business_id);
  });

  const staleCutoff = new Date(Date.now() - Math.max(1, INTERVAL_MINUTES) * 60 * 1000).toISOString();
  const { data: summaries, error: summaryErr } = await supabase
    .from("operator_request_summaries")
    .select("business_id")
    .or(`last_reconciled_at.is.null,last_reconciled_at.lt.${staleCutoff},reconciliation_status.eq.error`)
    .limit(BUSINESS_LIMIT);
  if (summaryErr) {
    console.warn("[operator-summary-cron] stale summary discovery failed", summaryErr?.message || summaryErr);
  }
  (summaries || []).forEach((row) => {
    if (row.business_id) ids.add(row.business_id);
  });

  return Array.from(ids).slice(0, BUSINESS_LIMIT);
}

export async function runOperatorRequestSummaryReconciliationOnce() {
  const businessIds = await discoverBusinessIds();
  if (!businessIds.length) return { ok: true, businesses: 0, reconciled: 0, failed: 0 };
  const result = await reconcileOperatorRequestSummariesForBusinesses({
    businessIds,
    reason: "periodic_reconciliation",
  });
  if (result.reconciled || result.failed) {
    console.info("[operator-summary-cron] reconciliation complete", {
      businesses: result.businesses,
      reconciled: result.reconciled,
      failed: result.failed,
    });
  }
  return result;
}

export function startOperatorRequestSummaryCron() {
  if (timer) return timer;
  if (DISABLED) {
    console.info("[operator-summary-cron] disabled via env");
    return null;
  }
  const intervalMs = Math.max(1, INTERVAL_MINUTES) * 60 * 1000;
  const run = () => {
    runOperatorRequestSummaryReconciliationOnce().catch((err) => {
      console.warn("[operator-summary-cron] reconciliation failed", err?.message || err);
    });
  };
  timer = setInterval(run, intervalMs);
  timer.unref?.();
  run();
  console.info("[operator-summary-cron] started", { interval_minutes: INTERVAL_MINUTES });
  return timer;
}

export default {
  runOperatorRequestSummaryReconciliationOnce,
  startOperatorRequestSummaryCron,
};
