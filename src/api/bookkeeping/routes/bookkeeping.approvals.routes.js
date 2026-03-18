import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { learnVendorRuleFromTransaction } from "../../../services/bookkeeping/vendorRuleLearner.js";
import { isCheck } from "../../../services/bookkeeping/checkDetector.js";

const router = Router();

router.post("/approve", requireAuth, async (req, res) => {
  const raw = req.body || {};
  const businessId =
    raw.business_id ||
    raw.businessId ||
    req.query?.business_id ||
    req.headers?.["x-business-id"] ||
    req.user?.business_id ||
    null;
  if (!businessId) {
    return res.status(400).json({ ok: false, error: "missing_business_id" });
  }

  const items = raw.items || raw.transactions || raw.approvals || [];
  const nowIso = new Date().toISOString();
  const postAfter = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const txnIds = (items || [])
    .map((item) => item?.txnId || item?.transaction_id || item?.transactionId || item?.id)
    .filter(Boolean);

  if (!txnIds.length) {
    return res.status(400).json({ ok: false, error: "missing_items" });
  }

  const { data: existingMetaRows } = await supabase
    .from("transaction_categorizations")
    .select("transaction_id,meta,suggested_qbo_account_id,suggested_qbo_account_name")
    .eq("business_id", businessId)
    .in("transaction_id", txnIds);
  const existingMetaMap = {};
  const suggestedIdMap = {};
  const suggestedNameMap = {};
  (existingMetaRows || []).forEach((row) => {
    existingMetaMap[row.transaction_id] = row.meta || {};
    suggestedIdMap[row.transaction_id] = row.suggested_qbo_account_id || null;
    suggestedNameMap[row.transaction_id] = row.suggested_qbo_account_name || null;
  });

  const warnings = [];

  const { data: bankTxns, error: bankErr } = await supabase
    .from("bank_transactions")
    .select("id,name,merchant_name,counterparty_name,transaction_type,check_number,merchant_entity_id,qbo_entity_type,qbo_entity_id,amount,direction,category_primary,personal_finance_category,plaid_account_id")
    .eq("business_id", businessId)
    .in("id", txnIds);
  if (bankErr) {
    console.error("[bookkeeping][approve] bank fetch failed", bankErr?.message || bankErr);
    return res.status(500).json({ ok: false, error: "bank_fetch_failed", message: bankErr?.message || "failed" });
  }
  const bankTxnMap = (bankTxns || []).reduce((acc, row) => {
    acc[row.id] = row;
    return acc;
  }, {});

  const missingCheckFinals = [];

  const approvals = (items || [])
    .map((item) => {
      const txnId = item?.txnId || item?.transaction_id || item?.transactionId || item?.id;
      const explicitFinalId = item?.newAccountId || item?.final_qbo_account_id || item?.finalAccountId || null;
      const explicitFinalName = item?.newAccountName || item?.final_qbo_account_name || item?.finalAccountName || null;
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
  const businessId =
    raw.business_id ||
    raw.businessId ||
    req.query?.business_id ||
    req.headers?.["x-business-id"] ||
    req.user?.business_id ||
    null;
  const txnId = raw.txnId || raw.transaction_id || raw.transactionId || raw.id || null;

  if (!businessId) {
    return res.status(400).json({ ok: false, error: "missing_business_id" });
  }
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
        qbo_txn_id: null,
        qbo_txn_type: null,
        posted_at: null,
        // NOTE: reconciled_at is preserved for auditability; undo does not void/delete in QBO.
      })
      .eq("business_id", businessId)
      .eq("transaction_id", txnId)
      .select("business_id,transaction_id,status,final_qbo_account_id,final_qbo_account_name");

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
            qbo_txn_id: null,
            qbo_txn_type: null,
            posted_at: null,
          },
          { onConflict: "business_id,transaction_id" }
        )
        .select("business_id,transaction_id,status,final_qbo_account_id,final_qbo_account_name");
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

export default router;
