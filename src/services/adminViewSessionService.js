import crypto from "node:crypto";
import { supabase as defaultSupabase } from "./supabaseAdmin.js";

export const ADMIN_VIEW_HEADER = "x-bizzi-admin-view";
export const ADMIN_VIEW_HANDOFF_TTL_SECONDS = Number(process.env.ADMIN_VIEW_HANDOFF_TTL_SECONDS || 5 * 60);
export const ADMIN_VIEW_SESSION_TTL_SECONDS = Number(process.env.ADMIN_VIEW_SESSION_TTL_SECONDS || 4 * 60 * 60);
export const ADMIN_VIEW_ALLOWED_ROLES = Object.freeze(["owner_admin", "accountant", "operator"]);

const TOKEN_BYTES = 32;
const TABLE = "internal_admin_view_sessions";
const STAFF_TABLE = "internal_staff_users";
const BUSINESS_TABLE = "business_profiles";

const SESSION_COLUMNS = [
  "id",
  "staff_user_id",
  "staff_role",
  "business_id",
  "source",
  "read_only",
  "handoff_token_hash",
  "handoff_expires_at",
  "handoff_used_at",
  "session_token_hash",
  "started_at",
  "last_seen_at",
  "expires_at",
  "ended_at",
  "revoked_at",
  "created_at",
  "updated_at",
  "created_ip",
  "created_user_agent",
  "redeemed_ip",
  "redeemed_user_agent",
  "return_url",
  "metadata",
].join(",");

export class AdminViewSessionError extends Error {
  constructor(code, message, status = 403, meta = {}) {
    super(message || code);
    this.name = "AdminViewSessionError";
    this.code = code;
    this.status = status;
    this.meta = meta;
  }
}

