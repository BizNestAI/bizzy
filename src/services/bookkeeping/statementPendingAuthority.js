const CONFIRMED = new Set(["statement_review_override", "statement_review_settled", "statement_review_released"]);
export const isStatementPendingState = value => String(value || "").startsWith("statement_review_");
export function hasStatementPendingAuthority(row = {}, { releasedOnly = true } = {}) {
  const state = row.pending_resolution_state || row.meta?.pending_resolution_state;
  const evidence = row.pending_resolution_payload;
  const verified = (evidence?.statement_attested === true && evidence?.authority_version === 2) || row.meta?.statement_pending_authority === true;
  return CONFIRMED.has(state) && verified && (!releasedOnly || state === "statement_review_released");
}
// This is a workflow projection, never a write to provider data. Database guards
// are authoritative; every release/schedule/provider boundary rechecks evidence.
export function statementPendingWorkflowRow(row = {}, { forApproval = false } = {}) {
  if (!hasStatementPendingAuthority(row, { releasedOnly: !forApproval })) return row;
  return { ...row, provider_pending: row.provider_pending ?? row.pending, pending: false,
    accounting_review_required: ["statement_confirmed_pending", "statement_pending_provider_settled"].includes(row.accounting_review_reason) ? false : row.accounting_review_required };
}
export const missingStatementPendingSchema = error => ["PGRST202", "42883"].includes(error?.code);
export async function statementPendingRetry(operation, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await operation();
    // A returned SQL error is known aborted. A transport exception may have
    // committed, so callers preserve the persistent key and surface it.
    if (!result?.error || !["40001", "40P01", "55P03", "57014"].includes(result.error.code)) return result;
    if (attempt < 2) await sleep(25 * (attempt + 1));
  }
  return result;
}
