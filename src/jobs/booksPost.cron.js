import crypto from "crypto";
import { supabase } from "../services/supabaseAdmin.js";
import { getQBOClient } from "../utils/qboClient.js";
import { log } from "../utils/reviews/logger.js";
import { isCheck } from "../services/bookkeeping/checkDetector.js";
import { getQboAccountForPlaidAccount } from "../services/bookkeeping/accountMapping.js";
import { resolvePayee } from "../services/bookkeeping/payeeResolver.js";
import { ensureQboVendorForTransaction } from "../services/bookkeeping/qboVendorCreationService.js";

const POLL_MINUTES = Number(process.env.BOOKS_POST_CRON_MINUTES || 10);
const MAX_RETRIES = Number(process.env.BOOKS_POST_MAX_RETRIES || 5);
const BACKOFF_SCHEDULE_MS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPostIdempotencyKey({ businessId, transactionId, plaidTransactionId, finalAccountId, amount, date }) {
  const stableTxn = plaidTransactionId || transactionId || "";
  const input = `${businessId || ""}|${stableTxn}|${finalAccountId || ""}|${amount || ""}|${date || ""}`;
  return crypto.createHash("sha256").update(input).digest("hex");
}

function appendMarker(desc, marker) {
  if (!marker) return desc;
  const base = desc || "";
  if (base.includes(marker)) return base;
  if (!base) return marker;
  return `${base} | ${marker}`;
}

function computeBackoffMs(nextRetries) {
  if (!Number.isFinite(nextRetries) || nextRetries <= 0) return BACKOFF_SCHEDULE_MS[0];
  if (nextRetries - 1 >= BACKOFF_SCHEDULE_MS.length) return BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1];
  return BACKOFF_SCHEDULE_MS[nextRetries - 1];
}

function getNowIso() {
  return new Date().toISOString();
}

function isOutflowLike(bankTxn = {}) {
  const dir = (bankTxn.direction || "").toUpperCase();
  if (dir === "OUTFLOW") return true;
  if (dir === "INFLOW") return false;
  const signed = Number(bankTxn.signed_amount);
  if (Number.isFinite(signed)) return signed < 0;
  const amt = Number(bankTxn.amount);
  if (Number.isFinite(amt)) return amt < 0;
  return false;
}

function isInflowLike(bankTxn = {}) {
  const dir = (bankTxn.direction || "").toUpperCase();
  if (dir === "INFLOW") return true;
  if (dir === "OUTFLOW") return false;
  const signed = Number(bankTxn.signed_amount);
  if (Number.isFinite(signed)) return signed > 0;
  const amt = Number(bankTxn.amount);
  if (Number.isFinite(amt)) return amt > 0;
  return false;
}

function getQboEntityRef(bankTxn = {}, desiredType = "vendor") {
  if (!bankTxn.qbo_entity_id || !bankTxn.qbo_entity_type) return null;
  const t = (bankTxn.qbo_entity_type || "").toLowerCase();
  if (desiredType === "vendor" && t !== "vendor") return null;
  if (desiredType === "customer" && t !== "customer") return null;
  const typeLabel = desiredType === "vendor" ? "Vendor" : "Customer";
  return { value: String(bankTxn.qbo_entity_id), type: typeLabel };
}

async function fetchPending() {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("transaction_categorizations")
    .select(
      "transaction_id,business_id,status,final_qbo_account_id,final_qbo_account_name,post_after,post_error,meta,qbo_txn_id"
    )
    .in("status", ["approved", "auto_approved", "failed"])
    .not("post_after", "is", null)
    .lte("post_after", nowIso)
    .is("qbo_txn_id", null);

  if (error) throw error;
  return data || [];
}

async function fetchBankTransactions(ids = [], businessId) {
  if (!ids.length) return {};
  const { data, error } = await supabase
    .from("bank_transactions")
    .select(
      "id,amount,direction,date,name,merchant_name,counterparty_name,plaid_account_id,plaid_transaction_id,transaction_type,check_number,qbo_entity_type,qbo_entity_id,signed_amount"
    )
    .eq("business_id", businessId)
    .in("id", ids);
  if (error) throw error;
  const map = {};
  (data || []).forEach((row) => {
    map[row.id] = row;
  });
  return map;
}

