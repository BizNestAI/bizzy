import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { evaluateReconciliationStatus } from "../../../services/bookkeeping/reconciliationEvaluator.js";

const router = Router();
const SAFE_RECONCILIATION_ERROR_MESSAGE =
  "An internal issue occurred during reconciliation. Bizzi will retry automatically.";

function summarizeAccounts(rows = []) {
  const visible = (rows || []).filter(
    (r) => r.plaid_account_id && !String(r.plaid_account_id).startsWith("__recon_")
  );
  return visible.map((r) => {
    let note = null;
    const notes = Array.isArray(r.details?.notes) ? r.details.notes : null;
    if (notes && notes.length) {
      note = notes.slice(0, 2).join("; ");
    } else if (r.details?.note) {
      note = r.details.note;
    }
    return {
      plaid_account_id: r.plaid_account_id,
      plaid_account_name: r.details?.plaid_account_name || null,
      plaid_account_mask: r.details?.plaid_account_mask || null,
      status: r.status || "unknown",
      diff_amount: r.diff_amount != null ? Number(r.diff_amount) : null,
      bank_balance: r.bank_balance != null ? Number(r.bank_balance) : null,
      book_balance: r.book_balance != null ? Number(r.book_balance) : null,
      last_checked_at: r.last_checked_at || null,
      explanation_summary: r.details?.explanation_summary || note || null,
      linked_qbo_account_id: r.details?.linked_qbo_account_id || r.details?.qbo_account_id || null,
      linked_qbo_account_name: r.details?.linked_qbo_account_name || r.details?.qbo_account_name || null,
      linked_qbo_account_type: r.details?.linked_qbo_account_type || r.details?.qbo_account_type || null,
      comparison_mode: r.details?.comparison_mode || null,
      balance_source: r.details?.balance_source || r.details?.book_balance_source || null,
      pending_txn_count: r.details?.pending_txn_count ?? null,
      needs_review_count: r.details?.needs_review_count ?? null,
      approved_waiting_to_post_count: r.details?.approved_waiting_to_post_count ?? null,
      posted_txn_count: r.details?.posted_txn_count ?? null,
      last_posted_at: r.details?.last_posted_at || null,
      last_sync_at: r.details?.last_sync_at || null,
      notes: Array.isArray(r.details?.explanation_notes)
        ? r.details.explanation_notes
        : Array.isArray(r.details?.notes)
        ? r.details.notes
        : [],
      note: note || null,
      details: r.details || null,
    };
  });
}

function computeOverallStatus(accounts = []) {
  if (!accounts.length) return "unknown";
  if (accounts.some((a) => a.status === "investigating")) return "investigating";
  if (accounts.every((a) => a.status === "ok")) return "ok";
  return "unknown";
}

router.get("/reconciliation-status", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const withDetails = String(req.query?.details || "").trim() === "1";
    const { data, error } = await supabase
      .from("reconciliation_health")
      .select(
        withDetails
          ? "plaid_account_id,status,diff_amount,bank_balance,book_balance,last_checked_at,details"
          : "plaid_account_id,status,diff_amount,last_checked_at,details"
      )
      .eq("business_id", businessId)
      .order("last_checked_at", { ascending: false });
    if (error) throw error;

    const accounts = summarizeAccounts(data || []);
    const overall_status = computeOverallStatus(accounts);
    return res.json({ ok: true, overall_status, accounts });
  } catch (err) {
    console.error("[recon][get] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "reconciliation_fetch_failed", message: SAFE_RECONCILIATION_ERROR_MESSAGE });
  }
});

router.post("/reconciliation-status/run", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const nowIso = new Date().toISOString();
  try {
    // Optional: tighten in production to admin-only if needed.
    const result = await evaluateReconciliationStatus(businessId);
    const accounts = summarizeAccounts(result?.perAccount || []);
    const overall_status = result?.overallStatus || computeOverallStatus(accounts);
    return res.json({ ok: true, overall_status, accounts, ran_at: nowIso });
  } catch (err) {
    console.error("[recon][run] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "reconciliation_run_failed", message: SAFE_RECONCILIATION_ERROR_MESSAGE });
  }
});

export default router;
