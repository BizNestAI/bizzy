// Preview by default. No provider calls, worker wake, cursor mutation or QBO write.
export async function recoverResidualPlaidOrphans({ db, businessId, plaidEnv, plaidAccountId, actorUserId, execute = false, batchId = null }) {
  const apply = execute === true;
  if (!businessId || !plaidEnv || !plaidAccountId || !actorUserId || (apply && !batchId)) {
    throw Object.assign(new Error("plaid_residual_scope_required"), { code: "plaid_residual_scope_required", status: 400 });
  }
  const args = { p_business_id: businessId, p_plaid_env: plaidEnv, p_plaid_account_id: plaidAccountId, p_actor_user_id: actorUserId };
  if (apply) args.p_batch_id = batchId;
  const { data, error } = await db.rpc(apply ? "apply_plaid_residual_orphan_recovery" : "preview_plaid_residual_orphan_recovery", args);
  if (error) {
    const code = /^plaid_residual_[a-z_]+$/.test(error.message || "") ? error.message : "plaid_residual_recovery_failed";
    throw Object.assign(new Error(code), { code, status: error.code === "42501" ? 403 : error.code === "22023" ? 400 : 409 });
  }
  return data;
}
