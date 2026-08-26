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
import { isProtectedCreditCardPaymentWorkflow } from "./protectedWorkflow.js";

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

const PURCHASE_RECLASS_ACCOUNT_TYPES = new Set([
  "expense",
  "costofgoodssold",
  "otherexpense",
]);

const DEPOSIT_RECLASS_ACCOUNT_TYPES = new Set([
  "income",
  "revenue",
  "otherincome",
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
    assertTargetAccountCompatibleWithPostedTxn(previous?.qbo_txn_type, targetAccount);
    const qboUpdate = await updatePostedQboTransactionAccount({
      businessId,
      qboTxnId: previous.qbo_txn_id,
      qboTxnType: previous.qbo_txn_type,
      accountId: targetAccount.id,
      accountName: targetAccount.name,
      accountType: targetAccount.type,
      accountSubType: targetAccount.subType,
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
  accountType = null,
  accountSubType = null,
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

  const updatedTxn = buildQboTransactionAccountUpdatePayload(baseTxn, txnType, accountId, accountName);
  const providerResponse = await updateQboTransaction(qbo, txnType, updatedTxn, {
    txnType,
    qboTxnId,
    baseTxn,
    targetAccount: {
      id: accountId,
      type: accountType,
      subType: accountSubType,
    },
  });

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

function assertTargetAccountCompatibleWithPostedTxn(qboTxnType, targetAccount = {}) {
  const txnType = normalizeQboTxnType(qboTxnType);
  if (!txnType) throw new BookkeepingReclassificationError("missing_qbo_txn_type", 409);
  const accountTypeKey = normalizeAccountTypeKey(targetAccount.type || targetAccount.accountType || targetAccount.account_type);
  const details = {
    qbo_txn_type: txnType,
    account_id: targetAccount.id || null,
    account_type: targetAccount.type || targetAccount.accountType || targetAccount.account_type || null,
  };

  if (txnType === "Purchase") {
    if (!PURCHASE_RECLASS_ACCOUNT_TYPES.has(accountTypeKey)) {
      throw new BookkeepingReclassificationError("target_account_not_valid_for_purchase_reclassification", 400, details);
    }
    return true;
  }
  if (txnType === "CreditCardCharge") {
    if (!PURCHASE_RECLASS_ACCOUNT_TYPES.has(accountTypeKey)) {
      throw new BookkeepingReclassificationError("target_account_not_valid_for_credit_card_charge_reclassification", 400, details);
    }
    return true;
  }
  if (txnType === "Deposit") {
    if (!DEPOSIT_RECLASS_ACCOUNT_TYPES.has(accountTypeKey)) {
      throw new BookkeepingReclassificationError("target_account_not_valid_for_deposit_reclassification", 400, details);
    }
    return true;
  }
  return true;
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
  if (isProtectedCreditCardPaymentWorkflow({ ...(categorization || {}), meta })) {
    throw new BookkeepingReclassificationError("cc_payment_generic_reclassification_not_supported", 409, {
      transaction_id: bankTxn.id,
      cc_payment_pair_id: meta.cc_payment_pair_id || null,
    });
  }
  if (taxonomyType && taxonomyType !== "cc_payment" && GENERIC_RECLASS_BLOCKED_TAXONOMIES.has(taxonomyType)) {
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

function normalizeAccountTypeKey(value = "") {
  return String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
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

async function updateQboTransaction(qbo, txnType, payload, context = {}) {
  const directMethod = `update${txnType}`;
  const candidates = [
    typeof qbo?.[directMethod] === "function" ? qbo[directMethod].bind(qbo) : null,
    nestedQboMethod(qbo, txnType, "update"),
  ].filter(Boolean);
  if (!candidates.length) throw new BookkeepingReclassificationError(`qbo_update_not_supported_${txnType}`, 409);
  console.info("[bookkeeping-reclassification] qbo transaction update payload shape", describeQboUpdatePayloadShape({
    operation: directMethod,
    txnType,
    qboTxnId: context.qboTxnId,
    payload,
  }));
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
  const providerError = sanitizeQboProviderError(lastError, {
    operation: directMethod,
    qboTxnType: txnType,
    qboTxnId: context.qboTxnId,
  });
  const updateDiagnostic = buildQboUpdateDiagnostic({
    operation: directMethod,
    txnType,
    qboTxnId: context.qboTxnId,
    baseTxn: context.baseTxn,
    targetAccount: context.targetAccount,
  });
  console.error("[bookkeeping-reclassification] qbo transaction update failed", {
    ...updateDiagnostic,
    provider_error: providerError,
  });
  throw new BookkeepingReclassificationError(`qbo_update_failed_${txnType}`, 502, {
    message: providerError.message || lastError?.message || String(lastError || ""),
    diagnostic_code: classifyQboProviderError(providerError),
    qbo_provider_error: providerError,
    qbo_update_diagnostic: updateDiagnostic,
  });
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

function buildQboTransactionAccountUpdatePayload(baseTxn, txnType, accountId, accountName) {
  const accountRef = { value: String(accountId), ...(accountName ? { name: accountName } : {}) };
  if (txnType === "Deposit") return buildDepositUpdatePayload(baseTxn, accountRef);
  if (txnType === "Purchase" || txnType === "CreditCardCharge") {
    return buildAccountBasedExpenseUpdatePayload(baseTxn, txnType, accountRef);
  }
  throw new BookkeepingReclassificationError(`unsupported_qbo_txn_type_${txnType}`, 409);
}

function buildAccountBasedExpenseUpdatePayload(baseTxn, txnType, accountRef) {
  const payload = pickDefined({
    Id: baseTxn.Id || baseTxn.id,
    SyncToken: baseTxn.SyncToken,
    sparse: true,
    PaymentType: baseTxn.PaymentType,
    AccountRef: cloneRef(baseTxn.AccountRef),
    EntityRef: cloneRef(baseTxn.EntityRef),
    TxnDate: baseTxn.TxnDate,
    DocNumber: baseTxn.DocNumber,
    PrivateNote: baseTxn.PrivateNote,
    CurrencyRef: cloneRef(baseTxn.CurrencyRef),
    ExchangeRate: baseTxn.ExchangeRate,
    Line: buildUpdatedLines(baseTxn.Line, "AccountBasedExpenseLineDetail", accountRef),
  });
  if (!payload.Id) throw new BookkeepingReclassificationError("qbo_transaction_not_found", 404);
  if (!payload.SyncToken) throw new BookkeepingReclassificationError("qbo_transaction_missing_sync_token", 409);
  if (!payload.Line?.length) throw new BookkeepingReclassificationError(`qbo_transaction_has_no_editable_account_line_${txnType}`, 409);
  return payload;
}

function buildDepositUpdatePayload(baseTxn, accountRef) {
  const payload = pickDefined({
    Id: baseTxn.Id || baseTxn.id,
    SyncToken: baseTxn.SyncToken,
    sparse: true,
    TxnDate: baseTxn.TxnDate,
    DocNumber: baseTxn.DocNumber,
    PrivateNote: baseTxn.PrivateNote,
    CurrencyRef: cloneRef(baseTxn.CurrencyRef),
    ExchangeRate: baseTxn.ExchangeRate,
    DepositToAccountRef: cloneRef(baseTxn.DepositToAccountRef),
    CashBack: cloneDepositCashBack(baseTxn.CashBack),
    Line: buildUpdatedLines(baseTxn.Line, "DepositLineDetail", accountRef),
  });
  if (!payload.Id) throw new BookkeepingReclassificationError("qbo_transaction_not_found", 404);
  if (!payload.SyncToken) throw new BookkeepingReclassificationError("qbo_transaction_missing_sync_token", 409);
  if (!payload.Line?.length) throw new BookkeepingReclassificationError("qbo_transaction_has_no_editable_account_line_Deposit", 409);
  return payload;
}

function buildUpdatedLines(lines, editableDetailKey, accountRef) {
  let changed = false;
  const updated = (Array.isArray(lines) ? lines : []).map((line) => {
    if (!line?.[editableDetailKey]) return cloneSupportedPassthroughLine(line);
    changed = true;
    return buildSupportedLine(line, {
      [editableDetailKey]: buildSupportedLineDetail(line[editableDetailKey], editableDetailKey, accountRef),
    });
  }).filter(Boolean);
  return changed ? updated : [];
}

function cloneSupportedPassthroughLine(line = {}) {
  const detailKey = lineDetailType(line);
  if (!detailKey || !line?.[detailKey]) return buildSupportedLine(line);
  return buildSupportedLine(line, {
    [detailKey]: buildSupportedLineDetail(line[detailKey], detailKey),
  });
}

function buildSupportedLine(line = {}, detailOverride = {}) {
  return pickDefined({
    Id: line.Id,
    LineNum: line.LineNum,
    Description: line.Description,
    Amount: line.Amount,
    DetailType: line.DetailType || Object.keys(detailOverride)[0] || lineDetailType(line),
    ...detailOverride,
  });
}

function buildSupportedLineDetail(detail = {}, detailKey, replacementAccountRef = null) {
  if (detailKey === "AccountBasedExpenseLineDetail") {
    return pickDefined({
      AccountRef: replacementAccountRef || cloneRef(detail.AccountRef),
      CustomerRef: cloneRef(detail.CustomerRef),
      ClassRef: cloneRef(detail.ClassRef),
      BillableStatus: detail.BillableStatus,
      TaxCodeRef: cloneRef(detail.TaxCodeRef),
      TaxAmount: detail.TaxAmount,
      MarkupInfo: cloneMarkupInfo(detail.MarkupInfo),
    });
  }
  if (detailKey === "DepositLineDetail") {
    return pickDefined({
      AccountRef: replacementAccountRef || cloneRef(detail.AccountRef),
      PaymentMethodRef: cloneRef(detail.PaymentMethodRef),
      ClassRef: cloneRef(detail.ClassRef),
      CheckNum: detail.CheckNum,
      TaxCodeRef: cloneRef(detail.TaxCodeRef),
      TaxAmount: detail.TaxAmount,
      Entity: cloneDepositEntity(detail.Entity),
    });
  }
  return pickDefined({
    AccountRef: replacementAccountRef || cloneRef(detail.AccountRef),
  });
}

function cloneRef(ref) {
  if (!ref || typeof ref !== "object") return undefined;
  return pickDefined({
    value: ref.value,
    name: ref.name,
    type: ref.type,
  });
}

function cloneMarkupInfo(markup) {
  if (!markup || typeof markup !== "object") return undefined;
  return pickDefined({
    PriceLevelRef: cloneRef(markup.PriceLevelRef),
    Percent: markup.Percent,
    MarkUpIncomeAccountRef: cloneRef(markup.MarkUpIncomeAccountRef),
  });
}

function cloneDepositEntity(entity) {
  if (!entity || typeof entity !== "object") return undefined;
  return pickDefined({
    Type: entity.Type,
    EntityRef: cloneRef(entity.EntityRef),
  });
}

function cloneDepositCashBack(cashBack) {
  if (!cashBack || typeof cashBack !== "object") return undefined;
  return pickDefined({
    Amount: cashBack.Amount,
    AccountRef: cloneRef(cashBack.AccountRef),
    Memo: cashBack.Memo,
  });
}

function pickDefined(obj = {}) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null));
}

function describeQboUpdatePayloadShape({ operation, txnType, qboTxnId, payload = {} } = {}) {
  return {
    operation: operation || `update${txnType || ""}`,
    qbo_txn_type: txnType || null,
    qbo_txn_id: qboTxnId ? String(qboTxnId) : null,
    top_level_keys: Object.keys(payload || {}).sort(),
    line_shapes: (Array.isArray(payload?.Line) ? payload.Line : []).map((line) => ({
      keys: Object.keys(line || {}).sort(),
      detail_type: lineDetailType(line),
      account_based_expense_detail_keys: Object.keys(line?.AccountBasedExpenseLineDetail || {}).sort(),
      deposit_line_detail_keys: Object.keys(line?.DepositLineDetail || {}).sort(),
    })),
  };
}

function buildQboUpdateDiagnostic({ operation, txnType, qboTxnId, baseTxn = {}, targetAccount = {} } = {}) {
  const lines = Array.isArray(baseTxn?.Line) ? baseTxn.Line : [];
  return {
    operation: operation || `update${txnType || ""}`,
    qbo_txn_type: txnType || null,
    qbo_txn_id: qboTxnId ? String(qboTxnId) : null,
    sync_token_present: Boolean(baseTxn?.SyncToken),
    fetched_payment_type: baseTxn?.PaymentType || null,
    fetched_payment_account_ref_present: Boolean(baseTxn?.AccountRef?.value || baseTxn?.CreditCardPayment?.CCAccountRef?.value),
    line_count: lines.length,
    line_detail_types: [...new Set(lines.map(lineDetailType).filter(Boolean))],
    target_qbo_account_id: targetAccount?.id ? String(targetAccount.id) : null,
    target_qbo_account_type: targetAccount?.type || null,
    target_qbo_account_subtype: targetAccount?.subType || targetAccount?.subtype || null,
  };
}

function lineDetailType(line = {}) {
  if (line.DetailType) return String(line.DetailType);
  if (line.AccountBasedExpenseLineDetail) return "AccountBasedExpenseLineDetail";
  if (line.DepositLineDetail) return "DepositLineDetail";
  if (line.SalesItemLineDetail) return "SalesItemLineDetail";
  if (line.ItemBasedExpenseLineDetail) return "ItemBasedExpenseLineDetail";
  if (line.JournalEntryLineDetail) return "JournalEntryLineDetail";
  return null;
}

function sanitizeQboProviderError(error, { operation, qboTxnType, qboTxnId } = {}) {
  const source = parseErrorBody(error);
  const fault = source?.Fault || source?.fault || error?.Fault || error?.fault || null;
  const faultError = Array.isArray(fault?.Error) ? fault.Error[0] : Array.isArray(fault?.error) ? fault.error[0] : null;
  return {
    operation: operation || null,
    qbo_txn_type: qboTxnType || null,
    qbo_txn_id: qboTxnId ? String(qboTxnId) : null,
    http_status: firstPresent(error?.statusCode, error?.status, error?.response?.statusCode, error?.response?.status),
    intuit_fault_type: safeText(fault?.type || fault?.Type || source?.type || error?.type),
    intuit_error_code: safeText(faultError?.code || faultError?.Code || error?.code),
    message: safeText(faultError?.Message || faultError?.message || source?.Message || source?.message || error?.message),
    detail: safeText(faultError?.Detail || faultError?.detail || source?.Detail || source?.detail),
    field_path: safeText(faultError?.element || faultError?.Element || faultError?.field || faultError?.Field || source?.element || source?.field),
  };
}

function parseErrorBody(error) {
  const candidates = [
    error?.response?.body,
    error?.response?.data,
    error?.body,
    error?.data,
    error?.intuit_tid ? null : error?.message,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === "object") return candidate;
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        return JSON.parse(trimmed);
      } catch {
        // Ignore non-JSON provider messages.
      }
    }
  }
  return null;
}

function classifyQboProviderError(providerError = {}) {
  const combined = `${providerError.intuit_error_code || ""} ${providerError.message || ""} ${providerError.detail || ""}`.toLowerCase();
  if (/sync\s*token|stale|object\s*not\s*current|another\s*user/.test(combined)) return "qbo_stale_object";
  if (/accountref|account\s*ref|invalid\s*account|account.*inactive|invalid.*reference/.test(combined)) return "qbo_invalid_account_reference";
  if (/line|accountbasedexpenselinedetail|depositlinedetail|unsupported/.test(combined)) return "qbo_unsupported_line_mutation";
  if (/required|missing|required param/.test(combined)) return "qbo_missing_required_field";
  if (/validation|business/.test(combined)) return "qbo_business_validation_error";
  if (/malformed|parse|invalid.*purchase|invalid.*object/.test(combined)) return "qbo_malformed_update_payload";
  return "qbo_provider_update_failed";
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

function safeText(value, maxLength = 500) {
  if (value === undefined || value === null) return null;
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(access_token|refresh_token|authorization|client_secret)["'=:\s]+[^"',\s}]+/gi, "$1=[redacted]")
    .slice(0, maxLength);
}
