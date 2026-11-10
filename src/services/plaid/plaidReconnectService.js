import { runSyncForItem } from "./plaidSyncService.js";
import { resolveStoredPlaidAccessToken } from "./plaidTokenCrypto.js";
import { plaidEnvName } from "./plaidClient.js";

const failure = (code, status = 409) => Object.assign(new Error(code), { code, status });
const publicResult = (itemId, status, action, extra = {}) => ({ plaid_item_id: itemId, status,
  recommended_action: action, ingestion_started: false, ...extra });

// Only called after Link onSuccess (or an explicit resume). Link itself never
// clears a provider error. Provider verification precedes any durable mutation.
export async function completePlaidReconnect({ businessId, plaidItemId, actorUserId, db, plaid,
  resolveToken = resolveStoredPlaidAccessToken, replay = runSyncForItem }) {
  const { data: item, error } = await db.from("plaid_items").select("*")
    .eq("business_id", businessId).eq("plaid_env", plaidEnvName).eq("plaid_item_id", plaidItemId).maybeSingle();
  if (error) throw failure("plaid_reconnect_read_failed", 503);
  if (!item?.id || item.is_active === false) throw failure("plaid_item_not_found", 404);
  if (!actorUserId || !plaid) throw failure("plaid_reconnect_context_required", 400);
  const accessToken = await resolveToken({ storedToken: item.plaid_access_token });
  let provider;
  try { provider = (await plaid.accountsGet({ access_token: accessToken }))?.data; }
  catch (error) {
    // A missing retained Item is a stop, never permission to exchange a token
    // or infer account continuity from a mask/institution name.
    const code = error?.response?.data?.error_code || error?.error_code;
    if (code === "ITEM_NOT_FOUND") return publicResult(plaidItemId, "new_item_identity_required", "review_account_identity");
    throw failure("plaid_reconnect_provider_verification_failed");
  }
  if (provider?.item?.error) throw failure("plaid_reconnect_provider_verification_failed");
  if (provider?.item?.item_id !== plaidItemId || !Array.isArray(provider.accounts) || !provider.accounts.length) {
    return publicResult(plaidItemId, "identity_review_required", "review_account_identity");
  }
  const accounts = provider.accounts.map(a => ({ plaid_account_id: a.account_id, name: a.name || "Account",
    official_name: a.official_name || null, mask: a.mask || null, type: a.type || null, subtype: a.subtype || null }));
  if (accounts.some(a => typeof a.plaid_account_id !== "string" || !a.plaid_account_id)
    || new Set(accounts.map(a => a.plaid_account_id)).size !== accounts.length) throw failure("plaid_reconnect_provider_identity_invalid");
  const { data: state, error: writeError } = await db.rpc("record_plaid_reconnect_verification", {
    p_business_id: businessId, p_plaid_env: plaidEnvName, p_plaid_item_id: plaidItemId,
    p_actor_id: actorUserId, p_expected_cursor: item.cursor, p_accounts: accounts,
  });
  if (writeError) throw failure("plaid_reconnect_verification_conflict");
  if (state.state === "identity_review_required") return publicResult(plaidItemId, state.state, "review_account_identity", { new_accounts: state.new_accounts });
  if (state.state === "completed") return publicResult(plaidItemId, "completed", "none", { checkpoint_run_id: state.checkpoint_run_id });
  const { data: current, error: readError } = await db.from("plaid_items").select("*").eq("business_id", businessId).eq("id", item.id).maybeSingle();
  if (readError || !current) throw failure("plaid_reconnect_read_failed", 503);
  try {
    const result = await replay(plaid, businessId, current, { db, resolveToken });
    if (!result?.ok) return publicResult(plaidItemId, "waiting_for_replay", "resume_reconnect");
    const { data: after, error: afterError } = await db.from("plaid_items").select("reconnect_state")
      .eq("business_id", businessId).eq("id", item.id).single();
    if (afterError || after.reconnect_state?.state !== "completed") return publicResult(plaidItemId, "waiting_for_replay", "wait_for_replay");
    return publicResult(plaidItemId, "completed", "none", { ingestion_started: true,
      checkpoint_run_id: after.reconnect_state.checkpoint_run_id, continuity: "replay_completed_no_proven_gap" });
  } catch {
    // The normal synchronizer has retained the cursor and durable failure run.
    return publicResult(plaidItemId, "replay_failed", "resume_reconnect");
  }
}
