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
import {
  detectQuickBooksPaymentsProtectedWorkflow,
  hasAuthoritativeQuickBooksMatch,
  quickBooksPaymentsProtectedMeta,
} from "./quickBooksPaymentsProtectedWorkflow.js";
import {
  resolveManualApprovalBookkeepingMeta as resolveManualApprovalPostingMeta,
} from "./postingDecisionAuthority.js";

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

const UNCONFIRMED_INCOMING_DEPOSIT_META_KEYS = [
  "incoming_deposit_match_id",
  "incoming_deposit_match_status",
  "incoming_deposit_confidence_tier",
  "incoming_deposit_reason_codes",
  "incoming_deposit_confirmable",
  "incoming_deposit_confirmability_reason",
  "incoming_deposit_independent_candidate_count",
  "incoming_deposit_candidates",
  "incoming_deposit_match_check",
];

export function supersedeUnconfirmedIncomingDepositProposal(meta = {}, { actorId, actorType, source, nowIso } = {}) {
  if (hasAuthoritativeQuickBooksMatch({ meta })) return meta;
  const proposal = Object.fromEntries(
    UNCONFIRMED_INCOMING_DEPOSIT_META_KEYS
      .filter((key) => meta[key] !== undefined)
      .map((key) => [key, meta[key]])
  );
  const next = { ...meta };
  for (const key of UNCONFIRMED_INCOMING_DEPOSIT_META_KEYS) delete next[key];
  delete next.post_block_reason;
  delete next.auto_post_block_reason;
  if (Object.keys(proposal).length) {
    next.abandoned_match_proposal = {
      ...proposal,
      superseded_at: nowIso,
      superseded_by: actorId || null,
      superseded_by_type: actorType || "user",
      resolution: "categorize_new",
      source: source || "books_review",
    };
  }
  next.incoming_deposit_resolution = "categorized_as_new";
  next.duplicate_risk_acknowledged = true;
  return next;
}

