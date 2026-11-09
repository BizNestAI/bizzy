// Operator authority only. No imports of provider clients, queues or workers.
export async function reconcileResidualPlaidBatch({ db, businessId, plaidEnv, plaidAccountId, batchId, actorUserId,
  execute = false, manifestId = null, reviewedTransactionIds = [], liveQboAttestation = null }) {
  const release = execute === true;
  if (!businessId || !plaidEnv || !plaidAccountId || !batchId || !actorUserId
    || (release && (!manifestId || !Array.isArray(reviewedTransactionIds) || !reviewedTransactionIds.length))) {
    throw Object.assign(new Error("plaid_reconciliation_scope_or_rows_required"), { code: "plaid_reconciliation_scope_or_rows_required", status: 400 });
  }
  const args = { p_business_id: businessId, p_plaid_env: plaidEnv, p_account_id: plaidAccountId, p_batch_id: batchId, p_actor_id: actorUserId };
  if (release) Object.assign(args, { p_execute: true, p_manifest_id: manifestId, p_reviewed_ids: reviewedTransactionIds, p_attestation: liveQboAttestation });
  const { data, error } = await db.rpc(release ? "release_plaid_residual_reconciliation" : "preview_plaid_residual_reconciliation", args);
  if (error) {
    const code = /^plaid_reconciliation_[a-z_]+$/.test(error.message || "") ? error.message : "plaid_reconciliation_failed";
    const details = {};
    if (code === "plaid_reconciliation_evidence_changed") {
      try {
        const value = JSON.parse(error.details);
        details.classification = "evidence_changed";
        details.changed_transaction_ids = (value.changed_transaction_ids || []).filter(id => /^[a-f0-9-]{36}$/i.test(id));
      } catch { /* Never expose arbitrary database DETAIL. */ }
    }
    throw Object.assign(new Error(code), { code, status: error.code === "42501" ? 403 : ["22023", "22P02", "22007", "22008"].includes(error.code) ? 400 : 409, details });
  }
  return data;
}
