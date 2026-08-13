import crypto from "crypto";

const PROVIDER = "quickbooks";
export const QBO_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

async function getDefaultDb() {
  const { supabase } = await import("../supabaseAdmin.js");
  return supabase;
}

export function generateQboOAuthState() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashQboOAuthState(state) {
  return crypto.createHash("sha256").update(String(state || ""), "utf8").digest("hex");
}

function expiryFrom(now = new Date()) {
  return new Date(now.getTime() + QBO_OAUTH_STATE_TTL_MS).toISOString();
}

export async function createQboOAuthState({
  businessId,
  userId,
  includeProjectsScope = false,
  forceSwitchCompany = false,
  forceBackfill = false,
  returnTo = null,
  returnOrigin = null,
  db = null,
  now = new Date(),
} = {}) {
  const client = db || await getDefaultDb();
  if (!businessId) throw new Error("qbo_oauth_business_required");
  if (!userId) throw new Error("qbo_oauth_user_required");
  const state = generateQboOAuthState();
  const payload = {
    provider: PROVIDER,
    state_hash: hashQboOAuthState(state),
    user_id: userId,
    business_id: businessId,
    created_at: now.toISOString(),
    expires_at: expiryFrom(now),
    used_at: null,
    metadata: {
      includeProjectsScope: Boolean(includeProjectsScope),
      forceSwitchCompany: Boolean(forceSwitchCompany),
      forceBackfill: Boolean(forceBackfill),
      returnTo: normalizeReturnTo(returnTo),
      returnOrigin: normalizeReturnOrigin(returnOrigin),
    },
  };

  const { error } = await client.from("oauth_connection_states").insert(payload);
  if (error) throw error;
  return { state, expiresAt: payload.expires_at, includeProjectsScope: Boolean(includeProjectsScope) };
}

export async function consumeQboOAuthState({ state, db = null, now = new Date() } = {}) {
  const client = db || await getDefaultDb();
  if (!state || typeof state !== "string" || state.length < 32) {
    throw new Error("QBO_OAUTH_STATE_INVALID");
  }

  const stateHash = hashQboOAuthState(state);
  const nowIso = now.toISOString();
  const { data, error } = await client
    .from("oauth_connection_states")
    .update({ used_at: nowIso })
    .eq("provider", PROVIDER)
    .eq("state_hash", stateHash)
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .select("id,user_id,business_id,expires_at,metadata")
    .maybeSingle();
  if (error) throw error;
  if (!data?.business_id || !data?.user_id) throw new Error("QBO_OAUTH_STATE_INVALID");
  return {
    id: data.id,
    userId: data.user_id,
    businessId: data.business_id,
    expiresAt: data.expires_at,
    metadata: data.metadata || {},
  };
}

export async function cleanupExpiredQboOAuthStates({ db = null, now = new Date() } = {}) {
  const client = db || await getDefaultDb();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { error } = await client
    .from("oauth_connection_states")
    .delete()
    .eq("provider", PROVIDER)
    .lt("expires_at", cutoff);
  if (error) throw error;
  return true;
}

export function normalizeReturnTo(value) {
  if (!value) return null;
  const text = String(value);
  if (!text.startsWith("/")) return null;
  if (text.startsWith("//")) return null;
  if (!["/dashboard/settings", "/dashboard"].some((prefix) => text === prefix || text.startsWith(`${prefix}?`))) {
    return null;
  }
  return text;
}

export function normalizeReturnOrigin(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value).trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
