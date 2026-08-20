import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { learnVendorRuleFromTransaction } from "./vendorRuleLearner.js";
import { isCheck } from "./checkDetector.js";
import { getBookkeepingStartDate, getTransactionsOutsideActiveBookkeepingScope } from "./bookkeepingScope.js";
import { computePostAfterForAutoPost, getAutoPostToQuickBooks } from "./autoPostControl.js";
import {
  confirmCreditCardPaymentPairForTransaction,
  createManualCreditCardPaymentPair,
} from "./creditCardPaymentPairService.js";
import { fetchChartOfAccounts, validateBusinessQboCreditCardAccount } from "./qboAccounts.js";
import { refreshOperatorRequestSummaryBestEffort } from "./operatorRequestSummaryService.js";

export class BookkeepingApprovalError extends Error {
  constructor(error, status = 400, details = {}) {
    super(error);
    this.name = "BookkeepingApprovalError";
    this.error = error;
    this.status = status;
    this.details = details;
  }
}

function txnIdFromItem(item = {}) {
  return item?.txnId || item?.transaction_id || item?.transactionId || item?.id || null;
}

function finalIdFromItem(item = {}) {
  return item?.newAccountId || item?.final_qbo_account_id || item?.finalAccountId || null;
}

function finalNameFromItem(item = {}) {
  return item?.newAccountName || item?.final_qbo_account_name || item?.finalAccountName || null;
}

function canonicalKeyFromItem(item = {}) {
  return item?.final_canonical_account_key || item?.canonical_account_key || item?.canonicalAccountKey || null;
}

async function validateSelectedAccounts({ businessId, items, explicitFinalByTxn }) {
  const ids = Array.from(new Set(Object.values(explicitFinalByTxn).filter(Boolean).map(String)));
  if (!ids.length) return;
  const accounts = await fetchChartOfAccounts(businessId, { includeSubaccounts: true });
  const accountMap = new Map((accounts || []).map((account) => [String(account.id), account]));
  const invalid = ids.filter((id) => {
    const account = accountMap.get(String(id));
    return !account || account.active === false;
  });
  if (invalid.length) {
    throw new BookkeepingApprovalError("invalid_qbo_account", 400, { accounts: invalid });
  }
  for (const item of items || []) {
    const txnId = txnIdFromItem(item);
    const explicitId = finalIdFromItem(item);
    const explicitName = finalNameFromItem(item);
    const account = explicitId ? accountMap.get(String(explicitId)) : null;
    if (txnId && account && explicitName && String(account.name || "") !== String(explicitName || "")) {
      explicitFinalByTxn[txnId] = String(account.id);
    }
  }
}

