// Shared selection predicate; authorization and account lookup remain server-side.
export function isExpenseRefundSelection(transaction = {}, account = {}) {
  const type = String(account.type || account.account_type || account.AccountType || "").toLowerCase().replace(/[^a-z]/g, "");
  const direction = String(transaction.direction || "").toUpperCase();
  const amount = Number(transaction.signed_amount ?? transaction.signedAmount ?? transaction.amount);
  return Number.isFinite(amount) && amount > 0 &&
    (!direction || direction === "INFLOW") && ["expense", "costofgoodssold"].includes(type);
}

export function buildExpenseRefundTreatment({ businessId, transaction, account, actorId, actorType, confirmed, sourceType, source, timestamp } = {}) {
  const reject = (code) => { const error = new Error(code); error.code = code; throw error; };
  if (!actorId || !["user", "admin"].includes(actorType)) reject("expense_refund_manual_actor_required");
  if (!confirmed) reject("expense_refund_confirmation_required");
  if (transaction?.pending !== false || !isExpenseRefundSelection(transaction, account)) reject("expense_refund_invalid_transaction_or_account");
  if (!account?.id || account.active !== true) reject("expense_refund_active_expense_account_required");
  if (!["bank", "creditcard"].includes(sourceType)) reject("expense_refund_source_not_supported");
  return {
    version: 1,
    treatment: "merchant_refund_expense_credit",
    business_id: businessId,
    transaction_id: transaction.id,
    actor_id: actorId,
    actor_type: actorType,
    selected_qbo_account_id: String(account.id),
    original_amount: Number(transaction.amount),
    original_direction: transaction.direction || "INFLOW",
    refund_attested: true,
    confirmed_at: timestamp,
    source,
    source_account_type: sourceType,
  };
}
