/* global process */
import crypto from "node:crypto";
import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { learnVendorRuleFromTransaction } from "./vendorRuleLearner.js";
import { isCheck } from "./checkDetector.js";
import { getBookkeepingStartDate, getTransactionsOutsideActiveBookkeepingScope } from "./bookkeepingScope.js";
import { computePostAfterForAutoPost, getAutoPostToQuickBooks } from "./autoPostControl.js";
import {
  confirmCreditCardPaymentPairForTransaction,
  createManualCreditCardPaymentPair,
  linkCategorizationToCreditCardPair,
} from "./creditCardPaymentPairService.js";
import { fetchChartOfAccounts, validateBusinessQboCreditCardAccount } from "./qboAccounts.js";
import { refreshOperatorRequestSummaryBestEffort } from "./operatorRequestSummaryService.js";
import { isProtectedCreditCardPaymentWorkflow } from "./protectedWorkflow.js";
import { evaluateIncomingDepositPostingGuard } from "./incomingDepositMatchService.js";
import { detectProcessorSettlementActivity } from "./processorSettlementProfiles.js";

export class BookkeepingApprovalError extends Error {
  constructor(error, status = 400, details = {}) {
    super(error);
    this.name = "BookkeepingApprovalError";
    this.error = error;
    this.status = status;
    this.details = details;
  }
}

