import crypto from "crypto";
import { getBookkeepingExclusionEligibility } from "./exclusionEligibility.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ERROR_DEFINITIONS = {
  MALFORMED_TRANSACTION_ID: [400, "Transaction ID is malformed."],
  TRANSACTION_NOT_FOUND: [404, "Transaction could not be found."],
  TRANSACTION_ACCOUNT_MISMATCH: [403, "Transaction does not belong to the selected account."],
  TRANSACTION_ALREADY_POSTED: [409, "A posted transaction cannot be excluded."],
  TRANSACTION_ALREADY_MATCHED: [409, "A matched transaction cannot be excluded."],
  POSTING_IN_PROGRESS: [409, "Posting is currently in progress."],
  EXCLUSION_SCHEMA_NOT_READY: [500, "Transaction exclusion is temporarily unavailable."],
  TRANSACTION_EXCLUSION_FAILED: [500, "Transaction could not be excluded."],
};

export class TransactionExclusionError extends Error {
  constructor(code, status = 500, details = {}, message = null) {
    super(message || ERROR_DEFINITIONS[code]?.[1] || "Transaction exclusion failed.");
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function mapTransactionExclusionDatabaseError(error = {}, correlationId = null) {
  const raw = String(error?.message || "").toLowerCase();
  let code = "TRANSACTION_EXCLUSION_FAILED";
  if (raw.includes("transaction_not_found")) code = "TRANSACTION_NOT_FOUND";
  else if (raw.includes("transaction_already_posted")) code = "TRANSACTION_ALREADY_POSTED";
  else if (raw.includes("transaction_already_matched")) code = "TRANSACTION_ALREADY_MATCHED";
  else if (raw.includes("posting_in_progress")) code = "POSTING_IN_PROGRESS";
  else if (error?.code === "23514" || error?.code === "PGRST202" || raw.includes("transaction_categorizations_status_check")) code = "EXCLUSION_SCHEMA_NOT_READY";
  const [status, message] = ERROR_DEFINITIONS[code];
  return new TransactionExclusionError(code, status, { correlationId }, message);
}

export async function excludeBookkeepingTransaction({ db, businessId, transactionId, accountId = null, actorId, reason = null, source = "books_review" }) {
  const correlationId = crypto.randomUUID();
  if (!UUID_PATTERN.test(String(transactionId || ""))) {
    throw new TransactionExclusionError("MALFORMED_TRANSACTION_ID", 400, { correlationId });
  }
  const { data: bank, error: bankError } = await db.from("bank_transactions")
    .select("id,plaid_account_id,pending,is_archived")
    .eq("business_id", businessId).eq("id", transactionId).maybeSingle();
  if (bankError) throw new TransactionExclusionError("TRANSACTION_EXCLUSION_FAILED", 500, { correlationId });
  if (!bank || bank.is_archived === true) throw new TransactionExclusionError("TRANSACTION_NOT_FOUND", 404, { correlationId });
  if (accountId && String(bank.plaid_account_id) !== String(accountId)) {
    throw new TransactionExclusionError("TRANSACTION_ACCOUNT_MISMATCH", 403, { correlationId });
  }
  const { data: category, error: categoryError } = await db.from("transaction_categorizations")
    .select("status,posting_status,meta,qbo_txn_id,posted_at")
    .eq("business_id", businessId).eq("transaction_id", transactionId).maybeSingle();
  if (categoryError) throw new TransactionExclusionError("TRANSACTION_EXCLUSION_FAILED", 500, { correlationId });
  const eligibility = getBookkeepingExclusionEligibility({ ...(category || {}), pending: bank.pending });
  if (!eligibility.eligible) throw mapTransactionExclusionDatabaseError({ message: eligibility.reason }, correlationId);
  const { data, error } = await db.rpc("exclude_bookkeeping_transaction", {
    p_business_id: businessId,
    p_transaction_id: transactionId,
    p_actor: actorId || "authenticated_user",
    p_reason: reason || null,
    p_source: source,
    p_correlation_id: correlationId,
  });
  if (error) throw mapTransactionExclusionDatabaseError(error, correlationId);
  return {
    ok: true, excluded: true, transaction_id: transactionId, correlation_id: correlationId,
    transaction: { id: transactionId, plaid_account_id: bank.plaid_account_id, status: "excluded", primary_feed: "excluded", excluded_at: data?.excluded_at || null },
    ...(data || {}),
  };
}

export async function restoreBookkeepingTransaction({ db, businessId, transactionId, actorId, source = "books_review" }) {
  const correlationId = crypto.randomUUID();
  const { data, error } = await db.rpc("restore_bookkeeping_transaction", {
    p_business_id: businessId,
    p_transaction_id: transactionId,
    p_actor: actorId || "authenticated_user",
    p_source: source,
    p_correlation_id: correlationId,
  });
  if (error) throw new TransactionExclusionError(error.message || "transaction_restore_failed", 400);
  return { ok: true, restored: true, transaction_id: transactionId, correlation_id: correlationId, ...(data || {}) };
}

export async function assertTransactionNotExcluded({ db, businessId, transactionId }) {
  const { data, error } = await db
    .from("transaction_categorizations")
    .select("status,meta")
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .maybeSingle();
  if (error) throw error;
  if (data?.status === "excluded" || data?.meta?.excluded_at) {
    throw new TransactionExclusionError("transaction_excluded", 409);
  }
  return true;
}
