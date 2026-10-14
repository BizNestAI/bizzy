function contractError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

export function validateStatementConfirmation({ actor, statementDate, statementAmount } = {}) {
  if (!actor?.id) throw contractError("operator_authorization_required", "An authenticated operator is required to confirm settlement.", 403);
  const dateText = String(statementDate || "");
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? new Date(`${dateText}T00:00:00Z`) : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== dateText) {
    throw contractError("invalid_statement_date", "Enter a valid statement-confirmed date.", 400);
  }
  const amount = Number(statementAmount);
  if (!Number.isFinite(amount) || amount === 0) throw contractError("invalid_statement_amount", "Enter a valid nonzero statement amount.", 400);
  return { statementDate: dateText, statementAmount: amount };
}

export function validatePendingExclusionAttestation({ actor, attested } = {}) {
  if (!actor?.id) throw contractError("operator_authorization_required", "An authenticated operator is required to exclude an authorization.", 403);
  if (attested !== true) throw contractError("pending_exclusion_attestation_required", "Confirm that you verified this authorization did not settle.", 400);
}

export function buildPendingSettlementRpcInput({ businessId, transactionId, actor, statementDate, statementAmount, note, idempotencyKey }) {
  const validated = validateStatementConfirmation({ actor, statementDate, statementAmount });
  return {
    p_business_id: businessId,
    p_transaction_id: transactionId,
    p_actor_user_id: actor.id,
    p_actor_label: actor.email || actor.label || null,
    p_statement_date: validated.statementDate,
    p_statement_amount: validated.statementAmount,
    p_reason: String(note || "").trim() || null,
    p_idempotency_key: idempotencyKey,
    p_decision_version: 1,
  };
}
