import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { getQBOClient as defaultGetQBOClient } from "../../utils/qboClient.js";
import { isCheck } from "./checkDetector.js";
import { getBookkeepingStartDate, isTransactionInActiveBookkeepingScope } from "./bookkeepingScope.js";
import { fetchQboAccountByIdForBusiness } from "./qboAccounts.js";
import {
  approveBookkeepingTransactions,
  BookkeepingApprovalError,
} from "./bookkeepingApprovalService.js";
import { refreshOperatorRequestSummaryBestEffort } from "./operatorRequestSummaryService.js";

export class BookkeepingReclassificationError extends Error {
  constructor(error, status = 400, details = {}) {
    super(error);
    this.name = "BookkeepingReclassificationError";
    this.error = error;
    this.status = status;
    this.details = details;
  }
}

const GENERIC_RECLASS_BLOCKED_TAXONOMIES = new Set([
  "cc_payment",
  "transfer_internal",
  "bank_transfer",
  "owner_draw",
  "owner_contribution",
  "owner_distribution",
  "refund",
  "loan_movement",
  "tax_payment",
  "payroll",
]);

const GENERIC_RECLASS_BLOCKED_ACCOUNT_TYPES = new Set([
  "bank",
  "creditcard",
  "credit_card",
  "credit card",
  "accounts receivable",
  "accounts payable",
]);

export async function reclassifyBookkeepingTransaction({
  businessId,
  transactionId,
  targetQboAccountId,
  actor,
  source = "monthly_review",
  reason = "Adjusted GL account during monthly review.",
  db = defaultSupabase,
  validateQboAccount = fetchQboAccountByIdForBusiness,
  approveTransactions = approveBookkeepingTransactions,
  getQBOClient = defaultGetQBOClient,
} = {}) {
  if (!businessId) throw new BookkeepingReclassificationError("missing_business_id", 400);
  if (!transactionId) throw new BookkeepingReclassificationError("missing_transaction_id", 400);
  if (!targetQboAccountId) throw new BookkeepingReclassificationError("missing_account", 400);

  const targetAccount = await resolveTargetAccount({ businessId, targetQboAccountId, validateQboAccount });
  const context = await loadReclassificationContext({ db, businessId, transactionId });
  assertGenericReclassificationAllowed(context);

  const previous = context.categorization || null;
  const previousStatus = String(previous?.status || "needs_review").toLowerCase();
  const posted = Boolean(previous?.qbo_txn_id);
  const now = new Date().toISOString();

  if (posted) {
    const qboUpdate = await updatePostedQboTransactionAccount({
      businessId,
      qboTxnId: previous.qbo_txn_id,
      qboTxnType: previous.qbo_txn_type,
      accountId: targetAccount.id,
      accountName: targetAccount.name,
      getQBOClient,
    });
    const updated = await updateCategorizationAfterPostedReclassification({
      db,
      businessId,
      transactionId,
      previous,
      targetAccount,
      actor,
      source,
      reason,
      now,
      qboUpdate,
    });
    return {
      ok: true,
      mode: "posted_qbo_reclassification",
      transaction_id: transactionId,
      previous,
      categorization: updated,
      target_account: targetAccount,
      qbo_update: qboUpdate,
      posting_summary: null,
    };
  }

  if (isNeedsReviewStatus(previousStatus)) {
    let approval;
    try {
      approval = await approveTransactions({
        businessId,
        items: [{
          transaction_id: transactionId,
          final_qbo_account_id: targetAccount.id,
          final_qbo_account_name: targetAccount.name,
          reason,
        }],
        actor,
        reason,
        requireNeedsReview: true,
        allowCcPaymentRejection: false,
        extraMetaByTransactionId: {
          [transactionId]: buildDecisionMeta(previous?.meta, {
            actor,
            source,
            reason,
            previous,
            targetAccount,
            now,
            qboUpdated: false,
          }),
        },
        db,
      });
    } catch (err) {
      if (err instanceof BookkeepingApprovalError) {
        throw new BookkeepingReclassificationError(err.error || err.message, err.status || 400, err.details || {});
      }
      throw err;
    }
    const operatorResponseResolution = await resolveOperatorResponsesAfterApproval({
      db,
      businessId,
      transactionId,
      actor,
      targetAccount,
      now,
      source,
    });
    const updated = Array.isArray(approval?.rows) ? approval.rows.find((row) => String(row.transaction_id) === String(transactionId)) : null;
    return {
      ok: true,
      mode: "needs_review_approval",
      transaction_id: transactionId,
      previous,
      categorization: updated || null,
      target_account: targetAccount,
      qbo_update: null,
      posting_summary: null,
      approval,
      operator_response_resolution: operatorResponseResolution,
    };
  }

  if (isHandledUnpostedStatus(previousStatus)) {
    const updated = await updateHandledUnpostedCategorization({
      db,
      businessId,
      transactionId,
      previous,
      targetAccount,
      actor,
      source,
      reason,
      now,
    });
    return {
      ok: true,
      mode: "handled_unposted_reclassification",
      transaction_id: transactionId,
      previous,
      categorization: updated,
      target_account: targetAccount,
      qbo_update: null,
      posting_summary: null,
    };
  }

  throw new BookkeepingReclassificationError("transaction_state_not_reclassifiable", 409, {
    transaction_id: transactionId,
    status: previousStatus || null,
  });
}