async function persistVendorRuleLearningRetry({ db, businessId, transactionId, actorId, actorType, error }) {
  const row = {
    business_id: businessId,
    transaction_id: transactionId,
    actor_id: actorId || null,
    actor_type: actorType || "user",
    status: "pending",
    attempt_count: 0,
    last_error: String(error || "vendor_rule_learning_failed").slice(0, 1000),
    process_after: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  try {
    const { error: retryError } = await db
      .from("vendor_rule_learning_jobs")
      .upsert(row, { onConflict: "business_id,transaction_id" });
    return retryError ? { queued: false, queue_error: retryError.message } : { queued: true };
  } catch (retryError) {
    return { queued: false, queue_error: retryError?.message || "vendor_rule_learning_retry_persist_failed" };
  }
}

export function resolveManualApprovalBookkeepingMeta(meta = {}, options = {}) {
  return resolveManualApprovalPostingMeta(meta, options);
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
  source = "books_review",
  reason = null,
  requireNeedsReview = false,
  allowCcPaymentRejection = true,
  extraMetaByTransactionId = {},
  existingMetaOverrideByTransactionId = {},
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
    existingMetaMap[row.transaction_id] = Object.prototype.hasOwnProperty.call(existingMetaOverrideByTransactionId, row.transaction_id)
      ? existingMetaOverrideByTransactionId[row.transaction_id] || {}
      : row.meta || {};
    statusMap[row.transaction_id] = row.status || null;
    suggestedIdMap[row.transaction_id] = row.suggested_qbo_account_id || null;
    suggestedNameMap[row.transaction_id] = row.suggested_qbo_account_name || null;
    suggestedCanonicalMap[row.transaction_id] = row.suggested_canonical_account_key || row.meta?.canonical_account_key || null;
  });

  const requestedIdempotencyKeys = (items || []).map((item) => approvalIdempotencyKey({
    businessId,
    actorType,
    approval: {
      transaction_id: txnIdFromItem(item),
      final_qbo_account_id: finalIdFromItem(item),
      meta: { user_selected_resolution: item?.resolution || existingMetaMap[txnIdFromItem(item)]?.user_selected_resolution || "categorize_new" },
    },
  }));
  const { data: priorApprovalEvents, error: priorApprovalError } = await db
    .from("bookkeeping_approval_events")
    .select("idempotency_key")
    .eq("business_id", businessId)
    .in("idempotency_key", requestedIdempotencyKeys);
  if (priorApprovalError) throw new BookkeepingApprovalError("approval_idempotency_check_failed", 500, { message: priorApprovalError.message });
  const priorKeys = new Set((priorApprovalEvents || []).map((row) => row.idempotency_key));
  if (requestedIdempotencyKeys.length > 0 && requestedIdempotencyKeys.every((key) => priorKeys.has(key))) {
    const { data: currentRows, error: currentRowsError } = await db
      .from("transaction_categorizations")
      .select("*")
      .eq("business_id", businessId)
      .in("transaction_id", txnIds);
    if (currentRowsError) throw new BookkeepingApprovalError("categorization_fetch_failed", 500, { message: currentRowsError.message });
    return { updated: currentRows?.length || 0, rows: currentRows || [], warnings: [], vendor_rule_results: [], idempotent: true };
  }

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

  const protectedQuickBooksPayments = (bankTxns || [])
    .map((row) => ({ row, detection: detectQuickBooksPaymentsProtectedWorkflow(row) }))
    .filter(({ row, detection }) => {
      if (!detection || hasAuthoritativeQuickBooksMatch({ status: statusMap[row.id], meta: existingMetaMap[row.id] })) return false;
      const item = items.find((candidate) => String(txnIdFromItem(candidate)) === String(row.id));
      return item?.duplicate_risk_acknowledged !== true;
    });
  if (protectedQuickBooksPayments.length) {
    for (const { row, detection } of protectedQuickBooksPayments) {
      const meta = quickBooksPaymentsProtectedMeta(existingMetaMap[row.id], detection);
      await db
        .from("transaction_categorizations")
        .update({ status: "needs_review", post_after: null, post_error: null, meta, updated_at: nowIso })
        .eq("business_id", businessId)
        .eq("transaction_id", row.id)
        .in("status", ["needs_review", "uncategorized", "approved", "auto_approved", "failed", "handled"]);
    }
    throw new BookkeepingApprovalError("quickbooks_payments_match_required", 409, {
      transactions: protectedQuickBooksPayments.map(({ row }) => row.id),
    });
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
      const postingMeta = resolveManualApprovalBookkeepingMeta(mergedMeta, {
        explicitFinalAccountId: explicitFinalId,
        source: isManualPayrollIncome ? "manual_income_account_selection" : "manual_qbo_account_selection",
      });
      const isTransferTaxonomy = postingMeta?.taxonomy_type === "transfer_internal" || postingMeta?.taxonomy_type === "bank_transfer";
      const isCcPaymentTaxonomy = postingMeta?.taxonomy_type === "cc_payment";
      const isConfirmedCcPaymentPair =
        isCcPaymentTaxonomy &&
        postingMeta?.cc_payment_pair_id &&
        String(postingMeta?.cc_payment_pair_status || "").toLowerCase() === "confirmed";
      if (isTransferTaxonomy) {
        postingMeta.safe_to_auto_post = false;
        postingMeta.auto_approve_reason = "manual_user";
        postingMeta.post_block_reason = "transfer_posting_not_supported";
        warnings.push({ transaction_id: txnId, code: "transfer_not_scheduled" });
      } else if (isCcPaymentTaxonomy) {
        postingMeta.safe_to_auto_handle = false;
        postingMeta.safe_to_auto_post = false;
        if (isConfirmedCcPaymentPair) {
          delete postingMeta.post_block_reason;
          postingMeta.match_type = "credit_card_payment_pair";
        } else {
          postingMeta.post_block_reason = "cc_payment_mapping_not_safe";
          warnings.push({ transaction_id: txnId, code: "cc_payment_not_scheduled" });
        }
      } else {
        postingMeta.safe_to_auto_post = true;
        postingMeta.auto_approve_reason = "manual_user";
      }

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
        final_canonical_account_key: explicitCanonicalKey || suggestedCanonicalMap[txnId] || postingMeta?.canonical_account_key || null,
        confidence: item?.confidence || null,
        reason: item?.reason || reason || null,
        learn_reusable_rule: item?.learn_reusable_rule !== false,
        only_this_transaction: item?.only_this_transaction === true || item?.learn_reusable_rule === false,
        post_after:
          isTransferTaxonomy ||
          isCcPaymentTaxonomy
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
    const approvalItem = items.find((item) => String(txnIdFromItem(item)) === String(approval.transaction_id));
    const duplicateRiskAcknowledged = approvalItem?.duplicate_risk_acknowledged === true;
    const authoritativeMatch = guard.result?.status === "confirmed" || approval.meta?.matched_existing_qbo === true;
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
    if (explicitlyCategorizedAsNew && duplicateRiskAcknowledged && !authoritativeMatch) {
      approval.meta = supersedeUnconfirmedIncomingDepositProposal(approval.meta || {}, {
        actorId,
        actorType,
        source,
        nowIso,
      });
      warnings.push({ transaction_id: approval.transaction_id, code: "possible_qbo_match_manual_override" });
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
            actor: { id: actorId, role: actorType },
            onlyThisTransaction: item.only_this_transaction === true || item.learn_reusable_rule === false,
          },
          db,
        });
        if (learnResult?.ok === false) {
          const retry = await persistVendorRuleLearningRetry({ db, businessId, transactionId: item.transaction_id, actorId, actorType, error: learnResult.error });
          vendorRuleResults.push({ transaction_id: item.transaction_id, ...learnResult, retryable: true, ...retry });
        } else vendorRuleResults.push({ transaction_id: item.transaction_id, ...learnResult });
      } else {
        const learnResult = await learnVendorRuleFromTransaction({
          businessId,
          bankTxn,
          finalAccountId: item.final_qbo_account_id,
          finalAccountName: item.final_qbo_account_name,
          taxonomyType,
          options: {
            actor: { id: actorId, role: actorType },
            onlyThisTransaction: item.only_this_transaction === true || item.learn_reusable_rule === false,
          },
          db,
        });
        if (learnResult?.ok === false) {
          const retry = await persistVendorRuleLearningRetry({ db, businessId, transactionId: item.transaction_id, actorId, actorType, error: learnResult.error });
          vendorRuleResults.push({ transaction_id: item.transaction_id, ...learnResult, retryable: true, ...retry });
        } else vendorRuleResults.push({ transaction_id: item.transaction_id, ...learnResult });
      }
    } catch (e) {
      const retry = await persistVendorRuleLearningRetry({ db, businessId, transactionId: item.transaction_id, actorId, actorType, error: e?.message || e });
      vendorRuleResults.push({
        transaction_id: item.transaction_id,
        ok: false,
        error: e?.message || "vendor_rule_learning_failed",
        approval_succeeded: true,
        retryable: true,
        ...retry,
      });
      if (process.env.NODE_ENV !== "production") {
        console.warn("[bookkeeping][approve] vendor rule learning queued for retry", e?.message || e);
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