async function postCcPaymentToQbo(item, bankTxn, qbo, mapping) {
  if (!qbo) throw new Error("qbo_client_unavailable");
  if (!bankTxn) throw new Error("missing_bank_transaction");
  const bankId = mapping?.qbo_account_id || item?.meta?.cc_payment_bank_qbo_account_id;
  const ccId = item?.meta?.cc_payment_cc_qbo_account_id;
  if (!bankId || !ccId) throw new Error("cc_payment_mapping_not_safe");
  const amount = Math.abs(Number(bankTxn.amount || 0));
  if (!Number.isFinite(amount) || amount === 0) throw new Error("invalid_amount");
  const txnDate = bankTxn.date || new Date().toISOString().slice(0, 10);
  const desc = bankTxn.name || bankTxn.counterparty_name || bankTxn.merchant_name || "CC payment";
  const marker = bankTxn.plaid_transaction_id ? `Bizzi:${bankTxn.plaid_transaction_id}` : null;
  const note = appendMarker(desc, marker);

  const payload = {
    BankAccountRef: { value: String(bankId) },
    CreditCardAccountRef: { value: String(ccId) },
    Amount: amount,
    TxnDate: txnDate,
    PrivateNote: note,
  };

  const candidates = [
    qbo?.creditcardpayment?.create,
    qbo?.creditCardPayment?.create,
    qbo?.createCreditCardPayment,
  ].filter(Boolean);
  if (!candidates.length) {
    throw new Error("cc_payment_post_not_supported");
  }
  const fn = candidates[0];
  return new Promise((resolve, reject) => {
    fn.call(qbo, payload, (err, resp) => {
      if (err) return reject(err);
      return resolve({ id: resp?.Id || null, type: resp?.TxnType || "CreditCardPayment" });
    });
  });
}

async function postBankOutflowPurchase(item, bankTxn, qbo, mappedAccountId, categoryAccountId) {
  const amount = Math.abs(Number(bankTxn.amount || 0));
  const txnDate = bankTxn.date || new Date().toISOString().slice(0, 10);
  const desc = bankTxn.name || bankTxn.counterparty_name || bankTxn.merchant_name || "Bank transaction";
  const marker = bankTxn.plaid_transaction_id ? `Bizzi:${bankTxn.plaid_transaction_id}` : null;
  const note = appendMarker(desc, marker);
  const vendorRef = getQboEntityRef(bankTxn, "vendor");
  if (process.env.NODE_ENV !== "production") {
    console.info("[books-post] entity_ref", {
      txnId: item.transaction_id,
      qbo_entity_type: bankTxn.qbo_entity_type,
      qbo_entity_id: bankTxn.qbo_entity_id,
      attached_to: vendorRef ? "purchase" : "none",
    });
  }
  return new Promise((resolve, reject) => {
    qbo.purchase.create(
      {
        PaymentType: "Cash",
        AccountRef: { value: String(mappedAccountId) },
        TxnDate: txnDate,
        PrivateNote: note,
        ...(vendorRef ? { EntityRef: { value: vendorRef.value, type: "Vendor" } } : {}),
        Line: [
          {
            DetailType: "AccountBasedExpenseLineDetail",
            Amount: amount,
            Description: desc,
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: String(categoryAccountId) },
            },
          },
        ],
      },
      (err, resp) => {
        if (err) return reject(err);
        return resolve({ id: resp?.Id || null, type: resp?.TxnType || "Purchase" });
      }
    );
  });
}

async function postBankInflowDeposit(item, bankTxn, qbo, mappedAccountId, categoryAccountId) {
  const amount = Math.abs(Number(bankTxn.amount || 0));
  const txnDate = bankTxn.date || new Date().toISOString().slice(0, 10);
  const desc = bankTxn.name || bankTxn.counterparty_name || bankTxn.merchant_name || "Bank transaction";
  const marker = bankTxn.plaid_transaction_id ? `Bizzi:${bankTxn.plaid_transaction_id}` : null;
  const note = appendMarker(desc, marker);
  const customerRef = getQboEntityRef(bankTxn, "customer");
  if (process.env.NODE_ENV !== "production") {
    console.info("[books-post] entity_ref", {
      txnId: item.transaction_id,
      qbo_entity_type: bankTxn.qbo_entity_type,
      qbo_entity_id: bankTxn.qbo_entity_id,
      attached_to: customerRef ? "deposit" : "none",
    });
  }
  const buildPayload = (variant = "A") => ({
    TxnDate: txnDate,
    PrivateNote: note,
    DepositToAccountRef: { value: String(mappedAccountId) },
    Line: [
      {
        Amount: amount,
        Description: desc,
        DepositLineDetail: {
          AccountRef: { value: String(categoryAccountId) },
          ...(customerRef
            ? variant === "A"
              ? { Entity: { value: customerRef.value, type: "Customer" } }
              : { Entity: { Type: "Customer", EntityRef: { value: customerRef.value } } }
            : {}),
        },
      },
    ],
  });

  const attempt = (payload) =>
    new Promise((resolve, reject) => {
      qbo.deposit.create(payload, (err, resp) => {
        if (err) return reject(err);
        return resolve({ id: resp?.Id || null, type: resp?.TxnType || "Deposit" });
      });
    });

  try {
    return await attempt(buildPayload("A"));
  } catch (err) {
    if (customerRef) {
      try {
        return await attempt(buildPayload("B"));
      } catch {
        throw err;
      }
    }
    throw err;
  }
}