export async function updatePostedQboTransactionAccount({
  businessId,
  qboTxnId,
  qboTxnType,
  accountId,
  accountName,
  getQBOClient = defaultGetQBOClient,
} = {}) {
  const txnType = normalizeQboTxnType(qboTxnType);
  if (!txnType) throw new BookkeepingReclassificationError("missing_qbo_txn_type", 409);
  if (!["Purchase", "Deposit", "CreditCardCharge"].includes(txnType)) {
    throw new BookkeepingReclassificationError(`unsupported_qbo_txn_type_${txnType}`, 409);
  }

  const qbo = await getQBOClient(businessId);
  if (!qbo) throw new BookkeepingReclassificationError("qbo_client_unavailable", 503);

  const baseTxn = await fetchQboTransaction(qbo, txnType, qboTxnId);
  const loadedId = baseTxn?.Id || baseTxn?.id || null;
  if (!loadedId) throw new BookkeepingReclassificationError("qbo_transaction_not_found", 404);
  if (String(loadedId) !== String(qboTxnId)) {
    throw new BookkeepingReclassificationError("qbo_transaction_identity_mismatch", 409, {
      expected_qbo_txn_id: qboTxnId,
      actual_qbo_txn_id: loadedId,
    });
  }

  const updatedTxn = rewriteQboTransactionAccount(baseTxn, txnType, accountId, accountName);
  const providerResponse = await updateQboTransaction(qbo, txnType, updatedTxn);

  return {
    ok: true,
    qbo_txn_id: qboTxnId,
    qbo_txn_type: txnType,
    final_qbo_account_id: String(accountId),
    final_qbo_account_name: accountName,
    sync_token_before: baseTxn.SyncToken || null,
    sync_token_after: providerResponse?.SyncToken || providerResponse?.[txnType]?.SyncToken || null,
    updated_at: new Date().toISOString(),
  };
}

async function resolveTargetAccount({ businessId, targetQboAccountId, validateQboAccount }) {
  const resolved = await validateQboAccount(businessId, targetQboAccountId);
  if (!resolved?.ok || !resolved.account) {
    throw new BookkeepingReclassificationError(resolved?.reason || "invalid_qbo_account", 400, {
      account_id: targetQboAccountId,
      realm_id: resolved?.realmId || null,
    });
  }
  const account = {
    id: String(resolved.account.id),
    name: resolved.account.name || resolved.account.fullyQualifiedName || resolved.account.FullyQualifiedName || null,
    type: resolved.account.type || resolved.account.AccountType || null,
    subType: resolved.account.subType || resolved.account.AccountSubType || null,
    active: resolved.account.active !== false && resolved.account.Active !== false,
    realmId: resolved.realmId || null,
  };
  if (!account.active) {
    throw new BookkeepingReclassificationError("inactive_qbo_account", 400, { account_id: targetQboAccountId });
  }
  if (!account.name) {
    throw new BookkeepingReclassificationError("qbo_account_missing_name", 400, { account_id: targetQboAccountId });
  }
  const typeKey = String(account.type || "").trim().toLowerCase();
  if (GENERIC_RECLASS_BLOCKED_ACCOUNT_TYPES.has(typeKey)) {
    throw new BookkeepingReclassificationError("target_account_not_valid_for_generic_gl_reclassification", 400, {
      account_id: targetQboAccountId,
      account_type: account.type || null,
    });
  }
  return account;
}

