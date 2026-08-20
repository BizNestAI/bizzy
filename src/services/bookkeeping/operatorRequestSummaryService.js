import { supabase as defaultSupabase } from "../supabaseAdmin.js";

const SUMMARY_SELECT =
  "business_id,accounting_needs_review_count,outstanding_count,answered_awaiting_review_count,reconciliation_status,last_error,last_reconciled_at,created_at,updated_at";

function normalizeSummary(row = {}) {
  if (!row) return null;
  return {
    business_id: row.business_id || null,
    accounting_needs_review_count: Number(row.accounting_needs_review_count || 0),
    outstanding_count: Number(row.outstanding_count || 0),
    answered_awaiting_review_count: Number(row.answered_awaiting_review_count || 0),
    reconciliation_status: row.reconciliation_status || "ok",
    last_error: row.last_error || null,
    last_reconciled_at: row.last_reconciled_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

export async function reconcileOperatorRequestSummary({
  businessId,
  db = defaultSupabase,
  reason = "state_change",
} = {}) {
  if (!businessId) return { ok: false, error: "missing_business_id" };
  if (typeof db?.rpc !== "function") {
    return { ok: true, skipped: true, reason: "rpc_unavailable" };
  }
  const started = Date.now();
  const { data, error } = await db.rpc("refresh_operator_request_summary", {
    p_business_id: businessId,
  });
  if (error) {
    console.warn("[operator-summary] reconcile failed", {
      business_id: businessId,
      reason,
      message: error?.message || String(error),
    });
    return { ok: false, error: error?.message || "operator_summary_reconcile_failed" };
  }
  const row = Array.isArray(data) ? data[0] || null : data || null;
  if (process.env.NODE_ENV !== "production") {
    console.info("[operator-summary] reconciled", {
      business_id: businessId,
      reason,
      operator_summary_reconcile_ms: Date.now() - started,
    });
  }
  return { ok: true, summary: normalizeSummary(row) };
}

export async function refreshOperatorRequestSummaryBestEffort({
  businessId,
  db = defaultSupabase,
  reason = "state_change",
} = {}) {
  try {
    return await reconcileOperatorRequestSummary({ businessId, db, reason });
  } catch (err) {
    console.warn("[operator-summary] reconcile unexpected failure", {
      business_id: businessId,
      reason,
      message: err?.message || String(err),
    });
    return { ok: false, error: err?.message || "operator_summary_reconcile_failed" };
  }
}

export async function getOperatorRequestSummary({
  businessId,
  db = defaultSupabase,
  initializeIfMissing = true,
} = {}) {
  if (!businessId) return { ok: false, error: "missing_business_id" };
  const started = Date.now();
  const { data, error } = await db
    .from("operator_request_summaries")
    .select(SUMMARY_SELECT)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(error?.message || "operator_summary_fetch_failed");
  if (!data && initializeIfMissing) {
    return reconcileOperatorRequestSummary({ businessId, db, reason: "summary_missing" });
  }
  if (process.env.NODE_ENV !== "production") {
    console.info("[operator-summary] read", {
      business_id: businessId,
      operator_summary_read_ms: Date.now() - started,
    });
  }
  return { ok: true, summary: normalizeSummary(data) };
}

export async function reconcileOperatorRequestSummariesForBusinesses({
  businessIds = [],
  db = defaultSupabase,
  reason = "periodic_reconciliation",
} = {}) {
  const ids = Array.from(new Set((businessIds || []).filter(Boolean)));
  const results = [];
  for (const businessId of ids) {
    results.push(await refreshOperatorRequestSummaryBestEffort({ businessId, db, reason }));
  }
  return {
    ok: true,
    businesses: ids.length,
    reconciled: results.filter((row) => row?.ok).length,
    failed: results.filter((row) => row && row.ok === false).length,
    results,
  };
}

export default {
  getOperatorRequestSummary,
  reconcileOperatorRequestSummary,
  reconcileOperatorRequestSummariesForBusinesses,
  refreshOperatorRequestSummaryBestEffort,
};