async function postCreditCardOutflowCharge(item, bankTxn, qbo, mappedAccountId, categoryAccountId) {
  const amount = Math.abs(Number(bankTxn.amount || 0));
  const txnDate = bankTxn.date || new Date().toISOString().slice(0, 10);
  const desc = bankTxn.name || bankTxn.counterparty_name || bankTxn.merchant_name || "CC charge";
  const marker = bankTxn.plaid_transaction_id ? `Bizzi:${bankTxn.plaid_transaction_id}` : null;
  const note = appendMarker(desc, marker);
  const vendorRef = getQboEntityRef(bankTxn, "vendor");
  if (process.env.NODE_ENV !== "production") {
    console.info("[books-post] entity_ref", {
      txnId: item.transaction_id,
      qbo_entity_type: bankTxn.qbo_entity_type,
      qbo_entity_id: bankTxn.qbo_entity_id,
      attached_to: vendorRef ? "cc_charge" : "none",
    });
  }
  const payload = {
    AccountRef: { value: String(mappedAccountId) },
    TxnDate: txnDate,
    PrivateNote: note,
    ...(vendorRef
      ? {
          EntityRef: { value: vendorRef.value, type: "Vendor" },
          PayeeEntityRef: { value: vendorRef.value, type: "Vendor" },
        }
      : {}),
    Line: [
      {
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: amount,
        Description: desc,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: String(categoryAccountId) },
        },
      },
    ],
  };
  const candidates = [
    qbo?.creditcardcharge?.create,
    qbo?.creditCardCharge?.create,
    qbo?.createCreditCardCharge,
  ].filter(Boolean);
  if (!candidates.length) {
    throw new Error("cc_charge_post_not_supported");
  }
  const fn = candidates[0];
  return new Promise((resolve, reject) => {
    fn.call(qbo, payload, (err, resp) => {
      if (err) return reject(err);
      return resolve({ id: resp?.Id || null, type: resp?.TxnType || "CreditCardCharge" });
    });
  });
}

