import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { learnVendorRuleFromTransaction } from "../../../services/bookkeeping/vendorRuleLearner.js";
import { isCheck } from "../../../services/bookkeeping/checkDetector.js";
import { getBookkeepingStartDate, getTransactionsOutsideActiveBookkeepingScope } from "../../../services/bookkeeping/bookkeepingScope.js";
import { computePostAfterForAutoPost, getAutoPostToQuickBooks } from "../../../services/bookkeeping/autoPostControl.js";
import {
  confirmCreditCardPaymentPairForTransaction,
  createManualCreditCardPaymentPair,
  rejectCreditCardPaymentSuggestion,
} from "../../../services/bookkeeping/creditCardPaymentPairService.js";
import { validateBusinessQboCreditCardAccount } from "../../../services/bookkeeping/qboAccounts.js";

const router = Router();

router.post("/approve", requireAuth, async (req, res) => {
  const raw = req.body || {};
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  const items = raw.items || raw.transactions || raw.approvals || [];
  const nowIso = new Date().toISOString();
  const autoPostEnabled = await getAutoPostToQuickBooks(supabase, businessId);
  const postAfter = computePostAfterForAutoPost(autoPostEnabled, 24);

  const txnIds = (items || [])
    .map((item) => item?.txnId || item?.transaction_id || item?.transactionId || item?.id)
    .filter(Boolean);

  if (!txnIds.length) {
    return res.status(400).json({ ok: false, error: "missing_items" });
  }

  const { data: existingMetaRows } = await supabase
    .from("transaction_categorizations")
    .select("transaction_id,meta,suggested_qbo_account_id,suggested_qbo_account_name,suggested_canonical_account_key")
    .eq("business_id", businessId)
    .in("transaction_id", txnIds);
  const existingMetaMap = {};
  const suggestedIdMap = {};
  const suggestedNameMap = {};
  const suggestedCanonicalMap = {};
  (existingMetaRows || []).forEach((row) => {
    existingMetaMap[row.transaction_id] = row.meta || {};
    suggestedIdMap[row.transaction_id] = row.suggested_qbo_account_id || null;
    suggestedNameMap[row.transaction_id] = row.suggested_qbo_account_name || null;
    suggestedCanonicalMap[row.transaction_id] = row.suggested_canonical_account_key || row.meta?.canonical_account_key || null;
  });

  const warnings = [];

  const { data: bankTxns, error: bankErr } = await supabase
    .from("bank_transactions")
    .select("id,date,name,merchant_name,counterparty_name,transaction_type,check_number,merchant_entity_id,qbo_entity_type,qbo_entity_id,amount,direction,category_primary,personal_finance_category,plaid_account_id,pending,accounting_review_required,accounting_review_reason")
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .in("id", txnIds);
  if (bankErr) {
    console.error("[bookkeeping][approve] bank fetch failed", bankErr?.message || bankErr);
    return res.status(500).json({ ok: false, error: "bank_fetch_failed", message: bankErr?.message || "failed" });
  }
  const bankTxnMap = (bankTxns || []).reduce((acc, row) => {
    acc[row.id] = row;
    return acc;
  }, {});
  const pendingIds = (bankTxns || []).filter((row) => row.pending === true).map((row) => row.id);
  if (pendingIds.length) {
    await supabase
      .from("transaction_categorizations")
      .update({
        status: "needs_review",
        post_after: null,
        post_error: "pending_transaction_not_postable",
        pending_blocked_at: nowIso,
        updated_at: nowIso,
      })
      .eq("business_id", businessId)
      .in("transaction_id", pendingIds);
    return res.status(400).json({
      ok: false,
      error: "pending_transaction_not_postable",
      transactions: pendingIds,
    });
  }
  const reviewIds = (bankTxns || []).filter((row) => row.accounting_review_required === true).map((row) => row.id);
  if (reviewIds.length) {
    return res.status(400).json({
      ok: false,
      error: "plaid_accounting_review_required",
      transactions: reviewIds,
    });
  }
  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
  const preCutoffIds = getTransactionsOutsideActiveBookkeepingScope(bankTxns || [], bookkeepingStartDate).map((row) => row.id);
  if (preCutoffIds.length) {
    return res.status(400).json({
      ok: false,
      error: "transaction_before_bookkeeping_start_date",
      bookkeeping_start_date: bookkeepingStartDate,
      transactions: preCutoffIds,
    });
  }

  const missingCheckFinals = [];
  const ccPairConfirmTxnIds = new Set();
  const confirmedCcPairs = new Map();

  for (const item of items || []) {
    const txnId = item?.txnId || item?.transaction_id || item?.transactionId || item?.id;
    if (!txnId) continue;
    const meta = existingMetaMap[txnId] || {};
    if (meta?.taxonomy_type !== "cc_payment") continue;
    const explicitFinalId = item?.newAccountId || item?.final_qbo_account_id || item?.finalAccountId || null;
    if (!meta.cc_payment_pair_id && explicitFinalId) {
      const targetValidation = await validateBusinessQboCreditCardAccount(businessId, explicitFinalId);
      if (!targetValidation?.ok) {
        existingMetaMap[txnId] = {
          ...meta,
          cc_payment_rejected: true,
          cc_payment_rejected_at: nowIso,
          taxonomy_override: "not_cc_payment",
          safe_to_auto_handle: false,
          safe_to_auto_post: true,
          auto_approve_reason: "manual_user",
        };
        delete existingMetaMap[txnId].taxonomy_type;
        delete existingMetaMap[txnId].taxonomy_subtype;
        continue;
      }
      let pair = null;
      try {
        pair = await createManualCreditCardPaymentPair({
          businessId,
          transactionId: txnId,
          targetQboAccountId: explicitFinalId,
        });
      } catch (err) {
        const code = String(err?.message || "cc_payment_target_credit_card_required");
        if (code.startsWith("cc_payment_")) {
          return res.status(400).json({
            ok: false,
            error: code,
            transactions: [txnId],
          });
        }
        throw err;
      }
      existingMetaMap[txnId] = {
        ...(existingMetaMap[txnId] || {}),
        taxonomy_type: "cc_payment",
        cc_payment_pair_id: pair.id,
        cc_payment_pair_role: "checking",
        cc_payment_pair_status: pair.status,
        cc_payment_pair_confidence: pair.match_confidence,
        cc_payment_bank_qbo_account_id: pair.checking_qbo_account_id,
        cc_payment_bank_qbo_account_name: pair.checking_qbo_account_name,
        cc_payment_cc_qbo_account_id: pair.credit_card_qbo_account_id,
        cc_payment_cc_qbo_account_name: pair.credit_card_qbo_account_name,
        cc_payment_transfer_target_qbo_account_id: pair.credit_card_qbo_account_id,
        cc_payment_transfer_target_qbo_account_name: pair.credit_card_qbo_account_name,
      };
    }
    ccPairConfirmTxnIds.add(txnId);
  }

  for (const txnId of ccPairConfirmTxnIds) {
    const pair = await confirmCreditCardPaymentPairForTransaction({ businessId, transactionId: txnId });
    confirmedCcPairs.set(String(pair.id), pair);
    const currentMeta = existingMetaMap[txnId] || {};
    existingMetaMap[txnId] = {
      ...currentMeta,
      cc_payment_pair_id: pair.id,
      cc_payment_pair_status: "confirmed",
      cc_payment_pair_confidence: pair.match_confidence,
      cc_payment_bank_qbo_account_id: pair.checking_qbo_account_id,
      cc_payment_bank_qbo_account_name: pair.checking_qbo_account_name,
      cc_payment_cc_qbo_account_id: pair.credit_card_qbo_account_id,
      cc_payment_cc_qbo_account_name: pair.credit_card_qbo_account_name,
      cc_payment_transfer_target_qbo_account_id:
        currentMeta.cc_payment_pair_role === "credit_card" ? pair.checking_qbo_account_id : pair.credit_card_qbo_account_id,
      cc_payment_transfer_target_qbo_account_name:
        currentMeta.cc_payment_pair_role === "credit_card" ? pair.checking_qbo_account_name : pair.credit_card_qbo_account_name,
      cc_payment_pair_counterpart_amount:
        currentMeta.cc_payment_pair_role === "credit_card" ? -Math.abs(Number(pair.amount || 0)) : Math.abs(Number(pair.amount || 0)),
      cc_payment_pair_counterpart_date:
        currentMeta.cc_payment_pair_role === "credit_card" ? pair.payment_date || pair.matched_date : pair.matched_date || pair.payment_date,
      cc_payment_pair_counterpart_account_name:
        currentMeta.cc_payment_pair_role === "credit_card" ? pair.checking_qbo_account_name : pair.credit_card_qbo_account_name,
      safe_to_auto_post: true,
      auto_approve_reason: "manual_user",
    };
  }

  const approvals = (items || [])
    .map((item) => {
      const txnId = item?.txnId || item?.transaction_id || item?.transactionId || item?.id;
      const explicitFinalId = item?.newAccountId || item?.final_qbo_account_id || item?.finalAccountId || null;
      const explicitFinalName = item?.newAccountName || item?.final_qbo_account_name || item?.finalAccountName || null;
      const explicitCanonicalKey = item?.final_canonical_account_key || item?.canonical_account_key || item?.canonicalAccountKey || null;
      const bankTxn = bankTxnMap[txnId] || null;
      const checkHit = isCheck(bankTxn || {});
      const mergedMeta = {
        ...(existingMetaMap[txnId] || {}),
      };
      const isTransferTaxonomy = mergedMeta?.taxonomy_type === "transfer_internal";
      const isCcPaymentTaxonomy = mergedMeta?.taxonomy_type === "cc_payment";
      const isOwnerMove = mergedMeta?.taxonomy_type === "owner_draw" || mergedMeta?.taxonomy_type === "owner_contribution";
      const isRefund = mergedMeta?.taxonomy_type === "refund";
      if (isTransferTaxonomy) {
        mergedMeta.safe_to_auto_post = false;
        mergedMeta.auto_approve_reason = "manual_user";
        mergedMeta.post_block_reason = "transfer_posting_not_supported";
        warnings.push({ transaction_id: txnId, code: "transfer_not_scheduled" });
      } else if (isCcPaymentTaxonomy) {
        const hasSafeMapping =
          mergedMeta.safe_to_auto_post === true && mergedMeta.cc_payment_bank_qbo_account_id && mergedMeta.cc_payment_cc_qbo_account_id;
        if (hasSafeMapping) {
          mergedMeta.auto_approve_reason = "manual_user";
          mergedMeta.safe_to_auto_post = true;
        } else {
          mergedMeta.safe_to_auto_post = false;
          mergedMeta.post_block_reason = "cc_payment_mapping_not_safe";
          warnings.push({ transaction_id: txnId, code: "cc_payment_not_scheduled" });
        }
      } else if (isOwnerMove) {
        mergedMeta.safe_to_auto_post = false;
        mergedMeta.auto_approve_reason = "manual_user";
        mergedMeta.post_block_reason = "owner_move_posting_not_supported";
        warnings.push({ transaction_id: txnId, code: "owner_move_not_scheduled" });
      } else if (isRefund) {
        mergedMeta.safe_to_auto_post = false;
        mergedMeta.auto_approve_reason = "manual_user";
        mergedMeta.post_block_reason = "refund_posting_not_supported";
        warnings.push({ transaction_id: txnId, code: "refund_not_scheduled" });
      } else {
        mergedMeta.safe_to_auto_post = true;
        mergedMeta.auto_approve_reason = "manual_user";
      }

      const effectiveFinalId = checkHit.is_check ? explicitFinalId : explicitFinalId || suggestedIdMap[txnId] || null;
      const effectiveFinalName = checkHit.is_check ? explicitFinalName : explicitFinalName || suggestedNameMap[txnId] || null;
      if (checkHit.is_check && !explicitFinalId) {
        missingCheckFinals.push(txnId);
      }

      return {
        transaction_id: txnId,
        final_qbo_account_id: effectiveFinalId,
        final_qbo_account_name: effectiveFinalName,
        final_canonical_account_key: explicitCanonicalKey || suggestedCanonicalMap[txnId] || mergedMeta?.canonical_account_key || null,
        confidence: item?.confidence || null,
        reason: item?.reason || null,
        post_after:
          isTransferTaxonomy ||
          (isCcPaymentTaxonomy && mergedMeta.safe_to_auto_post !== true) ||
          isOwnerMove ||
          isRefund
            ? null
            : postAfter,
        meta: mergedMeta,
        is_check: checkHit.is_check === true,
      };
    })
    .filter(Boolean);

  if (!approvals.length) {
    return res.status(400).json({ ok: false, error: "missing_items" });
  }
  if (approvals.some((a) => !a.transaction_id)) {
    return res.status(400).json({ ok: false, error: "missing_transaction_id", approvals });
  }
  if (missingCheckFinals.length) {
    return res.status(400).json({ ok: false, error: "missing_final_account_for_check", transactions: missingCheckFinals });
  }
  const missingAccounts = approvals.filter((a) => !a.final_qbo_account_id && !a.is_check).map((a) => a.transaction_id);
  if (missingAccounts.length) {
    return res.status(400).json({ ok: false, error: "missing_account_id", transactions: missingAccounts });
  }

  try {
    const payload = approvals.map((item) => {
      const bankTxn = bankTxnMap[item.transaction_id] || null;
      const checkHit = isCheck(bankTxn || {});
      const mergedMeta = { ...(item.meta || {}) };
      if (checkHit.is_check) {
        mergedMeta.is_check = true;
        mergedMeta.check_confidence = checkHit.confidence;
        mergedMeta.check_reason = checkHit.reason;
        if (checkHit.check_number) mergedMeta.check_number = checkHit.check_number;
        mergedMeta.taxonomy_flags = { ...(mergedMeta.taxonomy_flags || {}), is_check: true };
      }
      return {
        business_id: businessId,
        transaction_id: item.transaction_id,
        status: "approved",
        final_qbo_account_id: item.final_qbo_account_id || null,
        final_qbo_account_name: item.final_qbo_account_name || null,
        final_canonical_account_key: item.final_canonical_account_key || null,
        confidence: item.confidence || null,
        reason: item.reason || null,
        decided_by: "user",
        decided_at: nowIso,
        updated_at: nowIso,
        post_after: item.post_after === undefined ? postAfter : item.post_after,
        post_error: null,
        meta: mergedMeta || null,
      };
    });

    const { data, error } = await supabase
      .from("transaction_categorizations")
      .upsert(payload, { onConflict: "business_id,transaction_id" })
      .select("business_id,transaction_id,status,final_qbo_account_id,final_qbo_account_name");

    if (error) {
      console.error("[bookkeeping][approve] supabase error", error);
      return res.status(500).json({ ok: false, error: "approve_failed", message: error.message });
    }

    for (const pair of confirmedCcPairs.values()) {
      const pairRows = [
        {
          transaction_id: pair.checking_transaction_id,
          final_qbo_account_id: pair.credit_card_qbo_account_id,
          final_qbo_account_name: pair.credit_card_qbo_account_name,
          role: "checking",
          counterpart: pair.credit_card_transaction_id || null,
          targetAccountId: pair.credit_card_qbo_account_id,
          targetAccountName: pair.credit_card_qbo_account_name,
        },
        pair.credit_card_transaction_id
          ? {
              transaction_id: pair.credit_card_transaction_id,
              final_qbo_account_id: pair.checking_qbo_account_id,
              final_qbo_account_name: pair.checking_qbo_account_name,
              role: "credit_card",
              counterpart: pair.checking_transaction_id,
              targetAccountId: pair.checking_qbo_account_id,
              targetAccountName: pair.checking_qbo_account_name,
            }
          : null,
      ].filter(Boolean);
      for (const pairRow of pairRows) {
        const existingMeta = existingMetaMap[pairRow.transaction_id] || {};
        await supabase
          .from("transaction_categorizations")
          .upsert({
            business_id: businessId,
            transaction_id: pairRow.transaction_id,
            status: "approved",
            final_qbo_account_id: pairRow.final_qbo_account_id,
            final_qbo_account_name: pairRow.final_qbo_account_name,
            confidence: "high",
            reason: "Confirmed credit-card payment transfer",
            decided_by: "user",
            decided_at: nowIso,
            updated_at: nowIso,
            post_after: postAfter,
            post_error: null,
            meta: {
              ...existingMeta,
              taxonomy_type: "cc_payment",
              cc_payment_pair_id: pair.id,
              cc_payment_pair_role: pairRow.role,
              cc_payment_pair_txn_id: pairRow.counterpart,
              cc_payment_pair_status: "confirmed",
              cc_payment_pair_confidence: pair.match_confidence,
              cc_payment_bank_qbo_account_id: pair.checking_qbo_account_id,
              cc_payment_bank_qbo_account_name: pair.checking_qbo_account_name,
              cc_payment_cc_qbo_account_id: pair.credit_card_qbo_account_id,
              cc_payment_cc_qbo_account_name: pair.credit_card_qbo_account_name,
              cc_payment_transfer_target_qbo_account_id: pairRow.targetAccountId,
              cc_payment_transfer_target_qbo_account_name: pairRow.targetAccountName,
              cc_payment_pair_counterpart_amount:
                pairRow.role === "credit_card" ? -Math.abs(Number(pair.amount || 0)) : Math.abs(Number(pair.amount || 0)),
              cc_payment_pair_counterpart_date:
                pairRow.role === "credit_card" ? pair.payment_date || pair.matched_date : pair.matched_date || pair.payment_date,
              cc_payment_pair_counterpart_account_name: pairRow.targetAccountName,
              safe_to_auto_handle: false,
              safe_to_auto_post: true,
              auto_approve_reason: "manual_user",
            },
          }, { onConflict: "business_id,transaction_id" });
      }
    }

    // Learning loop (best-effort per item)
    for (const item of approvals) {
      try {
        const bankTxn = bankTxnMap[item.transaction_id];
        if (!bankTxn) continue;
        const taxonomyType = (existingMetaMap[item.transaction_id] || {}).taxonomy_type || null;
        const checkHit = isCheck(bankTxn || {});
        if (checkHit.is_check) {
          await learnVendorRuleFromTransaction({
            businessId,
            bankTxn,
            finalAccountId: item.final_qbo_account_id,
            finalAccountName: item.final_qbo_account_name,
            taxonomyType,
            options: { allowQboEntityFallback: true, learnedFrom: "check" },
          });
        } else {
          await learnVendorRuleFromTransaction({
            businessId,
            bankTxn,
            finalAccountId: item.final_qbo_account_id,
            finalAccountName: item.final_qbo_account_name,
            taxonomyType,
          });
        }
      } catch (e) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[bookkeeping][approve] vendor rule learn skipped", e?.message || e);
        }
      }
    }

    return res.json({ ok: true, updated: data?.length || 0, rows: data || [], warnings });
  } catch (err) {
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

export default router;
