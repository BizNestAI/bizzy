import crypto from "crypto";

export class TransactionExclusionError extends Error {
  constructor(code, status = 400, details = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export async function excludeBookkeepingTransaction({ db, businessId, transactionId, actorId, reason = null, source = "books_review" }) {
  const correlationId = crypto.randomUUID();
  const { data, error } = await db.rpc("exclude_bookkeeping_transaction", {
    p_business_id: businessId,
    p_transaction_id: transactionId,
    p_actor: actorId || "authenticated_user",
    p_reason: reason || null,
    p_source: source,
    p_correlation_id: correlationId,
  });
  if (error) throw new TransactionExclusionError(error.message || "transaction_exclusion_failed", /posting|posted|matched/.test(error.message || "") ? 409 : 400);
  return { ok: true, excluded: true, transaction_id: transactionId, correlation_id: correlationId, ...(data || {}) };
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
