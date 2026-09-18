import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import {
  confirmCreditCardPaymentMatchForTransaction,
  markTransactionAsCreditCardPayment,
  rejectCreditCardPaymentSuggestion,
} from "../../../services/bookkeeping/creditCardPaymentPairService.js";
import {
  confirmLoanPaymentSplit,
  recordLoanPaymentRegularOverride,
  LoanPaymentWorkflowError,
} from "../../../services/bookkeeping/loanPaymentWorkflow.js";
import { fetchChartOfAccounts } from "../../../services/bookkeeping/qboAccounts.js";
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
    return res.json({ ok: true, updated: result.updated, rows: result.rows, warnings: result.warnings, vendor_rule_results: result.vendor_rule_results || [] });
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

router.post("/credit-card-payments/mark", requireAuth, async (req, res) => {
  const raw = req.body || {};
  const businessId = ensureBusinessId(req, res);
  const txnId = raw.txnId || raw.transaction_id || raw.transactionId || raw.id || null;
  if (!businessId) return;
  if (!txnId) return res.status(400).json({ ok: false, error: "missing_transaction_id" });

  try {
    const result = await markTransactionAsCreditCardPayment({
      businessId,
      transactionId: txnId,
    });
    await refreshOperatorRequestSummaryBestEffort({
      businessId,
      reason: "cc_payment_marked",
    });
    return res.json(result);
  } catch (err) {
    const code = String(err?.message || "cc_payment_mark_failed");
    if (code.startsWith("cc_payment_") || code === "missing_cc_payment_mark_identity" || code === "pending_transaction_not_matchable") {
      return res.status(err?.status || 400).json({ ok: false, error: code, message: code });
    }
    console.error("[bookkeeping][cc-payment-mark] failed", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "cc_payment_mark_failed",
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

router.post("/loan-payments/:transactionId/confirm-split", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  const transactionId = req.params?.transactionId;
  const split = req.body?.split || req.body || {};
  if (!businessId) return;
  if (!transactionId) return res.status(400).json({ ok: false, error: "missing_transaction_id" });

  try {
    const { data: transaction, error: txnErr } = await supabase
      .from("bank_transactions")
      .select("id,business_id,date,name,merchant_name,counterparty_name,transaction_type,merchant_entity_id,amount,direction,pending,plaid_account_id,iso_currency_code,currency")
      .eq("business_id", businessId)
      .eq("is_archived", false)
      .eq("id", transactionId)
      .maybeSingle();
    if (txnErr) throw txnErr;
    if (!transaction) return res.status(404).json({ ok: false, error: "transaction_not_found" });

    const accounts = await fetchChartOfAccounts(businessId);
    const accountsById = new Map((accounts || []).map((account) => [String(account.id), account]));
    const actorId = req.user?.id || req.auth?.userId || null;
    const result = await confirmLoanPaymentSplit({
      db: supabase,
      businessId,
      transaction,
      split,
      accountsById,
      actorId,
      actorType: "user",
    });
    const nowIso = new Date().toISOString();
    const { data: existingCat, error: catFetchErr } = await supabase
      .from("transaction_categorizations")
      .select("meta")
      .eq("business_id", businessId)
      .eq("transaction_id", transactionId)
      .maybeSingle();
    if (catFetchErr) throw catFetchErr;
    const nextMeta = {
      ...(existingCat?.meta || {}),
      taxonomy_type: "loan_payment",
      loan_payment_split_status: "confirmed",
      loan_payment_split_id: result?.split?.id || null,
      loan_lender_profile_id: result?.lenderProfile?.id || null,
      protected_workflow: "loan_payment",
      safe_to_auto_post: false,
    };
    const { data: categorization, error: upsertErr } = await supabase
      .from("transaction_categorizations")
      .upsert(
        {
          business_id: businessId,
          transaction_id: transactionId,
          status: "needs_review",
          final_qbo_account_id: null,
          final_qbo_account_name: null,
          decided_by: "user",
          decided_at: nowIso,
          updated_at: nowIso,
          post_after: null,
          post_error: null,
          meta: nextMeta,
        },
        { onConflict: "business_id,transaction_id" }
      )
      .select("business_id,transaction_id,status,meta,post_after")
      .maybeSingle();
    if (upsertErr) throw upsertErr;
    await refreshOperatorRequestSummaryBestEffort({
      businessId,
      reason: "loan_payment_split_confirmed",
    });
    return res.json({ ok: true, loan_payment: true, lender_profile: result?.lenderProfile || null, split: result?.split || null, categorization });
  } catch (err) {
    const code = String(err?.message || "loan_payment_split_failed");
    if (err instanceof LoanPaymentWorkflowError || code.startsWith("loan_") || code === "pending_transaction_not_postable") {
      return res.status(err?.status || 400).json({ ok: false, error: code, message: code, details: err?.details || null });
    }
    console.error("[bookkeeping][loan-payment-confirm-split] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "loan_payment_split_failed", message: err?.message || "failed" });
  }
});

router.post("/loan-payments/:transactionId/treat-as-regular", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  const transactionId = req.params?.transactionId;
  if (!businessId) return;
  if (!transactionId) return res.status(400).json({ ok: false, error: "missing_transaction_id" });

  try {
    const actorId = req.user?.id || req.auth?.userId || null;
    await recordLoanPaymentRegularOverride({
      db: supabase,
      businessId,
      transactionId,
      actorId,
      actorType: "user",
    });
    const { data: existingCat, error: catFetchErr } = await supabase
      .from("transaction_categorizations")
      .select("meta")
      .eq("business_id", businessId)
      .eq("transaction_id", transactionId)
      .maybeSingle();
    if (catFetchErr) throw catFetchErr;
    const nextMeta = {
      ...(existingCat?.meta || {}),
      taxonomy_override: "not_loan_payment",
      loan_payment_rejected: true,
      safe_to_auto_post: false,
    };
    delete nextMeta.loan_payment_split_status;
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from("transaction_categorizations")
      .upsert(
        {
          business_id: businessId,
          transaction_id: transactionId,
          status: "needs_review",
          decided_by: "user",
          decided_at: nowIso,
          updated_at: nowIso,
          post_after: null,
          post_error: null,
          meta: nextMeta,
        },
        { onConflict: "business_id,transaction_id" }
      )
      .select("business_id,transaction_id,status,meta")
      .maybeSingle();
    if (error) throw error;
    await refreshOperatorRequestSummaryBestEffort({
      businessId,
      reason: "loan_payment_regular_override",
    });
    return res.json({ ok: true, regular_transaction: true, categorization: data });
  } catch (err) {
    console.error("[bookkeeping][loan-payment-regular-override] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "loan_payment_regular_override_failed", message: err?.message || "failed" });
  }
});

export default router;