async function postToQbo(item, bankTxn, qbo, mapping) {
  if (!qbo) throw new Error("qbo_client_unavailable");
  if (!bankTxn) throw new Error("missing_bank_transaction");
  const mappedAccountId = mapping?.qbo_account_id || null;
  if (!mappedAccountId) throw new Error("missing_qbo_account_mapping");
  const categoryAccountId = item?.final_qbo_account_id || null;
  const mappedType = (mapping?.qbo_account_type || "").toLowerCase();
  const isBank = mappedType === "bank";
  const isCreditCard = mappedType === "creditcard" || mappedType === "credit_card" || mappedType === "credit card";
  const taxonomyType = item?.meta?.taxonomy_type || null;

  const looksCcMeta =
    item?.meta?.taxonomy_type === "cc_payment" ||
    item?.meta?.cc_payment_bank_qbo_account_id ||
    item?.meta?.cc_payment_cc_qbo_account_id ||
    item?.meta?.cc_payment_mapping_confidence;

  if (looksCcMeta) {
    return postCcPaymentToQbo(item, bankTxn, qbo, mapping);
  }
  if (taxonomyType && taxonomyType !== "cc_payment") {
    await supabase
      .from("transaction_categorizations")
      .update({
        status: "needs_review",
        post_after: null,
        post_error: "taxonomy_requires_review",
        last_post_attempt_at: new Date().toISOString(),
        meta: {
          ...(item.meta || {}),
          post_block_reason: "taxonomy_requires_review",
          posting_in_progress: false,
          next_post_attempt_at: null,
          post_retry_count: null,
        },
      })
      .eq("business_id", item.business_id)
      .eq("transaction_id", item.transaction_id);
    return null;
  }
  if (!categoryAccountId) throw new Error("missing_final_account");

  const amount = Number(bankTxn.amount || 0);
  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error("invalid_amount");
  }

  // Direction first, fallback to sign
  const dir = (bankTxn.direction || "").toUpperCase();
  const signed = Number(bankTxn.signed_amount);
  const sign = Number.isFinite(signed) ? signed : amount;
  const isOutflow = dir === "OUTFLOW" ? true : dir === "INFLOW" ? false : sign < 0;

  if (!isBank && !isCreditCard) {
    await supabase
      .from("transaction_categorizations")
      .update({
        status: "needs_review",
        post_after: null,
        post_error: "invalid_qbo_account_mapping_type",
        last_post_attempt_at: new Date().toISOString(),
        meta: {
          ...(item.meta || {}),
          post_block_reason: "invalid_qbo_account_mapping_type",
          posting_in_progress: false,
          next_post_attempt_at: null,
          post_retry_count: null,
        },
      })
      .eq("business_id", item.business_id)
      .eq("transaction_id", item.transaction_id);
    return null;
  }

  if (isCreditCard && !isOutflow) {
    await supabase
      .from("transaction_categorizations")
      .update({
        status: "needs_review",
        post_after: null,
        post_error: "credit_card_inflow_requires_review",
        last_post_attempt_at: new Date().toISOString(),
        meta: {
          ...(item.meta || {}),
          post_block_reason: "credit_card_inflow_requires_review",
          posting_in_progress: false,
          next_post_attempt_at: null,
          post_retry_count: null,
        },
      })
      .eq("business_id", item.business_id)
      .eq("transaction_id", item.transaction_id);
    return null;
  }

  if (isBank && isOutflow) {
    return postBankOutflowPurchase(item, bankTxn, qbo, mappedAccountId, categoryAccountId);
  }
  if (isBank && !isOutflow) {
    return postBankInflowDeposit(item, bankTxn, qbo, mappedAccountId, categoryAccountId);
  }
  if (isCreditCard && isOutflow) {
    return postCreditCardOutflowCharge(item, bankTxn, qbo, mappedAccountId, categoryAccountId);
  }

  throw new Error("invalid_qbo_account_mapping_type");
}