async function loadReclassificationContext({ db, businessId, transactionId }) {
  const { data: bankTxn, error: bankErr } = await db
    .from("bank_transactions")
    .select("id,business_id,date,name,merchant_name,counterparty_name,amount,signed_amount,direction,plaid_transaction_id,transaction_type,check_number,pending,is_archived,accounting_review_required,accounting_review_reason")
    .eq("business_id", businessId)
    .eq("id", transactionId)
    .maybeSingle();
  if (bankErr) throw new BookkeepingReclassificationError("bank_fetch_failed", 500, { message: bankErr.message });
  if (!bankTxn || bankTxn.is_archived === true) throw new BookkeepingReclassificationError("transaction_not_found", 404);

  const bookkeepingStartDate = await getBookkeepingStartDate(db, businessId);
  if (!isTransactionInActiveBookkeepingScope(bankTxn, bookkeepingStartDate)) {
    throw new BookkeepingReclassificationError("transaction_before_bookkeeping_start_date", 400, {
      bookkeeping_start_date: bookkeepingStartDate,
      transaction_id: transactionId,
    });
  }

  const { data: categorization, error: catErr } = await db
    .from("transaction_categorizations")
    .select("business_id,transaction_id,status,final_qbo_account_id,final_qbo_account_name,final_canonical_account_key,suggested_qbo_account_id,suggested_qbo_account_name,suggested_canonical_account_key,qbo_txn_id,qbo_txn_type,post_after,post_error,meta,updated_at")
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .maybeSingle();
  if (catErr) throw new BookkeepingReclassificationError("categorization_fetch_failed", 500, { message: catErr.message });

  return { bankTxn, categorization, bookkeepingStartDate };
}

function assertGenericReclassificationAllowed({ bankTxn, categorization }) {
  if (bankTxn?.pending === true) {
    throw new BookkeepingReclassificationError("pending_transaction_not_postable", 400, { transaction_id: bankTxn.id });
  }
  if (bankTxn?.accounting_review_required === true) {
    throw new BookkeepingReclassificationError("plaid_accounting_review_required", 400, { transaction_id: bankTxn.id });
  }
  const meta = categorization?.meta || {};
  const taxonomyType = String(meta.taxonomy_type || "").toLowerCase();
  const looksCcPayment =
    taxonomyType === "cc_payment" ||
    meta.cc_payment_pair_id ||
    meta.cc_payment_bank_qbo_account_id ||
    meta.cc_payment_cc_qbo_account_id ||
    meta.cc_payment_mapping_confidence;
  if (looksCcPayment) {
    throw new BookkeepingReclassificationError("cc_payment_generic_reclassification_not_supported", 409, {
      transaction_id: bankTxn.id,
      cc_payment_pair_id: meta.cc_payment_pair_id || null,
    });
  }
  if (taxonomyType && GENERIC_RECLASS_BLOCKED_TAXONOMIES.has(taxonomyType)) {
    throw new BookkeepingReclassificationError("special_workflow_reclassification_not_supported", 409, {
      transaction_id: bankTxn.id,
      taxonomy_type: taxonomyType,
    });
  }
  const checkHit = isCheck(bankTxn || {});
  if (meta.is_check === true || checkHit.is_check === true) {
    throw new BookkeepingReclassificationError("check_generic_reclassification_not_supported", 409, {
      transaction_id: bankTxn.id,
    });
  }
  if (String(categorization?.status || "").toLowerCase() === "posted" && !categorization?.qbo_txn_id) {
    throw new BookkeepingReclassificationError("posted_transaction_missing_qbo_reference", 409, {
      transaction_id: bankTxn.id,
    });
  }
}

function isNeedsReviewStatus(status = "") {
  return ["", "needs_review", "uncategorized"].includes(String(status || "").toLowerCase());
}

function isHandledUnpostedStatus(status = "") {
  return ["approved", "auto_approved", "handled"].includes(String(status || "").toLowerCase());
}