export async function resolveBookkeepingPostAfter({ db = defaultSupabase, businessId, graceHours = 24, nowMs = Date.now() } = {}) {
  const autoPostEnabled = await getAutoPostToQuickBooks(db, businessId);
  return {
    autoPostEnabled,
    postAfter: computePostAfterForAutoPost(autoPostEnabled, graceHours, nowMs),
  };
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

function approvalIdempotencyKey({ businessId, approval, actorType }) {
  return crypto.createHash("sha256").update(JSON.stringify({
    action: "bookkeeping_approval",
    business_id: businessId,
    transaction_id: approval.transaction_id,
    resolution: approval.meta?.user_selected_resolution || "categorize_new",
    final_qbo_account_id: approval.final_qbo_account_id || null,
    actor_type: actorType,
  })).digest("hex");
}

const TAXONOMY_TYPES_REQUIRING_SPECIAL_POSTING_REVIEW = new Set([
  "cc_payment",
  "transfer_internal",
  "bank_transfer",
  "owner_draw",
  "owner_contribution",
  "owner_distribution",
  "refund",
  "loan_payment",
  "loan_movement",
  "tax_payment",
  "payroll",
]);

export function resolveManualApprovalBookkeepingMeta(meta = {}, { explicitFinalAccountId = null } = {}) {
  const next = { ...(meta || {}) };
  const taxonomyType = String(next.taxonomy_type || "").toLowerCase();
  if (!explicitFinalAccountId || !taxonomyType || TAXONOMY_TYPES_REQUIRING_SPECIAL_POSTING_REVIEW.has(taxonomyType)) {
    return next;
  }
  next.resolved_taxonomy_type = next.taxonomy_type;
  next.resolved_taxonomy_subtype = next.taxonomy_subtype || null;
  next.taxonomy_resolved_by = "manual_qbo_account_selection";
  next.taxonomy_override = next.taxonomy_override || "manual_qbo_account_selection";
  delete next.taxonomy_type;
  delete next.taxonomy_subtype;
  delete next.taxonomy_confidence;
  if (next.post_block_reason === "taxonomy_requires_review") delete next.post_block_reason;
  if (next.auto_post_block_reason === "taxonomy_requires_review") delete next.auto_post_block_reason;
  return next;
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
  actor = null,
  actorId = actor,
  actorType = "user",
  reason = null,
  requireNeedsReview = false,
  allowCcPaymentRejection = true,
  extraMetaByTransactionId = {},
  db = defaultSupabase,
  validateSelectedAccountsFn = validateSelectedAccounts,
} = {}) {
  if (!businessId) throw new BookkeepingApprovalError("missing_business_id", 400);
  if (!Array.isArray(items) || !items.length) throw new BookkeepingApprovalError("missing_items", 400);
  if (!actorId) throw new BookkeepingApprovalError("missing_approval_actor", 401);

  const nowIso = new Date().toISOString();
  const { autoPostEnabled, postAfter } = await resolveBookkeepingPostAfter({ db, businessId, graceHours: 24, nowMs: Date.parse(nowIso) });
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

  const excludedIds = txnIds.filter((txnId) => statusMap[txnId] === "excluded" || existingMetaMap[txnId]?.excluded_at);
  if (excludedIds.length) {
    throw new BookkeepingApprovalError("transaction_excluded", 409, { transactions: excludedIds });
  }

  for (const item of items || []) {
    const txnId = txnIdFromItem(item);
    const requested = item?.resolution || null;
    const selected = existingMetaMap[txnId]?.user_selected_resolution || null;
    if (requested && requested !== "categorize_new") throw new BookkeepingApprovalError("resolution_payload_mismatch", 409, { transactions: [txnId] });
    if (selected && selected !== "categorize_new") throw new BookkeepingApprovalError("resolution_changed", 409, { transactions: [txnId], effective_resolution: selected });
  }

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
  await validateSelectedAccountsFn({ businessId, items, explicitFinalByTxn });

  const missingCheckFinals = [];
  const ccPairConfirmTxnIds = new Set();
  const confirmedCcPairs = new Map();

  for (const item of items || []) {
    const txnId = txnIdFromItem(item);
    if (!txnId) continue;
    const meta = existingMetaMap[txnId] || {};
    if (meta?.taxonomy_type !== "cc_payment") continue;
    const explicitFinalId = finalIdFromItem(item);
    const durableCcPayment = isProtectedCreditCardPaymentWorkflow({ meta });
    if (!durableCcPayment && explicitFinalId) {
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
    const pair = await confirmCreditCardPaymentPairForTransaction({ db, businessId, transactionId: txnId });
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
      cc_payment_pair_confirmed_at: pair.updated_at || nowIso,
      cc_payment_pair_confirmed_by: actorId,
      cc_payment_pair_confirmation_source: "books_review",
      match_type: "credit_card_payment_pair",
      safe_to_auto_handle: false,
      safe_to_auto_post: false,
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
      // A new explicit approval starts a new posting generation. Do not let
      // the cancellation marker written by a prior Undo suppress this one.
      delete mergedMeta.posting_cancelled_at;
      delete mergedMeta.post_idempotency_key;
      delete mergedMeta.qbo_request_id;
      delete mergedMeta.post_retry_count;
      delete mergedMeta.posting_started_at;
      delete mergedMeta.next_post_attempt_at;
      mergedMeta.posting_generation = crypto.randomUUID();
      mergedMeta.posting_in_progress = false;
      const isManualPayrollIncome =
        mergedMeta?.taxonomy_type === "payroll" &&
        Number(bankTxn?.amount || 0) > 0 &&
        String(bankTxn?.direction || "INFLOW").toUpperCase() === "INFLOW" &&
        Boolean(explicitFinalId);
      if (isManualPayrollIncome) {
        mergedMeta.resolved_taxonomy_type = "payroll";
        mergedMeta.taxonomy_resolved_by = "manual_income_account_selection";
        mergedMeta.taxonomy_override = "manual_income_account_selection";
        delete mergedMeta.taxonomy_type;
        delete mergedMeta.taxonomy_subtype;
        delete mergedMeta.taxonomy_confidence;
        delete mergedMeta.post_block_reason;
        delete mergedMeta.auto_post_block_reason;
      }
      const isTransferTaxonomy = mergedMeta?.taxonomy_type === "transfer_internal";
      const isCcPaymentTaxonomy = mergedMeta?.taxonomy_type === "cc_payment";
      const isConfirmedCcPaymentPair =
        isCcPaymentTaxonomy &&
        mergedMeta?.cc_payment_pair_id &&
        String(mergedMeta?.cc_payment_pair_status || "").toLowerCase() === "confirmed";
      const isOwnerMove = mergedMeta?.taxonomy_type === "owner_draw" || mergedMeta?.taxonomy_type === "owner_contribution";
      const isRefund = mergedMeta?.taxonomy_type === "refund";
      if (isTransferTaxonomy) {
        mergedMeta.safe_to_auto_post = false;
        mergedMeta.auto_approve_reason = "manual_user";
        mergedMeta.post_block_reason = "transfer_posting_not_supported";
        warnings.push({ transaction_id: txnId, code: "transfer_not_scheduled" });
      } else if (isCcPaymentTaxonomy) {
        mergedMeta.safe_to_auto_handle = false;
        mergedMeta.safe_to_auto_post = false;
        if (isConfirmedCcPaymentPair) {
          delete mergedMeta.post_block_reason;
          mergedMeta.match_type = "credit_card_payment_pair";
        } else {
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
      const postingMeta = resolveManualApprovalBookkeepingMeta(mergedMeta, { explicitFinalAccountId: explicitFinalId });

      const effectiveFinalId = isConfirmedCcPaymentPair
        ? null
        : checkHit.is_check ? explicitFinalId : explicitFinalId || suggestedIdMap[txnId] || null;
      const effectiveFinalName = isConfirmedCcPaymentPair
        ? null
        : checkHit.is_check ? explicitFinalName : explicitFinalName || suggestedNameMap[txnId] || null;
      if (checkHit.is_check && !explicitFinalId) missingCheckFinals.push(txnId);

      return {
        transaction_id: txnId,
        status: isConfirmedCcPaymentPair ? "matched" : item?.status,
        final_qbo_account_id: effectiveFinalId,
        final_qbo_account_name: effectiveFinalName,
        final_canonical_account_key: explicitCanonicalKey || suggestedCanonicalMap[txnId] || mergedMeta?.canonical_account_key || null,
        confidence: item?.confidence || null,
        reason: item?.reason || reason || null,
        learn_reusable_rule: item?.learn_reusable_rule !== false,
        only_this_transaction: item?.only_this_transaction === true || item?.learn_reusable_rule === false,
        post_after:
          isTransferTaxonomy ||
          isCcPaymentTaxonomy ||
          isOwnerMove ||
          isRefund
            ? null
            : postAfter,
        meta: postingMeta,
        is_check: checkHit.is_check === true,
      };
    })
    .filter(Boolean);

  if (!approvals.length) throw new BookkeepingApprovalError("missing_items", 400);
  if (approvals.some((a) => !a.transaction_id)) throw new BookkeepingApprovalError("missing_transaction_id", 400, { approvals });
  if (missingCheckFinals.length) throw new BookkeepingApprovalError("missing_final_account_for_check", 400, { transactions: missingCheckFinals });
  const missingAccounts = approvals
    .filter((a) => !(a.status === "handled" && a.meta?.match_type === "credit_card_payment_pair"))
    .filter((a) => !a.final_qbo_account_id && !a.is_check)
    .map((a) => a.transaction_id);
  if (missingAccounts.length) throw new BookkeepingApprovalError("missing_account_id", 400, { transactions: missingAccounts });

  for (const approval of approvals) {
    const bankTxn = bankTxnMap[approval.transaction_id] || null;
    const amount = Number(bankTxn?.amount || 0);
    const direction = String(bankTxn?.direction || "").toUpperCase();
    const isIncomingDeposit = amount > 0 && (direction === "INFLOW" || !direction);
    const isProcessorFee = detectProcessorSettlementActivity(bankTxn || {})?.kind === "fee";
    if ((!isIncomingDeposit && !isProcessorFee) || approval.meta?.taxonomy_type === "cc_payment") continue;
    const guard = await evaluateIncomingDepositPostingGuard({
      db,
      businessId,
      bankTransactionId: approval.transaction_id,
      actor: actorId,
      actorRole: "manual_approval",
    });
    if (guard.allowed) continue;
    const explicitlyCategorizedAsNew =
      String(approval.meta?.user_selected_resolution || "categorize_new") === "categorize_new" &&
      Boolean(approval.final_qbo_account_id);
    const matchCheckUnavailable = String(guard.reason || "").includes("match_check_unavailable");
    if (explicitlyCategorizedAsNew && matchCheckUnavailable) {
      approval.meta = {
        ...(approval.meta || {}),
        incoming_deposit_match_check: "unavailable_manual_override",
        incoming_deposit_match_status: guard.result?.status || null,
        incoming_deposit_reason_codes: guard.result?.reason_codes || [],
      };
      warnings.push({ transaction_id: approval.transaction_id, code: "match_check_unavailable_manual_override" });
      continue;
    }
    approval.status = "needs_review";
    approval.post_after = null;
    approval.post_error = guard.reason || "incoming_deposit_match_required";
    approval.meta = {
      ...(approval.meta || {}),
      safe_to_auto_post: false,
      post_block_reason: approval.post_error,
      incoming_deposit_match_id: guard.result?.match?.id || null,
      incoming_deposit_match_status: guard.result?.status || null,
      incoming_deposit_confidence_tier: guard.result?.confidence_tier || null,
      incoming_deposit_reason_codes: guard.result?.reason_codes || [],
    };
    warnings.push({ transaction_id: approval.transaction_id, code: approval.post_error });
  }

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
    const idempotencyKey = approvalIdempotencyKey({ businessId, approval: item, actorType });
    return {
      business_id: businessId,
      transaction_id: item.transaction_id,
      status: item.status || "approved",
      final_qbo_account_id: item.final_qbo_account_id || null,
      final_qbo_account_name: item.final_qbo_account_name || null,
      final_canonical_account_key: item.final_canonical_account_key || null,
      confidence: item.confidence || null,
      reason: item.reason || null,
      decided_by: actorType,
      decided_at: nowIso,
      updated_at: nowIso,
      post_after: item.post_after === undefined ? postAfter : item.post_after,
      post_error: item.post_error || null,
      meta: { ...(mergedMeta || {}), approval_idempotency_key: idempotencyKey },
      approval_idempotency_key: idempotencyKey,
    };
  });

  const atomicPayload = payload.map(({ approval_idempotency_key, ...row }) => ({ ...row, approval_idempotency_key }));
  const { data, error } = await db.rpc("approve_bookkeeping_transactions_atomic", {
    p_business_id: businessId,
    p_actor_id: actorId,
    p_actor_type: actorType,
    p_approvals: atomicPayload,
    p_require_needs_review: requireNeedsReview === true,
  });
  if (error) throw new BookkeepingApprovalError("approve_failed", 500, { message: error.message });

  for (const pair of confirmedCcPairs.values()) {
    await linkCategorizationToCreditCardPair({ db, businessId, pair });
  }

  const vendorRuleResults = [];
  for (const item of approvals) {
    try {
      const bankTxn = bankTxnMap[item.transaction_id];
      if (!bankTxn) continue;
      const taxonomyType = (existingMetaMap[item.transaction_id] || {}).taxonomy_type || null;
      const checkHit = isCheck(bankTxn || {});
      if (checkHit.is_check) {
        const learnResult = await learnVendorRuleFromTransaction({
          businessId,
          bankTxn,
          finalAccountId: item.final_qbo_account_id,
          finalAccountName: item.final_qbo_account_name,
          taxonomyType,
          options: {
            allowQboEntityFallback: true,
            learnedFrom: "check",
            actor: actorId,
            onlyThisTransaction: item.only_this_transaction === true || item.learn_reusable_rule === false,
          },
          db,
        });
        vendorRuleResults.push({ transaction_id: item.transaction_id, ...learnResult });
      } else {
        const learnResult = await learnVendorRuleFromTransaction({
          businessId,
          bankTxn,
          finalAccountId: item.final_qbo_account_id,
          finalAccountName: item.final_qbo_account_name,
          taxonomyType,
          options: {
            actor: actorId,
            onlyThisTransaction: item.only_this_transaction === true || item.learn_reusable_rule === false,
          },
          db,
        });
        vendorRuleResults.push({ transaction_id: item.transaction_id, ...learnResult });
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

  return { ok: true, updated: data?.length || 0, rows: data || [], warnings, auto_post_enabled: autoPostEnabled === true, vendor_rule_results: vendorRuleResults };
}