export function generateOpaqueToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashAdminViewToken(token) {
  const value = String(token || "").trim();
  if (!value) {
    throw new AdminViewSessionError("admin_view_token_required", "Admin view token is required.", 401);
  }
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function isoNow(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function addSeconds(now, seconds) {
  const date = now instanceof Date ? now : new Date(now);
  return new Date(date.getTime() + Number(seconds || 0) * 1000).toISOString();
}

function isExpired(value, now = new Date()) {
  if (!value) return true;
  return new Date(value).getTime() <= new Date(now).getTime();
}

function normalizeStaff(row) {
  if (!row?.active || !ADMIN_VIEW_ALLOWED_ROLES.includes(String(row?.role || ""))) return null;
  return {
    userId: row.user_id,
    role: row.role,
    active: row.active === true,
  };
}

async function fetchActiveStaff({ db, staffUserId }) {
  const { data, error } = await db
    .from(STAFF_TABLE)
    .select("user_id,role,active")
    .eq("user_id", staffUserId)
    .maybeSingle();

  if (error) {
    throw new AdminViewSessionError("admin_view_staff_check_failed", "Could not verify internal staff.", 403);
  }

  const staff = normalizeStaff(data);
  if (!staff) {
    throw new AdminViewSessionError("admin_view_staff_not_allowed", "Internal staff access is required.", 403);
  }
  return staff;
}

async function fetchBusiness({ db, businessId }) {
  const { data, error } = await db
    .from(BUSINESS_TABLE)
    .select("id,business_name")
    .eq("id", businessId)
    .maybeSingle();

  if (error) {
    throw new AdminViewSessionError("admin_view_business_check_failed", "Could not verify target business.", 403);
  }
  if (!data?.id) {
    throw new AdminViewSessionError("admin_view_business_not_found", "Target business was not found.", 404);
  }
  return {
    id: data.id,
    businessName: data.business_name || null,
  };
}

function publicContext(row, business) {
  return {
    business_id: row.business_id,
    business_name: business?.businessName || business?.business_name || null,
    staff_role: row.staff_role,
    read_only: row.read_only === true,
    admin_view: true,
    source: row.source || "monthly_review",
    started_at: row.started_at || null,
    expires_at: row.expires_at || null,
    return_url: row.return_url || null,
  };
}

function assertSessionActive(row, now) {
  if (!row?.session_token_hash || !row?.started_at) {
    throw new AdminViewSessionError("admin_view_session_not_found", "Admin view session was not found.", 401);
  }
  if (row.revoked_at) {
    throw new AdminViewSessionError("admin_view_session_revoked", "Admin view session was revoked.", 401);
  }
  if (row.ended_at) {
    throw new AdminViewSessionError("admin_view_session_ended", "Admin view session has ended.", 401);
  }
  if (isExpired(row.expires_at, now)) {
    throw new AdminViewSessionError("admin_view_session_expired", "Admin view session expired.", 401);
  }
  if (row.read_only !== true) {
    throw new AdminViewSessionError("admin_view_not_read_only", "Admin view sessions must be read-only.", 403);
  }
}

export async function createAdminViewHandoff({
  staffUserId,
  staffRole,
  businessId,
  source = "monthly_review",
  returnUrl = null,
  ip = null,
  userAgent = null,
  metadata = {},
  handoffTtlSeconds = ADMIN_VIEW_HANDOFF_TTL_SECONDS,
  db = defaultSupabase,
  now = new Date(),
} = {}) {
  const staff = await fetchActiveStaff({ db, staffUserId });
  if (staffRole && String(staffRole) !== String(staff.role)) {
    throw new AdminViewSessionError("admin_view_staff_role_mismatch", "Internal staff role changed.", 403);
  }
  const business = await fetchBusiness({ db, businessId });
  const handoffToken = generateOpaqueToken();
  const handoffTokenHash = hashAdminViewToken(handoffToken);
  const createdAt = isoNow(now);
  const handoffExpiresAt = addSeconds(now, handoffTtlSeconds);

  const payload = {
    staff_user_id: staff.userId,
    staff_role: staff.role,
    business_id: business.id,
    source: String(source || "monthly_review"),
    read_only: true,
    handoff_token_hash: handoffTokenHash,
    handoff_expires_at: handoffExpiresAt,
    created_ip: ip || null,
    created_user_agent: userAgent || null,
    return_url: returnUrl || null,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    created_at: createdAt,
    updated_at: createdAt,
  };

  const { data, error } = await db
    .from(TABLE)
    .insert(payload)
    .select(SESSION_COLUMNS)
    .maybeSingle();

  if (error || !data) {
    throw new AdminViewSessionError("admin_view_handoff_create_failed", "Could not create admin view handoff.", 500);
  }

  return {
    ok: true,
    handoffToken,
    expiresAt: handoffExpiresAt,
    session: data,
    context: publicContext(data, business),
  };
}

export async function redeemAdminViewHandoff({
  token,
  ip = null,
  userAgent = null,
  sessionTtlSeconds = ADMIN_VIEW_SESSION_TTL_SECONDS,
  db = defaultSupabase,
  now = new Date(),
} = {}) {
  const handoffTokenHash = hashAdminViewToken(token);
  const nowIso = isoNow(now);
  const { data: found, error: lookupError } = await db
    .from(TABLE)
    .select(SESSION_COLUMNS)
    .eq("handoff_token_hash", handoffTokenHash)
    .maybeSingle();

  if (lookupError) {
    throw new AdminViewSessionError("admin_view_handoff_lookup_failed", "Could not verify admin view handoff.", 403);
  }
  if (!found) {
    throw new AdminViewSessionError("admin_view_handoff_not_found", "Admin view handoff was not found.", 401);
  }
  if (found.revoked_at || found.ended_at) {
    throw new AdminViewSessionError("admin_view_handoff_revoked", "Admin view handoff is no longer active.", 401);
  }
  if (found.handoff_used_at || found.session_token_hash) {
    throw new AdminViewSessionError("admin_view_handoff_used", "Admin view handoff was already used.", 401);
  }
  if (isExpired(found.handoff_expires_at, now)) {
    throw new AdminViewSessionError("admin_view_handoff_expired", "Admin view handoff expired.", 401);
  }
  if (found.read_only !== true) {
    throw new AdminViewSessionError("admin_view_not_read_only", "Admin view sessions must be read-only.", 403);
  }

  const staff = await fetchActiveStaff({ db, staffUserId: found.staff_user_id });
  if (String(staff.role) !== String(found.staff_role)) {
    throw new AdminViewSessionError("admin_view_staff_role_changed", "Internal staff role changed.", 403);
  }
  const business = await fetchBusiness({ db, businessId: found.business_id });
  const adminViewSessionToken = generateOpaqueToken();
  const sessionTokenHash = hashAdminViewToken(adminViewSessionToken);
  const expiresAt = addSeconds(now, sessionTtlSeconds);

  const { data: redeemed, error: updateError } = await db
    .from(TABLE)
    .update({
      handoff_used_at: nowIso,
      session_token_hash: sessionTokenHash,
      started_at: nowIso,
      last_seen_at: nowIso,
      expires_at: expiresAt,
      redeemed_ip: ip || null,
      redeemed_user_agent: userAgent || null,
      updated_at: nowIso,
    })
    .eq("id", found.id)
    .is("handoff_used_at", null)
    .is("session_token_hash", null)
    .is("revoked_at", null)
    .is("ended_at", null)
    .gt("handoff_expires_at", nowIso)
    .select(SESSION_COLUMNS)
    .maybeSingle();

  if (updateError || !redeemed) {
    throw new AdminViewSessionError("admin_view_handoff_redeem_conflict", "Admin view handoff could not be redeemed.", 401);
  }

  return {
    ok: true,
    adminViewSessionToken,
    context: publicContext(redeemed, business),
    session: redeemed,
  };
}

export async function getAdminViewSession({
  token,
  touch = false,
  db = defaultSupabase,
  now = new Date(),
} = {}) {
  const sessionTokenHash = hashAdminViewToken(token);
  const nowIso = isoNow(now);
  const { data: found, error: lookupError } = await db
    .from(TABLE)
    .select(SESSION_COLUMNS)
    .eq("session_token_hash", sessionTokenHash)
    .maybeSingle();

  if (lookupError) {
    throw new AdminViewSessionError("admin_view_session_lookup_failed", "Could not verify admin view session.", 403);
  }
  assertSessionActive(found, now);

  const staff = await fetchActiveStaff({ db, staffUserId: found.staff_user_id });
  if (String(staff.role) !== String(found.staff_role)) {
    throw new AdminViewSessionError("admin_view_staff_role_changed", "Internal staff role changed.", 403);
  }
  const business = await fetchBusiness({ db, businessId: found.business_id });

  if (touch) {
    await db
      .from(TABLE)
      .update({ last_seen_at: nowIso, updated_at: nowIso })
      .eq("id", found.id);
  }

  return {
    ok: true,
    session: found,
    context: publicContext(found, business),
  };
}

export async function touchAdminViewSession(options = {}) {
  return getAdminViewSession({ ...options, touch: true });
}

export async function endAdminViewSession({
  token,
  db = defaultSupabase,
  now = new Date(),
} = {}) {
  const sessionTokenHash = hashAdminViewToken(token);
  const nowIso = isoNow(now);
  const { data: found, error: lookupError } = await db
    .from(TABLE)
    .select("id,ended_at")
    .eq("session_token_hash", sessionTokenHash)
    .maybeSingle();

  if (lookupError) {
    throw new AdminViewSessionError("admin_view_session_lookup_failed", "Could not verify admin view session.", 403);
  }
  if (!found?.id) {
    return { ok: true, ended: false };
  }
  if (found.ended_at) {
    return { ok: true, ended: true };
  }

  await db
    .from(TABLE)
    .update({ ended_at: nowIso, updated_at: nowIso })
    .eq("id", found.id);

  return { ok: true, ended: true };
}

export async function revokeAdminViewSessionsForStaff({
  staffUserId,
  db = defaultSupabase,
  now = new Date(),
} = {}) {
  const nowIso = isoNow(now);
  const { data, error } = await db
    .from(TABLE)
    .update({ revoked_at: nowIso, updated_at: nowIso })
    .eq("staff_user_id", staffUserId)
    .is("revoked_at", null);

  if (error) {
    throw new AdminViewSessionError("admin_view_revoke_failed", "Could not revoke admin view sessions.", 500);
  }
  return { ok: true, count: Array.isArray(data) ? data.length : 0 };
}

export async function cleanupExpiredAdminViewSessions({
  db = defaultSupabase,
  now = new Date(),
} = {}) {
  const nowIso = isoNow(now);
  const { data, error } = await db
    .from(TABLE)
    .update({ ended_at: nowIso, updated_at: nowIso })
    .lt("expires_at", nowIso)
    .is("ended_at", null)
    .is("revoked_at", null);

  if (error) {
    throw new AdminViewSessionError("admin_view_cleanup_failed", "Could not clean up expired admin view sessions.", 500);
  }
  return { ok: true, count: Array.isArray(data) ? data.length : 0 };
}

export function extractAdminViewToken(req) {
  const raw = req?.headers?.[ADMIN_VIEW_HEADER] || req?.headers?.[ADMIN_VIEW_HEADER.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw || "";
}

export function redactAdminViewSession(row = {}) {
  if (!row || typeof row !== "object") return row;
  const copy = { ...row };
  delete copy.handoff_token_hash;
  delete copy.session_token_hash;
  return copy;
}
