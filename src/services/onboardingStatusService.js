import { qboEnvName } from "../utils/qboEnv.js";

function fact(value, error = null) {
  if (error) return { value: null, status: "error", error: error?.message || String(error) };
  return { value: Boolean(value), status: "known", error: null };
}

export async function getCanonicalOnboardingStatus({ businessId, db } = {}) {
  if (!businessId) throw new Error("business_id_required");
  if (!db) throw new Error("database_client_required");

  const [profileResult, qboFactResult, plaidFactResult, qboResult, plaidResult] = await Promise.allSettled([
    db.from("business_profiles")
      .select("id,business_name,industry,state,auto_post_to_quickbooks")
      .eq("id", businessId)
      .maybeSingle(),
    db.rpc("business_profile_has_active_qbo_connection", { p_business_id: businessId }),
    db.rpc("business_profile_has_active_plaid_connection", { p_business_id: businessId }),
    db.from("quickbooks_tokens")
      .select("business_id,status,is_active,last_connected_at,realm_id,qbo_env")
      .eq("business_id", businessId)
      .eq("qbo_env", qboEnvName)
      .eq("is_active", true)
      .eq("status", "active")
      .not("realm_id", "is", null)
      .maybeSingle(),
    db.from("plaid_items")
      .select("plaid_item_id,status,is_active,last_sync_at,last_success_at,updated_at")
      .eq("business_id", businessId)
      .eq("is_active", true)
      .in("status", ["connected", "active"]),
  ]);

  const settledValue = (result) => {
    if (result.status === "rejected") return { data: null, error: result.reason };
    return result.value || { data: null, error: null };
  };
  const profileQuery = settledValue(profileResult);
  const qboFactQuery = settledValue(qboFactResult);
  const plaidFactQuery = settledValue(plaidFactResult);
  const qboQuery = settledValue(qboResult);
  const plaidQuery = settledValue(plaidResult);

  const profile = profileQuery.data || null;
  const profileComplete = fact(
    profile && Boolean(
      String(profile.business_name || "").trim() &&
      String(profile.industry || "").trim() &&
      String(profile.state || "").trim()
    ),
    profileQuery.error
  );
  const qboConnected = fact(qboFactQuery.data === true, qboFactQuery.error);
  const plaidItems = Array.isArray(plaidQuery.data) ? plaidQuery.data : [];
  const plaidConnected = fact(plaidFactQuery.data === true, plaidFactQuery.error);
  const values = [profileComplete.value, qboConnected.value, plaidConnected.value];
  const onboarded = values.includes(false) ? false : values.every((value) => value === true) ? true : null;
  const qboRow = qboQuery.data || null;
  const latestPlaid = plaidItems
    .slice()
    .sort((a, b) => String(b.last_success_at || b.last_sync_at || b.updated_at || "").localeCompare(String(a.last_success_at || a.last_sync_at || a.updated_at || "")))[0] || null;

  return {
    business_id: businessId,
    business_profile_complete: profileComplete.value,
    quickbooks_connected: qboConnected.value,
    plaid_connected: plaidConnected.value,
    onboarded,
    status: values.some((value) => value === null) ? "partial_error" : "known",
    auto_post_enabled: profileQuery.error ? null : Boolean(profile?.auto_post_to_quickbooks),
    quickbooks: {
      connected: qboConnected.value,
      status: qboConnected.status,
      health: qboConnected.value === null ? "unknown" : qboConnected.value ? "healthy" : "disconnected",
      last_successful_sync_at: qboRow?.last_connected_at || null,
    },
    plaid: {
      connected: plaidConnected.value,
      status: plaidConnected.status,
      health: plaidConnected.value === null ? "unknown" : plaidConnected.value ? "healthy" : "disconnected",
      last_successful_sync_at: latestPlaid?.last_success_at || latestPlaid?.last_sync_at || latestPlaid?.updated_at || null,
      connected_item_count: plaidQuery.error ? null : plaidItems.length,
    },
    errors: {
      business_profile: profileComplete.error,
      quickbooks: qboConnected.error,
      plaid: plaidConnected.error,
    },
  };
}

export default getCanonicalOnboardingStatus;
