import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import { getAuthenticatedUserId } from "./tenantAuth.js";

export const INTERNAL_STAFF_ROLES = Object.freeze([
  "owner_admin",
  "accountant",
  "operator",
]);

export const MONTHLY_REVIEW_STAFF_ROLES = Object.freeze([
  "owner_admin",
  "accountant",
  "operator",
]);

export class InternalStaffAuthError extends Error {
  constructor(code, message, status = 403) {
    super(message || code);
    this.name = "InternalStaffAuthError";
    this.code = code;
    this.status = status;
  }
}

export async function resolveInternalStaff({
  req,
  roles = INTERNAL_STAFF_ROLES,
  supabase = defaultSupabase,
} = {}) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) {
    throw new InternalStaffAuthError("AUTH_REQUIRED", "Authentication is required.", 401);
  }

  const allowedRoles = new Set((roles || []).map((role) => String(role).trim()).filter(Boolean));
  const { data, error } = await supabase
    .from("internal_staff_users")
    .select("user_id,role,active,created_at,updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new InternalStaffAuthError("INTERNAL_STAFF_CHECK_FAILED", "Could not verify internal staff access.", 403);
  }

  if (!data?.active || !allowedRoles.has(String(data?.role || ""))) {
    throw new InternalStaffAuthError("FORBIDDEN_INTERNAL_STAFF_ONLY", "Internal staff access is required.", 403);
  }

  return {
    userId: data.user_id,
    role: data.role,
    active: data.active === true,
    createdAt: data.created_at || null,
    updatedAt: data.updated_at || null,
  };
}

export function attachInternalStaff(req, staff) {
  req.internalStaff = staff;
  req.auth ||= {};
  req.auth.internalStaffRole = staff.role;
}

export function sendInternalStaffAuthError(res, err) {
  const status = Number(err?.status || 403);
  const code = err?.code || "FORBIDDEN_INTERNAL_STAFF_ONLY";
  return res.status(status).json({ ok: false, error: code, code });
}

export function requireInternalRole(roles = INTERNAL_STAFF_ROLES, options = {}) {
  return async function requireInternalRoleMiddleware(req, res, next) {
    try {
      const staff = await resolveInternalStaff({
        req,
        roles,
        supabase: options.supabase || defaultSupabase,
      });
      attachInternalStaff(req, staff);
      return next();
    } catch (err) {
      if (err instanceof InternalStaffAuthError) return sendInternalStaffAuthError(res, err);
      console.error("[internalStaffAuth] authorization failed:", err?.code || err?.name || "ERR", err?.message);
      return sendInternalStaffAuthError(
        res,
        new InternalStaffAuthError("FORBIDDEN_INTERNAL_STAFF_ONLY", "Internal staff access is required.", 403)
      );
    }
  };
}

export const requireInternalStaff = (options = {}) =>
  requireInternalRole(INTERNAL_STAFF_ROLES, options);
