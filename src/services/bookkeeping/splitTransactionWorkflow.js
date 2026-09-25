import { resolveBankTransactionCurrency } from "./bankTransactionCurrency.js";

export class SplitTransactionWorkflowError extends Error {
  constructor(error, details = {}) {
    super(error);
    this.name = "SplitTransactionWorkflowError";
    this.error = error;
    this.details = details;
  }
}

function normalizeAccountType(value = "") {
  return String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
}

function signedAmountMinor(transaction = {}) {
  const signedMinor = Number(transaction.signed_amount_minor ?? transaction.amount_minor);
  if (Number.isInteger(signedMinor) && signedMinor !== 0) return signedMinor;
  const signed = Number(transaction.signed_amount ?? transaction.amount);
  if (!Number.isFinite(signed) || signed === 0) return null;
  return Math.round(signed * 100);
}

function accountName(account = {}) {
  return account.name || account.fullyQualifiedName || account.FullyQualifiedName || null;
}

function isPostingQboAccount(account = {}) {
  const type = normalizeAccountType(account.type || account.AccountType || account.account_type);
  return !["bank", "creditcard", "creditcardaccount", "accountsreceivable", "accountspayable"].includes(type);
}

export function validateSplitTransaction({ transaction = {}, split = {}, accountsById = new Map() } = {}) {
  if (transaction.pending === true) throw new SplitTransactionWorkflowError("pending_transaction_not_postable");
  const signedMinor = signedAmountMinor(transaction);
  if (!Number.isInteger(signedMinor) || signedMinor === 0) throw new SplitTransactionWorkflowError("split_transaction_requires_nonzero_amount");
  const expected = Math.abs(signedMinor);
  const rawLines = Array.isArray(split.lines) ? split.lines : [];
  const lines = rawLines
    .map((line, index) => ({
      line_index: index,
      description: String(line.description || line.label || `Line ${index + 1}`).trim() || `Line ${index + 1}`,
      amount_minor: Number(line.amount_minor),
      qbo_account_id: line.qbo_account_id || line.qboAccountId || null,
      qbo_account_name: line.qbo_account_name || line.qboAccountName || null,
    }))
    .filter((line) => Number(line.amount_minor || 0) > 0);
  if (lines.length < 2) throw new SplitTransactionWorkflowError("split_transaction_requires_two_lines");
  const total = lines.reduce((sum, line) => sum + Number(line.amount_minor || 0), 0);
  if (total !== expected) throw new SplitTransactionWorkflowError("split_transaction_total_mismatch", { expected_amount_minor: expected, actual_amount_minor: total });
  for (const line of lines) {
    if (!Number.isInteger(line.amount_minor) || line.amount_minor <= 0) {
      throw new SplitTransactionWorkflowError("split_transaction_line_amount_invalid", { line_index: line.line_index });
    }
    if (!line.qbo_account_id) throw new SplitTransactionWorkflowError("split_transaction_line_missing_account", { line_index: line.line_index });
    const account = accountsById.get(String(line.qbo_account_id));
    if (!account) {
      if (accountsById.size > 0) throw new SplitTransactionWorkflowError("split_transaction_line_account_not_found", { line_index: line.line_index, qbo_account_id: line.qbo_account_id });
      continue;
    }
    if (!isPostingQboAccount(account)) {
      throw new SplitTransactionWorkflowError("split_transaction_line_account_not_postable", { line_index: line.line_index, qbo_account_id: line.qbo_account_id });
    }
    line.qbo_account_name = accountName(account) || line.qbo_account_name;
  }
  return { ok: true, expected_amount_minor: expected, lines };
}

export async function confirmSplitTransaction({
  db,
  businessId,
  transaction = {},
  split = {},
  accountsById = new Map(),
  actorId = null,
  actorType = "user",
} = {}) {
  if (!db || !businessId) throw new SplitTransactionWorkflowError("missing_database_or_business");
  const validation = validateSplitTransaction({ transaction, split, accountsById });
  const nowIso = new Date().toISOString();
  const transactionId = transaction.id || transaction.transaction_id || null;
  const { data: existing, error: existingError } = await db
    .from("transaction_splits")
    .select("*")
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("status", "confirmed")
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return { split: existing, created: false };
  const payload = {
    business_id: businessId,
    transaction_id: transactionId,
    status: "confirmed",
    split_type: split.split_type || "general",
    total_amount_minor: validation.expected_amount_minor,
    currency: resolveBankTransactionCurrency(transaction, split.currency),
    lines: validation.lines.map((line) => ({
      description: line.description,
      amount_minor: line.amount_minor,
      qbo_account_id: line.qbo_account_id,
      qbo_account_name: line.qbo_account_name || null,
    })),
    confirmed_by: actorId,
    confirmed_actor_type: actorType,
    confirmed_at: nowIso,
    meta: {
      source: "split_transaction_modal",
      line_count: validation.lines.length,
    },
  };
  const { data, error } = await db
    .from("transaction_splits")
    .insert(payload)
    .select("*")
    .maybeSingle();
  if (error?.code === "23505") {
    const { data: concurrent, error: concurrentError } = await db
      .from("transaction_splits")
      .select("*")
      .eq("business_id", businessId)
      .eq("transaction_id", transactionId)
      .eq("status", "confirmed")
      .maybeSingle();
    if (concurrentError) throw concurrentError;
    if (concurrent) return { split: concurrent, created: false };
  }
  if (error) throw error;
  return { split: data, created: true };
}

export async function fetchConfirmedSplitTransaction({ db, businessId, transactionId }) {
  if (!db || !businessId || !transactionId) return null;
  const { data, error } = await db
    .from("transaction_splits")
    .select("*")
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("status", "confirmed")
    .order("confirmed_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function markSplitTransactionPosted({ db, businessId, transactionId, qboTxnId, postedAt } = {}) {
  if (!db || !businessId || !transactionId || !qboTxnId) return null;
  const postedIso = postedAt || new Date().toISOString();
  const { data, error } = await db
    .from("transaction_splits")
    .update({
      status: "posted",
      posted_qbo_txn_id: qboTxnId,
      posted_at: postedIso,
      updated_at: postedIso,
    })
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("status", "confirmed")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export function splitTransactionRowToExecutableSplit(row = {}) {
  return {
    lines: Array.isArray(row.lines) ? row.lines : [],
  };
}

export function buildSplitTransactionQboPayload({ transaction = {}, split = {}, mapping = {}, requestId, lineDescription, privateNote } = {}) {
  const validation = validateSplitTransaction({ transaction, split });
  const paymentType = normalizeAccountType(mapping.qbo_account_type) === "creditcard" ? "CreditCard" : "Cash";
  const txnDate = transaction.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(txnDate || ""))) throw new SplitTransactionWorkflowError("missing_plaid_posted_date");
  return {
    requestId,
    PaymentType: paymentType,
    AccountRef: { value: String(mapping.qbo_account_id) },
    TxnDate: txnDate,
    PrivateNote: privateNote || `Split transaction by Bizzi for bank transaction ${transaction.id || transaction.transaction_id || ""}`.trim(),
    Line: validation.lines.map((line) => ({
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: Number(line.amount_minor) / 100,
      Description: line.description || lineDescription || "Split transaction",
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: String(line.qbo_account_id) },
      },
    })),
  };
}