async function handleItem(item) {
  const businessId = item.business_id;
  const txnId = item.transaction_id;

  if (item.status === "posted" || item.qbo_txn_id) {
    return;
  }
  const nextAttempt = item?.meta?.next_post_attempt_at ? Date.parse(item.meta.next_post_attempt_at) : null;
  if (nextAttempt && nextAttempt > Date.now()) {
    return;
  }

  const bankTxns = await fetchBankTransactions([txnId], businessId);
  const bank = bankTxns[txnId] || null;
  if (!bank) {
    throw new Error("missing_bank_transaction");
  }

  const mapping = await getQboAccountForPlaidAccount(businessId, bank?.plaid_account_id);
  if (!mapping) {
    const meta = {
      ...(item.meta || {}),
      post_block_reason: "plaid_account_unmapped",
      next_post_attempt_at: null,
      post_retry_count: null,
    };
    await supabase
      .from("transaction_categorizations")
      .update({
        post_error: "missing_qbo_account_mapping",
        last_post_attempt_at: new Date().toISOString(),
        meta,
      })
      .eq("business_id", businessId)
      .eq("transaction_id", txnId);
    return;
  }

  const idempotencyKey = buildPostIdempotencyKey({
    businessId,
    transactionId: txnId,
    plaidTransactionId: bank?.plaid_transaction_id,
    finalAccountId: item.final_qbo_account_id,
    amount: bank.amount,
    date: bank.date,
  });
  item.meta = { ...(item.meta || {}), post_idempotency_key: idempotencyKey };

  const { data: dupRow, error: dupErr } = await supabase
    .from("transaction_categorizations")
    .select("transaction_id,qbo_txn_id,qbo_txn_type,posted_at")
    .eq("business_id", businessId)
    .not("qbo_txn_id", "is", null)
    .filter("meta->>post_idempotency_key", "eq", idempotencyKey)
    .limit(1)
    .maybeSingle();
  if (dupErr) {
    console.warn("[books-post] idempotency lookup failed", dupErr?.message || dupErr);
  } else if (dupRow?.qbo_txn_id) {
    const postedIso = dupRow.posted_at || new Date().toISOString();
    await supabase
      .from("transaction_categorizations")
      .update({
        status: "posted",
        qbo_txn_id: dupRow.qbo_txn_id,
        qbo_txn_type: dupRow.qbo_txn_type || null,
        posted_at: postedIso,
        reconciled_at: postedIso,
        post_error: null,
        post_after: null,
        last_post_attempt_at: postedIso,
        meta: {
          ...(item.meta || {}),
          posting_in_progress: false,
          post_duplicate_prevented: true,
        },
      })
      .eq("business_id", businessId)
      .eq("transaction_id", txnId);
    if (process.env.NODE_ENV !== "production") {
      log.info("[books-post] duplicate prevented via idempotency key", { txnId, qbo_txn_id: dupRow.qbo_txn_id });
    }
    return;
  }

  const nowIso = new Date().toISOString();
  // NOTE: acquire_posting_lock is a Postgres FUNCTION (Supabase RPC), not a table.
  const { data: locked, error: lockErr } = await supabase.rpc("acquire_posting_lock", {
    p_business_id: businessId,
    p_transaction_id: txnId,
    p_now_iso: nowIso,
    p_lock_stale_seconds: 600,
    p_idempotency_key: idempotencyKey,
  });
  if (lockErr) {
    console.error("[books-post] acquire_posting_lock rpc failed", lockErr?.message || lockErr);
    throw new Error("acquire_posting_lock_rpc_failed");
  }
  if (locked !== true) return;

  const { data: metaRow, error: metaErr } = await supabase
    .from("transaction_categorizations")
    .select("meta")
    .eq("business_id", businessId)
    .eq("transaction_id", txnId)
    .maybeSingle();
  if (metaErr) {
    console.warn("[books-post] failed to refresh meta after lock", metaErr?.message || metaErr);
  } else if (metaRow?.meta) {
    item.meta = { ...metaRow.meta, post_idempotency_key: idempotencyKey };
  }

  await supabase
    .from("transaction_categorizations")
    .update({
      meta: { ...(item.meta || {}), post_idempotency_key: idempotencyKey, posting_in_progress: true },
      last_post_attempt_at: nowIso,
    })
    .eq("business_id", businessId)
    .eq("transaction_id", txnId);
  item.meta = { ...(item.meta || {}), post_idempotency_key: idempotencyKey, posting_in_progress: true };

  // Best-effort vendor resolution/creation after lock and fresh meta
  try {
    const payeeResolution = await resolvePayee({ businessId, txn: bank });
    const vendorEnsure = await ensureQboVendorForTransaction({
      businessId,
      bankTxn: bank,
      payeeResolution,
      taxonomyMeta: { taxonomy_type: item?.meta?.taxonomy_type || null },
      source: "posting",
      createdBy: "bizzi",
    });
    if (vendorEnsure?.qbo_entity_id) {
      bank.qbo_entity_type = vendorEnsure.qbo_entity_type || bank.qbo_entity_type;
      bank.qbo_entity_id = vendorEnsure.qbo_entity_id || bank.qbo_entity_id;
    }
  } catch (err) {
    log.warn("[booksPost] vendor ensure failed", { businessId, txnId, msg: err?.message });
  }

  let qbo = null;
  try {
    qbo = await getQBOClient(businessId);
  } catch (err) {
    const e = new Error("qbo_client_unavailable");
    e.meta = err;
    throw e;
  }

  const result = await postToQbo(item, bank, qbo, mapping);
  if (!result) {
    await supabase
      .from("transaction_categorizations")
      .update({
        meta: { ...(item.meta || {}), posting_in_progress: false },
      })
      .eq("business_id", businessId)
      .eq("transaction_id", txnId);
    return;
  }
  const { id: qboId, type: qboType } = result;

  const postedIso = new Date().toISOString();
  const { error } = await supabase
    .from("transaction_categorizations")
    .update({
      status: "posted",
      qbo_txn_id: qboId || null,
      qbo_txn_type: qboType || null,
      posted_at: postedIso,
      reconciled_at: postedIso,
      post_error: null,
      last_post_attempt_at: postedIso,
      meta: {
        ...(item.meta || {}),
        posting_in_progress: false,
        post_retry_count: null,
        next_post_attempt_at: null,
      },
    })
    .eq("business_id", businessId)
    .eq("transaction_id", txnId);
  if (error) throw error;
}