export async function approveBookkeepingTransactions({
  businessId,
  items = [],
  actor = "user",
  reason = null,
  requireNeedsReview = false,
  allowCcPaymentRejection = true,
  extraMetaByTransactionId = {},
  db = defaultSupabase,
} = {}) {
  if (!businessId) throw new BookkeepingApprovalError("missing_business_id", 400);
  if (!Array.isArray(items) || !items.length) throw new BookkeepingApprovalError("missing_items", 400);

  const nowIso = new Date().toISOString();
  const autoPostEnabled = await getAutoPostToQuickBooks(db, businessId);
  const postAfter = computePostAfterForAutoPost(autoPostEnabled, 24);
  const txnIds = items.map(txnIdFromItem).filter(Boolean);
  if (!txnIds.length) throw new BookkeepingApprovalError("missing_items", 400);

  const { data: existingMetaRows, error: catFetchErr } = await db
    .from("transaction_categorizations")
    .select("transaction_id,status,meta,suggested_qbo_account_id,suggested_qbo_account_name,suggested_canonical_account_key")
    .eq("business_id", businessId)
    .in("transaction_id", txnIds);
  if (catFetchErr) throw new BookkeepingApprovalError("categorization_fetch_failed", 500, { message: catFetchErr.message });

  const existingMetaMap = {};
  const statusMap = {};
  const suggestedIdMap = {};
  const suggestedNameMap = {};
  const suggestedCanonicalMap = {};
  (existingMetaRows || []).forEach((row) => {
    existingMetaMap[row.transaction_id] = row.meta || {};
    statusMap[row.transaction_id] = row.status || null;
    suggestedIdMap[row.transaction_id] = row.suggested_qbo_account_id || null;
    suggestedNameMap[row.transaction_id] = row.suggested_qbo_account_name || null;
    suggestedCanonicalMap[row.transaction_id] = row.suggested_canonical_account_key || row.meta?.canonical_account_key || null;
  });

  if (requireNeedsReview) {
    const invalidStatusIds = txnIds.filter((txnId) => {
      const status = statusMap[txnId] || "needs_review";
      return !["", "needs_review", "uncategorized"].includes(String(status || "").toLowerCase());
    });
    if (invalidStatusIds.length) {
      throw new BookkeepingApprovalError("transaction_not_needs_review", 409, { transactions: invalidStatusIds });
    }
  }

  const warnings = [];

  const { data: bankTxns, error: bankErr } = await db
    .from("bank_transactions")
    .select("id,date,name,merchant_name,counterparty_name,transaction_type,check_number,merchant_entity_id,qbo_entity_type,qbo_entity_id,amount,direction,category_primary,personal_finance_category,plaid_account_id,pending,accounting_review_required,accounting_review_reason")
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .in("id", txnIds);
  if (bankErr) throw new BookkeepingApprovalError("bank_fetch_failed", 500, { message: bankErr.message });

  const foundIds = new Set((bankTxns || []).map((row) => String(row.id)));
  const missingTxnIds = txnIds.filter((txnId) => !foundIds.has(String(txnId)));
  if (missingTxnIds.length) {
    throw new BookkeepingApprovalError("transaction_not_found", 404, { transactions: missingTxnIds });
  }

  const bankTxnMap = (bankTxns || []).reduce((acc, row) => {
    acc[row.id] = row;
    return acc;
  }, {});

  const pendingIds = (bankTxns || []).filter((row) => row.pending === true).map((row) => row.id);
  if (pendingIds.length) {
    await db
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
    throw new BookkeepingApprovalError("pending_transaction_not_postable", 400, { transactions: pendingIds });
  }

  const reviewIds = (bankTxns || []).filter((row) => row.accounting_review_required === true).map((row) => row.id);
  if (reviewIds.length) {
    throw new BookkeepingApprovalError("plaid_accounting_review_required", 400, { transactions: reviewIds });
  }

  const bookkeepingStartDate = await getBookkeepingStartDate(db, businessId);
  const preCutoffIds = getTransactionsOutsideActiveBookkeepingScope(bankTxns || [], bookkeepingStartDate).map((row) => row.id);
  if (preCutoffIds.length) {
    throw new BookkeepingApprovalError("transaction_before_bookkeeping_start_date", 400, {
      bookkeeping_start_date: bookkeepingStartDate,
      transactions: preCutoffIds,
    });
  }

  const explicitFinalByTxn = {};
  for (const item of items || []) {
    const txnId = txnIdFromItem(item);
    const explicitFinalId = finalIdFromItem(item);
    if (txnId && explicitFinalId) explicitFinalByTxn[txnId] = explicitFinalId;
  }
  await validateSelectedAccounts({ businessId, items, explicitFinalByTxn });

  const missingCheckFinals = [];
  const ccPairConfirmTxnIds = new Set();
  const confirmedCcPairs = new Map();

  for (const item of items || []) {
    const txnId = txnIdFromItem(item);
    if (!txnId) continue;
    const meta = existingMetaMap[txnId] || {};
    if (meta?.taxonomy_type !== "cc_payment") continue;
    const explicitFinalId = finalIdFromItem(item);
    if (!meta.cc_payment_pair_id && explicitFinalId) {
      const targetValidation = await validateBusinessQboCreditCardAccount(businessId, explicitFinalId);
      if (!targetValidation?.ok) {
        if (allowCcPaymentRejection !== true) {
          throw new BookkeepingApprovalError(targetValidation?.reason || "cc_payment_target_credit_card_required", 400, {
            transactions: [txnId],
          });
        }
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
          throw new BookkeepingApprovalError(code, 400, { transactions: [txnId] });
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
      const txnId = txnIdFromItem(item);
      const explicitFinalId = finalIdFromItem(item);
      const explicitFinalName = finalNameFromItem(item);
      const explicitCanonicalKey = canonicalKeyFromItem(item);
      const bankTxn = bankTxnMap[txnId] || null;
      const checkHit = isCheck(bankTxn || {});
      const mergedMeta = {
        ...(existingMetaMap[txnId] || {}),
        ...(extraMetaByTransactionId?.[txnId] || {}),
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
      if (checkHit.is_check && !explicitFinalId) missingCheckFinals.push(txnId);

      return {
        transaction_id: txnId,
        final_qbo_account_id: effectiveFinalId,
        final_qbo_account_name: effectiveFinalName,
        final_canonical_account_key: explicitCanonicalKey || suggestedCanonicalMap[txnId] || mergedMeta?.canonical_account_key || null,
        confidence: item?.confidence || null,
        reason: item?.reason || reason || null,
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

  if (!approvals.length) throw new BookkeepingApprovalError("missing_items", 400);
  if (approvals.some((a) => !a.transaction_id)) throw new BookkeepingApprovalError("missing_transaction_id", 400, { approvals });
  if (missingCheckFinals.length) throw new BookkeepingApprovalError("missing_final_account_for_check", 400, { transactions: missingCheckFinals });
  const missingAccounts = approvals.filter((a) => !a.final_qbo_account_id && !a.is_check).map((a) => a.transaction_id);
  if (missingAccounts.length) throw new BookkeepingApprovalError("missing_account_id", 400, { transactions: missingAccounts });

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
      decided_by: actor,
      decided_at: nowIso,
      updated_at: nowIso,
      post_after: item.post_after === undefined ? postAfter : item.post_after,
      post_error: null,
      meta: mergedMeta || null,
    };
  });

  const { data, error } = await db
    .from("transaction_categorizations")
    .upsert(payload, { onConflict: "business_id,transaction_id" })
    .select("business_id,transaction_id,status,final_qbo_account_id,final_qbo_account_name,post_after,meta");
  if (error) throw new BookkeepingApprovalError("approve_failed", 500, { message: error.message });

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
      await db
        .from("transaction_categorizations")
        .upsert({
          business_id: businessId,
          transaction_id: pairRow.transaction_id,
          status: "approved",
          final_qbo_account_id: pairRow.final_qbo_account_id,
          final_qbo_account_name: pairRow.final_qbo_account_name,
          confidence: "high",
          reason: "Confirmed credit-card payment transfer",
          decided_by: actor,
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

  await refreshOperatorRequestSummaryBestEffort({
    businessId,
    db,
    reason: "human_approval",
  });

  return { ok: true, updated: data?.length || 0, rows: data || [], warnings, auto_post_enabled: autoPostEnabled === true };
}
