import crypto from "crypto";

const PROVIDER = "plaid_link";
const TTL_MS = 30 * 60 * 1000;

function hash(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function plaidClientUserId({ businessId, userId }) {
  if (!businessId || !userId) throw new Error("plaid_link_identity_required");
  return `bizzi_${hash(`v1:${businessId}:${userId}`).slice(0, 48)}`;
}

export async function createPlaidLinkState({ businessId, userId, db, now = new Date() }) {
  if (!db || !businessId || !userId) throw new Error("plaid_link_state_required");
  const state = crypto.randomBytes(32).toString("base64url");
  const payload = {
    provider: PROVIDER,
    state_hash: hash(state),
    user_id: userId,
    business_id: businessId,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + TTL_MS).toISOString(),
    used_at: null,
    metadata: {},
  };
  const { error } = await db.from("oauth_connection_states").insert(payload);
  if (error) throw error;
  return state;
}

export async function consumePlaidLinkState({ state, businessId, userId, db, now = new Date() }) {
  if (!db || !state || !businessId || !userId) throw new Error("PLAID_LINK_STATE_INVALID");
  const { data, error } = await db.from("oauth_connection_states")
    .update({ used_at: now.toISOString() })
    .eq("provider", PROVIDER)
    .eq("state_hash", hash(state))
    .eq("business_id", businessId)
    .eq("user_id", userId)
    .is("used_at", null)
    .gt("expires_at", now.toISOString())
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) throw new Error("PLAID_LINK_STATE_INVALID");
  return true;
}
