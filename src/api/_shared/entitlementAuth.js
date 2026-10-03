/* global process */
import crypto from "crypto";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";

export const ENTITLEMENT_CAPABILITIES = Object.freeze({
  HISTORICAL_READ: "historical_read",
  PAID_COMPUTE: "paid_compute",
  FINANCIAL_WRITE: "financial_write",
  PROVIDER_SYNC: "provider_sync",
  INTEGRATION_ADMIN: "integration_admin",
  PROVIDER_DISCONNECT: "provider_disconnect",
  BILLING_ADMIN: "billing_admin",
});

export const FULL_ENTITLEMENT_STATUSES = new Set(["active", "trialing"]);
export const READ_ONLY_ENTITLEMENT_STATUSES = new Set([
  "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "free", "missing", "unknown",
]);
export const BUSINESS_ADMIN_ROLES = new Set(["owner"]);

const MODE = String(process.env.STRIPE_MODE || "").toLowerCase() === "test" ? "test" :
  String(process.env.STRIPE_MODE || "").toLowerCase() === "live" ? "live" :
  process.env.NODE_ENV === "production" ? "live" : "test";

export class EntitlementError extends Error {
  constructor(code, status = 403, details = {}) {
    super(code);
    this.name = "EntitlementError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function scoped(row, key, fallback = null, mode = MODE) {
  const value = row?.[`${key}_${mode}`];
  if (value !== undefined && value !== null) return value;
  return fallback;
}

export function normalizeEntitlementStatus(value) {
  const status = String(value || "missing").trim().toLowerCase();
  const known = new Set([...FULL_ENTITLEMENT_STATUSES, ...READ_ONLY_ENTITLEMENT_STATUSES]);
  return known.has(status) ? status : "unknown";
}

export function capabilitiesForEntitlement({ status, role }) {
  const normalizedStatus = normalizeEntitlementStatus(status);
  const normalizedRole = String(role || "staff").toLowerCase();
  const capabilities = new Set([ENTITLEMENT_CAPABILITIES.HISTORICAL_READ]);
  if (BUSINESS_ADMIN_ROLES.has(normalizedRole)) {
    capabilities.add(ENTITLEMENT_CAPABILITIES.BILLING_ADMIN);
    capabilities.add(ENTITLEMENT_CAPABILITIES.PROVIDER_DISCONNECT);
  }
  if (FULL_ENTITLEMENT_STATUSES.has(normalizedStatus)) {
    capabilities.add(ENTITLEMENT_CAPABILITIES.PAID_COMPUTE);
    capabilities.add(ENTITLEMENT_CAPABILITIES.FINANCIAL_WRITE);
    capabilities.add(ENTITLEMENT_CAPABILITIES.PROVIDER_SYNC);
    if (BUSINESS_ADMIN_ROLES.has(normalizedRole)) capabilities.add(ENTITLEMENT_CAPABILITIES.INTEGRATION_ADMIN);
  }
  return capabilities;
}

export async function resolveBusinessEntitlement({ businessId, role, db = defaultSupabase, mode = MODE } = {}) {
  if (!businessId) throw new EntitlementError("business_required", 400);
  const { data, error } = await db.from("business_billing").select("*").eq("business_id", businessId).maybeSingle();
  if (error) throw new EntitlementError("entitlement_lookup_failed", 503);
  const status = normalizeEntitlementStatus(scoped(data, "subscription_status", "missing", mode));
  const result = {
    businessId,
    environment: mode,
    status,
    role: String(role || "staff").toLowerCase(),
    subscriptionId: scoped(data, "stripe_subscription_id", null, mode),
  };
  result.capabilities = capabilitiesForEntitlement(result);
  return result;
}

export function correlationId(req) {
  const supplied = String(req?.headers?.["x-correlation-id"] || "").trim();
  return /^[a-zA-Z0-9._:-]{8,100}$/.test(supplied) ? supplied : crypto.randomUUID();
}

export function requireEntitlementCapability(capability, options = {}) {
  return async function entitlementCapabilityMiddleware(req, res, next) {
    const requestId = correlationId(req);
    res.setHeader?.("x-correlation-id", requestId);
    try {
      if (req.tenantContext?.mode === "admin_view") {
        if (capability === ENTITLEMENT_CAPABILITIES.HISTORICAL_READ) return next();
        if (!req.adminBookkeepingAccess || capability !== ENTITLEMENT_CAPABILITIES.FINANCIAL_WRITE) {
          throw new EntitlementError("admin_view_read_only", 403);
        }
        const businessId = req.tenantContext.businessId;
        const entitlement = await resolveBusinessEntitlement({
          businessId,
          role: "staff",
          db: options.db || defaultSupabase,
          mode: options.mode || MODE,
        });
        req.entitlement = entitlement;
        req.tenantContext.entitlement = entitlement;
        if (!FULL_ENTITLEMENT_STATUSES.has(entitlement.status)) {
          throw new EntitlementError("entitlement_capability_denied", 402, { capability, status: entitlement.status });
        }
        return next();
      }
      const businessId = req.business?.id || req.auth?.businessId || req.tenantContext?.businessId || null;
      const role = req.business?.membershipRole || req.tenantContext?.membershipRole || "staff";
      const entitlement = await resolveBusinessEntitlement({ businessId, role, db: options.db || defaultSupabase, mode: options.mode || MODE });
      req.entitlement = entitlement;
      req.tenantContext ||= {};
      req.tenantContext.entitlement = entitlement;
      if (!entitlement.capabilities.has(capability)) {
        throw new EntitlementError("entitlement_capability_denied", 402, { capability, status: entitlement.status });
      }
      return next();
    } catch (error) {
      if (!(error instanceof EntitlementError)) return next(error);
      return res.status(error.status).json({
        ok: false,
        error: error.code,
        code: error.code,
        capability,
        entitlement_status: error.details?.status || null,
        correlation_id: requestId,
      });
    }
  };
}

export function requireBusinessRole(roles = ["owner"]) {
  const allowed = new Set(roles.map((role) => String(role).toLowerCase()));
  return function businessRoleMiddleware(req, res, next) {
    if (req.tenantContext?.mode === "admin_view") return res.status(403).json({ ok: false, error: "admin_view_read_only" });
    const role = String(req.business?.membershipRole || req.tenantContext?.membershipRole || "staff").toLowerCase();
    if (!allowed.has(role)) return res.status(403).json({ ok: false, error: "business_role_required", required_roles: [...allowed] });
    return next();
  };
}

export function requirePaidMutation(options = {}) {
  const readMethods = new Set(options.readMethods || ["GET", "HEAD", "OPTIONS"]);
  const paid = requireEntitlementCapability(options.capability || ENTITLEMENT_CAPABILITIES.FINANCIAL_WRITE, options);
  return (req, res, next) => readMethods.has(String(req.method).toUpperCase()) ? next() : paid(req, res, next);
}