async function updateHandledUnpostedCategorization({
  db,
  businessId,
  transactionId,
  previous,
  targetAccount,
  actor,
  source,
  reason,
  now,
}) {
  const payload = {
    status: previous?.status || "approved",
    final_qbo_account_id: targetAccount.id,
    final_qbo_account_name: targetAccount.name,
    reason,
    decided_by: previous?.decided_by || actor || null,
    decided_at: previous?.decided_at || now,
    post_after: previous?.post_after || null,
    post_error: null,
    updated_at: now,
    meta: buildDecisionMeta(previous?.meta, {
      actor,
      source,
      reason,
      previous,
      targetAccount,
      now,
      qboUpdated: false,
    }),
  };
  const { data, error } = await db
    .from("transaction_categorizations")
    .update(payload)
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .is("qbo_txn_id", null)
    .select("*")
    .single();
  if (error) throw new BookkeepingReclassificationError("handled_reclassification_failed", 500, { message: error.message });
  return data;
}

async function resolveOperatorResponsesAfterApproval({
  db,
  businessId,
  transactionId,
  actor,
  targetAccount,
  now,
  source,
}) {
  if (source !== "monthly_review") return { ok: true, skipped: true, reason: "source_not_monthly_review" };
  const { data: rows, error: fetchErr } = await db
    .from("clarification_requests")
    .select("id")
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("status", "answered")
    .is("resolved_at", null);
  if (fetchErr) throw new BookkeepingReclassificationError("operator_response_fetch_failed", 500, { message: fetchErr.message });
  const requestIds = (rows || []).map((row) => row.id).filter(Boolean);
  if (!requestIds.length) return { ok: true, resolved: 0 };

  const { error: updateErr } = await db
    .from("clarification_requests")
    .update({
      resolved_at: now,
      resolved_by_user_id: actor || null,
      resolved_reason: "monthly_review_reclassified",
      resolved_transaction_status: "approved",
      resolved_final_qbo_account_id: targetAccount.id,
      resolved_final_qbo_account_name: targetAccount.name,
      updated_at: now,
    })
    .eq("business_id", businessId)
    .in("id", requestIds);
  if (updateErr) throw new BookkeepingReclassificationError("operator_response_resolve_failed", 500, { message: updateErr.message });

  await refreshOperatorRequestSummaryBestEffort({
    businessId,
    db,
    reason: "monthly_review_reclassification_resolved_operator_response",
  });

  return { ok: true, resolved: requestIds.length, request_ids: requestIds };
}

async function updateCategorizationAfterPostedReclassification({
  db,
  businessId,
  transactionId,
  previous,
  targetAccount,
  actor,
  source,
  reason,
  now,
  qboUpdate,
}) {
  const payload = {
    status: "posted",
    final_qbo_account_id: targetAccount.id,
    final_qbo_account_name: targetAccount.name,
    reason,
    post_error: null,
    updated_at: now,
    meta: buildDecisionMeta(previous?.meta, {
      actor,
      source,
      reason,
      previous,
      targetAccount,
      now,
      qboUpdated: true,
      qboUpdate,
    }),
  };
  const { data, error } = await db
    .from("transaction_categorizations")
    .update(payload)
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("qbo_txn_id", previous.qbo_txn_id)
    .select("*")
    .single();
  if (error) throw new BookkeepingReclassificationError("posted_reclassification_persist_failed", 500, { message: error.message });
  return data;
}

function buildDecisionMeta(previousMeta = {}, { actor, source, reason, previous, targetAccount, now, qboUpdated, qboUpdate = null }) {
  return {
    ...(previousMeta || {}),
    bookkeeping_reclassification: {
      source,
      actor,
      decided_at: now,
      reason,
      old_qbo_account_id: previous?.final_qbo_account_id || previous?.suggested_qbo_account_id || null,
      old_qbo_account_name: previous?.final_qbo_account_name || previous?.suggested_qbo_account_name || null,
      new_qbo_account_id: targetAccount.id,
      new_qbo_account_name: targetAccount.name,
      qbo_updated: qboUpdated === true,
      qbo_txn_id: previous?.qbo_txn_id || null,
      qbo_txn_type: previous?.qbo_txn_type || null,
    },
    monthly_review_adjusted: source === "monthly_review" ? true : previousMeta?.monthly_review_adjusted,
    monthly_review_adjusted_at: source === "monthly_review" ? now : previousMeta?.monthly_review_adjusted_at,
    monthly_review_qbo_update: qboUpdate || previousMeta?.monthly_review_qbo_update || null,
  };
}