async function markFailed(item, message) {
  const retries = Number(item?.meta?.post_retry_count || 0);
  const nextRetries = retries + 1;
  const nowIso = getNowIso();
  const backoffMs = computeBackoffMs(nextRetries);
  const nextAttemptIso = nowIso ? new Date(Date.parse(nowIso) + backoffMs).toISOString() : null;
  const meta = {
    ...(item.meta || {}),
    post_retry_count: nextRetries,
    posting_in_progress: false,
    next_post_attempt_at: nextAttemptIso,
  };
  if (message === "cc_payment_post_not_supported") {
    meta.post_block_reason = "cc_payment_post_not_supported";
  }
  if (message === "cc_payment_mapping_not_safe") {
    meta.post_block_reason = "cc_payment_mapping_not_safe";
  }
  if (message === "cc_charge_post_not_supported") {
    meta.post_block_reason = "cc_charge_post_not_supported";
  }
  const shouldStop =
    nextRetries >= MAX_RETRIES ||
    message === "cc_payment_post_not_supported" ||
    message === "cc_payment_mapping_not_safe" ||
    message === "cc_charge_post_not_supported";
  if (shouldStop) {
    meta.next_post_attempt_at = null;
  }
  await supabase
    .from("transaction_categorizations")
    .update({
      status: shouldStop ? "failed" : item.status,
      post_error: message || "post_failed",
      last_post_attempt_at: nowIso,
      post_after:
        message === "cc_payment_post_not_supported" || message === "cc_payment_mapping_not_safe"
          ? null
          : shouldStop
          ? null
          : item.post_after,
      meta,
    })
    .eq("business_id", item.business_id)
    .eq("transaction_id", item.transaction_id);
}

