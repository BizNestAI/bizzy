import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import {
  confirmCreditCardPaymentMatchForTransaction,
  rejectCreditCardPaymentSuggestion,
} from "../../../services/bookkeeping/creditCardPaymentPairService.js";
import {
  approveBookkeepingTransactions,
  BookkeepingApprovalError,
} from "../../../services/bookkeeping/bookkeepingApprovalService.js";
import { refreshOperatorRequestSummaryBestEffort } from "../../../services/bookkeeping/operatorRequestSummaryService.js";

const router = Router();

router.post("/approve", requireAuth, async (req, res) => {
  const raw = req.body || {};
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  const items = raw.items || raw.transactions || raw.approvals || [];
  try {
    const result = await approveBookkeepingTransactions({
      businessId,
      items,
      actor: "user",
      db: supabase,
    });
    return res.json({ ok: true, updated: result.updated, rows: result.rows, warnings: result.warnings });
  } catch (err) {
    if (err instanceof BookkeepingApprovalError) {
      return res.status(err.status || 400).json({ ok: false, error: err.error, ...err.details });
    }
    console.error("[bookkeeping][approve] failed", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "approve_failed",
      message: err?.message || "failed",
    });
  }
});

router.post("/undo", requireAuth, async (req, res) => {
  const raw = req.body || {};
  const businessId = ensureBusinessId(req, res);
  const txnId = raw.txnId || raw.transaction_id || raw.transactionId || raw.id || null;

  if (!businessId) return;
  if (!txnId) {
    return res.status(400).json({ ok: false, error: "missing_transaction_id" });
  }

  try {
    const nowIso = new Date().toISOString();
    const { data: updatedRows, error: updateErr } = await supabase
      .from("transaction_categorizations")
      .update({
        status: "needs_review",
        final_qbo_account_id: null,
        final_qbo_account_name: null,
        decided_by: "user",
        decided_at: nowIso,
        updated_at: nowIso,
        post_after: null,
        post_error: null,
        // QBO posting evidence is intentionally preserved. Undo does not void,
        // delete, reverse, or make a posted transaction eligible to post again.
      })
      .eq("business_id", businessId)
      .eq("transaction_id", txnId)
      .select("business_id,transaction_id,status,final_qbo_account_id,final_qbo_account_name,qbo_txn_id,qbo_txn_type,posted_at");

    if (updateErr) throw updateErr;

    let rows = updatedRows || [];
    let updated_count = rows.length;

    if (!updated_count) {
      const { data: inserted, error: insertErr } = await supabase
        .from("transaction_categorizations")
        .upsert(
          {
            business_id: businessId,
            transaction_id: txnId,
            status: "needs_review",
            final_qbo_account_id: null,
            final_qbo_account_name: null,
            decided_by: "user",
            decided_at: nowIso,
            updated_at: nowIso,
            post_after: null,
            post_error: null,
          },
          { onConflict: "business_id,transaction_id" }
        )
        .select("business_id,transaction_id,status,final_qbo_account_id,final_qbo_account_name,qbo_txn_id,qbo_txn_type,posted_at");
      if (insertErr) throw insertErr;
      rows = inserted || [];
      updated_count = rows.length;
    }

    await refreshOperatorRequestSummaryBestEffort({
      businessId,
      reason: "approval_undo",
    });

    console.info("[bookkeeping][undo]", { businessId, txnId, updated_count });
    return res.json({ ok: true, reverted: true, txn_id: txnId, updated_count, rows });
  } catch (err) {
    console.error("[bookkeeping][undo] failed", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "undo_failed",
      message: err?.message || "failed",
    });
  }
});

router.post("/credit-card-payments/reject", requireAuth, async (req, res) => {
  const raw = req.body || {};
  const businessId = ensureBusinessId(req, res);
  const txnId = raw.txnId || raw.transaction_id || raw.transactionId || raw.id || null;
  if (!businessId) return;
  if (!txnId) return res.status(400).json({ ok: false, error: "missing_transaction_id" });

  try {
    const result = await rejectCreditCardPaymentSuggestion({
      businessId,
      transactionId: txnId,
    });
    await refreshOperatorRequestSummaryBestEffort({
      businessId,
      reason: "cc_payment_rejection",
    });
    return res.json(result);
  } catch (err) {
    const code = String(err?.message || "cc_payment_reject_failed");
    if (code.startsWith("cc_payment_") || code === "missing_cc_payment_rejection_identity") {
      return res.status(400).json({ ok: false, error: code });
    }
    console.error("[bookkeeping][cc-payment-reject] failed", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "cc_payment_reject_failed",
      message: err?.message || "failed",
    });
  }
});

router.post("/credit-card-payments/:transactionId/confirm-match", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  const transactionId = req.params?.transactionId;
  const targetQboAccountId = req.body?.target_qbo_account_id || req.body?.targetQboAccountId || null;
  if (!businessId) return;
  if (!transactionId) return res.status(400).json({ ok: false, error: "missing_transaction_id" });
  if (!targetQboAccountId) return res.status(400).json({ ok: false, error: "missing_target_qbo_account_id" });

  try {
    const result = await confirmCreditCardPaymentMatchForTransaction({
      businessId,
      transactionId,
      targetQboAccountId,
    });
    if (result?.matched !== true) {
      return res.status(result?.code === "cc_payment_pair_ambiguous" ? 409 : 404).json({
        ok: false,
        error: result?.code || "cc_payment_no_matching_counterpart",
        message: result?.message || "No matching opposite-side payment was found yet.",
        candidates: result?.candidates || [],
      });
    }
    await refreshOperatorRequestSummaryBestEffort({
      businessId,
      reason: "cc_payment_match_confirmed",
    });
    return res.json(result);
  } catch (err) {
    const code = String(err?.message || "cc_payment_confirm_match_failed");
    if (code.startsWith("cc_payment_") || code === "missing_cc_payment_match_target" || code === "pending_transaction_not_matchable") {
      return res.status(err?.status || 400).json({ ok: false, error: code, message: code });
    }
    console.error("[bookkeeping][cc-payment-confirm-match] failed", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "cc_payment_confirm_match_failed",
      message: err?.message || "failed",
    });
  }
});

export default router;