function normalizeQboTxnType(value = "") {
  const normalized = String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
  if (normalized === "purchase") return "Purchase";
  if (normalized === "deposit") return "Deposit";
  if (normalized === "creditcardcharge" || normalized === "creditcardexpense") return "CreditCardCharge";
  if (normalized === "creditcardpayment") return "CreditCardPayment";
  if (normalized === "transfer") return "Transfer";
  return value ? String(value) : "";
}

async function fetchQboTransaction(qbo, txnType, txnId) {
  const directMethod = `get${txnType}`;
  const candidates = [
    typeof qbo?.[directMethod] === "function" ? qbo[directMethod].bind(qbo) : null,
    nestedQboMethod(qbo, txnType, "get"),
    nestedQboMethod(qbo, txnType, "findById"),
  ].filter(Boolean);
  if (!candidates.length) throw new BookkeepingReclassificationError(`qbo_get_not_supported_${txnType}`, 409);
  let lastError = null;
  for (const fn of candidates) {
    try {
      return await new Promise((resolve, reject) => {
        fn(txnId, (err, resp) => {
          if (err) return reject(err);
          resolve(unwrapQboTransactionResponse(resp, txnType));
        });
      });
    } catch (e) {
      lastError = e;
    }
  }
  throw new BookkeepingReclassificationError(`qbo_get_failed_${txnType}`, 502, { message: lastError?.message || String(lastError || "") });
}

async function updateQboTransaction(qbo, txnType, payload) {
  const directMethod = `update${txnType}`;
  const candidates = [
    typeof qbo?.[directMethod] === "function" ? qbo[directMethod].bind(qbo) : null,
    nestedQboMethod(qbo, txnType, "update"),
  ].filter(Boolean);
  if (!candidates.length) throw new BookkeepingReclassificationError(`qbo_update_not_supported_${txnType}`, 409);
  let lastError = null;
  for (const fn of candidates) {
    try {
      return await new Promise((resolve, reject) => {
        fn(payload, (err, resp) => {
          if (err) return reject(err);
          resolve(resp);
        });
      });
    } catch (e) {
      lastError = e;
    }
  }
  throw new BookkeepingReclassificationError(`qbo_update_failed_${txnType}`, 502, { message: lastError?.message || String(lastError || "") });
}

function nestedQboMethod(qbo, txnType, method) {
  const keys = {
    Purchase: ["purchase"],
    Deposit: ["deposit"],
    CreditCardCharge: ["creditcardcharge", "creditCardCharge"],
  }[txnType] || [];
  for (const key of keys) {
    if (typeof qbo?.[key]?.[method] === "function") return qbo[key][method].bind(qbo[key]);
  }
  return null;
}

function unwrapQboTransactionResponse(resp, txnType) {
  if (!resp || typeof resp !== "object") return resp;
  return resp[txnType] || resp[txnType.charAt(0).toLowerCase() + txnType.slice(1)] || resp;
}

function rewriteQboTransactionAccount(baseTxn, txnType, accountId, accountName) {
  const accountRef = { value: String(accountId), ...(accountName ? { name: accountName } : {}) };
  let changed = false;
  const payload = {
    ...baseTxn,
    Sparse: true,
    Id: baseTxn.Id || baseTxn.id,
    SyncToken: baseTxn.SyncToken,
  };

  if (Array.isArray(payload.Line)) {
    payload.Line = payload.Line.map((line) => {
      if (txnType === "Deposit" && line.DepositLineDetail) {
        changed = true;
        return {
          ...line,
          DepositLineDetail: {
            ...line.DepositLineDetail,
            AccountRef: accountRef,
          },
        };
      }
      if (line.AccountBasedExpenseLineDetail) {
        changed = true;
        return {
          ...line,
          AccountBasedExpenseLineDetail: {
            ...line.AccountBasedExpenseLineDetail,
            AccountRef: accountRef,
          },
        };
      }
      return line;
    });
  }

  if (!changed) throw new BookkeepingReclassificationError(`qbo_transaction_has_no_editable_account_line_${txnType}`, 409);
  return payload;
}