async function runOnce() {
  try {
    const pending = await fetchPending();
    if (!pending.length) return;

    const nowTs = Date.now();
    const duePending = (pending || []).filter((item) => {
      const next = item?.meta?.next_post_attempt_at ? Date.parse(item.meta.next_post_attempt_at) : null;
      if (next && next > nowTs) return false;
      return true;
    });
    if (!duePending.length) return;

    const byBusiness = duePending.reduce((acc, item) => {
      const key = item.business_id;
      if (!key) return acc;
      if (!acc[key]) acc[key] = new Set();
      acc[key].add(item.transaction_id);
      return acc;
    }, {});
    const bankCache = {};
    for (const [biz, idsSet] of Object.entries(byBusiness)) {
      const ids = Array.from(idsSet);
      bankCache[biz] = await fetchBankTransactions(ids, biz);
    }

    const nowIso = new Date().toISOString();
    const checkUpdates = [];
    const eligible = (duePending || []).filter((item) => {
      const bankTxn = (bankCache[item.business_id] || {})[item.transaction_id];
      const checkHit =
        item?.meta?.is_check === true
          ? {
              is_check: true,
              confidence: item?.meta?.check_confidence || null,
              reason: item?.meta?.check_reason || null,
              check_number: item?.meta?.check_number || null,
            }
          : isCheck(bankTxn || {});
      if (item?.meta?.is_check === true || checkHit.is_check) {
        const approvedAndFinal = item.status === "approved" && item.final_qbo_account_id;
        if (!approvedAndFinal) {
          if (process.env.NODE_ENV !== "production") {
            log.info("[books-post] blocking check txn pending manual approval", item.transaction_id);
          }
          const existingMeta = item.meta || {};
          const checkMeta = {
            is_check: true,
            check_confidence: checkHit.confidence,
            check_reason: checkHit.reason,
            ...(checkHit.check_number ? { check_number: checkHit.check_number } : {}),
            taxonomy_flags: { ...(existingMeta.taxonomy_flags || {}), is_check: true },
          };
          checkUpdates.push({
            business_id: item.business_id,
            transaction_id: item.transaction_id,
            status: "needs_review",
            post_after: null,
            post_error: "blocked_check_requires_manual_approval",
            last_post_attempt_at: nowIso,
            meta: { ...existingMeta, ...checkMeta },
          });
          return false;
        }
        return true;
      }
      if (item?.meta?.taxonomy_type === "transfer_internal") {
        if (process.env.NODE_ENV !== "production") {
          log.info("[books-post] skipping transfer taxonomy txn", item.transaction_id);
        }
        return false;
      }
      if (item?.meta?.taxonomy_type === "owner_draw" || item?.meta?.taxonomy_type === "owner_contribution") {
        if (process.env.NODE_ENV !== "production") {
          log.info("[books-post] skipping owner move taxonomy txn", item.transaction_id);
        }
        return false;
      }
      const looksCcMeta =
        item?.meta?.cc_payment_bank_qbo_account_id ||
        item?.meta?.cc_payment_cc_qbo_account_id ||
        item?.meta?.cc_payment_mapping_confidence;
      if (item?.meta?.taxonomy_type === "cc_payment" || looksCcMeta) {
        const safeCc =
          item?.meta?.safe_to_auto_post === true &&
          item?.meta?.cc_payment_bank_qbo_account_id &&
          item?.meta?.cc_payment_cc_qbo_account_id;
        if (!safeCc) {
          if (process.env.NODE_ENV !== "production") {
            log.info("[books-post] skipping cc_payment without safe mapping", item.transaction_id);
          }
          return false;
        }
        return true;
      }
      if (item?.meta?.taxonomy_type === "refund") {
        if (process.env.NODE_ENV !== "production") {
          log.info("[books-post] skipping refund taxonomy txn", item.transaction_id);
        }
        return false;
      }
      if (item.status === "approved") return true;
      const safe = item?.meta?.safe_to_auto_post === true;
      if (item.status === "auto_approved") return safe;
      if (item.status === "failed") return safe || item?.meta?.auto_approve_reason === "manual_user";
      return false;
    });
    if (checkUpdates.length) {
      const { error: checkErr } = await supabase
        .from("transaction_categorizations")
        .upsert(checkUpdates, { onConflict: "business_id,transaction_id" });
      if (checkErr) {
        log.error("[books-post] failed to mark check txns", checkErr?.message || checkErr);
      }
    }
    const unsafeCcDue = (pending || []).filter((item) => {
      const looksCcMeta =
        item?.meta?.taxonomy_type === "cc_payment" ||
        item?.meta?.cc_payment_bank_qbo_account_id ||
        item?.meta?.cc_payment_cc_qbo_account_id ||
        item?.meta?.cc_payment_mapping_confidence;
      const safeCc =
        looksCcMeta &&
        item?.meta?.safe_to_auto_post === true &&
        item?.meta?.cc_payment_bank_qbo_account_id &&
        item?.meta?.cc_payment_cc_qbo_account_id;
      return looksCcMeta && !safeCc;
    });
    if (unsafeCcDue.length) {
      const updates = unsafeCcDue.map((item) => ({
        business_id: item.business_id,
        transaction_id: item.transaction_id,
        post_after: null,
        post_error: "cc_payment_mapping_not_safe",
        meta: {
          ...(item.meta || {}),
          post_block_reason: "cc_payment_mapping_not_safe",
        },
      }));
      const { error: ccUpdateErr } = await supabase
        .from("transaction_categorizations")
        .upsert(updates, { onConflict: "business_id,transaction_id" });
      if (ccUpdateErr) {
        log.error("[books-post] failed to clear unsafe cc mappings", ccUpdateErr?.message || ccUpdateErr);
      }
    }
    if (process.env.NODE_ENV !== "production" && duePending.length) {
      const skipped = duePending.length - eligible.length;
      if (skipped > 0) {
        log.info("[books-post] skipped pending without safe flag", { skipped, total: duePending.length });
      }
    }

    for (const item of eligible) {
      try {
        await handleItem(item);
        await sleep(150); // small delay to avoid hammering QBO
      } catch (err) {
        log.error("[books-post] failed", item.transaction_id, err?.message || err);
        await markFailed(item, err?.message || "post_failed");
      }
    }
  } catch (err) {
    log.error("[books-post] runOnce error", err?.message || err);
  }
}

export function startBooksPostingCron() {
  if (process.env.DISABLE_BOOKS_POST_CRON === "true") {
    log.info("[books-post] cron disabled via env");
    return;
  }
  const intervalMs = Math.max(1, POLL_MINUTES) * 60 * 1000;
  log.info("[books-post] cron started, interval mins:", POLL_MINUTES);
  setInterval(() => {
    runOnce().catch((err) => log.error("[books-post] interval error", err));
  }, intervalMs);
}

export const runBooksPostOnce = runOnce;
