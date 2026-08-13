import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";

export const TENANT_AUTH_CODES = Object.freeze({
  AUTH_REQUIRED: "AUTH_REQUIRED",
  BUSINESS_REQUIRED: "BUSINESS_REQUIRED",
  BUSINESS_INVALID: "BUSINESS_INVALID",
  BUSINESS_NOT_FOUND: "BUSINESS_NOT_FOUND",
  BUSINESS_ACCESS_DENIED: "BUSINESS_ACCESS_DENIED",
  AMBIGUOUS_BUSINESS_CONTEXT: "AMBIGUOUS_BUSINESS_CONTEXT",
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantAuthError extends Error {
  constructor(code, message, status = 403) {
    super(message || code);
    this.name = "TenantAuthError";
    this.code = code;
    this.status = status;
  }
}

export function getAuthenticatedUserId(req) {
  return req?.auth?.userId || req?.user?.id || req?.user?.sub || req?.user?.user_id || null;
}

function compactTenantSources(req) {
  const sources = [
    ["params.businessId", req?.params?.businessId],
    ["params.business_id", req?.params?.business_id],
    ["body.businessId", req?.body?.businessId],
    ["body.business_id", req?.body?.business_id],
    ["query.businessId", req?.query?.businessId],
    ["query.business_id", req?.query?.business_id],
    ["header.x-business-id", req?.headers?.["x-business-id"]],
  ];
  return sources
    .map(([source, value]) => ({ source, value: value == null ? "" : String(value).trim() }))
    .filter((entry) => entry.value);
}

export function getRequestedBusinessId(req, { required = true } = {}) {
  const sources = compactTenantSources(req);
  if (!sources.length) {
    if (!required) return null;
    throw new TenantAuthError(
      TENANT_AUTH_CODES.BUSINESS_REQUIRED,
      "Business id is required.",
      400
    );
  }

  const values = new Set(sources.map((entry) => entry.value));
  if (values.size > 1) {
    throw new TenantAuthError(
      TENANT_AUTH_CODES.AMBIGUOUS_BUSINESS_CONTEXT,
      "Conflicting business ids were provided.",
      400
    );
  }

  const businessId = sources[0].value;
  if (!UUID_RE.test(businessId)) {
    throw new TenantAuthError(
      TENANT_AUTH_CODES.BUSINESS_INVALID,
      "Business id must be a valid UUID.",
      400
    );
  }
  return businessId;
}

async function hasBusinessMembership({ supabase, userId, businessId }) {
  const { data, error } = await supabase
    .from("user_business_link")
    .select("user_id,business_id")
    .eq("user_id", userId)
    .eq("business_id", businessId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new TenantAuthError(
      TENANT_AUTH_CODES.BUSINESS_ACCESS_DENIED,
      "Could not verify business access.",
      403
    );
  }
  return Boolean(data);
}

export async function resolveAuthorizedBusiness({
  req,
  businessId = undefined,
  supabase = defaultSupabase,
} = {}) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) {
    throw new TenantAuthError(TENANT_AUTH_CODES.AUTH_REQUIRED, "Authentication is required.", 401);
  }

  const requestedBusinessId = businessId || getRequestedBusinessId(req);
  req.__businessAccessCache ||= new Map();
  const cacheKey = `${userId}:${requestedBusinessId}`;
  if (req.__businessAccessCache.has(cacheKey)) return req.__businessAccessCache.get(cacheKey);

  const { data: business, error } = await supabase
    .from("business_profiles")
    .select("id,user_id,business_name")
    .eq("id", requestedBusinessId)
    .maybeSingle();

  if (error) {
    throw new TenantAuthError(
      TENANT_AUTH_CODES.BUSINESS_ACCESS_DENIED,
      "Could not verify business access.",
      403
    );
  }
  if (!business) {
    throw new TenantAuthError(TENANT_AUTH_CODES.BUSINESS_NOT_FOUND, "Business was not found.", 404);
  }

  const ownerUserId = business.user_id || null;
  const isOwner = ownerUserId && String(ownerUserId) === String(userId);
  const isMember = isOwner
    ? false
    : await hasBusinessMembership({ supabase, userId, businessId: requestedBusinessId });

  if (!isOwner && !isMember) {
    throw new TenantAuthError(
      TENANT_AUTH_CODES.BUSINESS_ACCESS_DENIED,
      "Business access denied.",
      403
    );
  }

  const context = {
    id: business.id,
    businessId: business.id,
    ownerUserId,
    businessName: business.business_name || null,
    accessVia: isOwner ? "owner" : "membership",
  };
  req.__businessAccessCache.set(cacheKey, context);
  return context;
}

export function attachAuthorizedBusiness(req, business) {
  req.business = {
    id: business.id,
    ownerUserId: business.ownerUserId || null,
    businessName: business.businessName || null,
    accessVia: business.accessVia || null,
  };
  req.auth ||= {};
  req.auth.businessId = business.id;

  // Compatibility only for legacy controllers. This field is attached only
  // after DB authorization; requireAuth never copies client tenant headers.
  req.user ||= {};
  req.user.id ||= req.auth.userId;
  req.user.business_id = business.id;
}

export function sendTenantAuthError(res, err) {
  const status = Number(err?.status || 500);
  const code = err?.code || "BUSINESS_ACCESS_DENIED";
  return res.status(status).json({ ok: false, error: code, code });
}

export function requireBusinessAccess(options = {}) {
  return async function requireBusinessAccessMiddleware(req, res, next) {
    try {
      const business = await resolveAuthorizedBusiness({
        req,
        businessId: options.businessId,
        supabase: options.supabase || defaultSupabase,
      });
      attachAuthorizedBusiness(req, business);
      return next();
    } catch (err) {
      if (err instanceof TenantAuthError) return sendTenantAuthError(res, err);
      console.error("[tenantAuth] authorization failed:", err?.code || err?.name || "ERR", err?.message);
      return sendTenantAuthError(
        res,
        new TenantAuthError(TENANT_AUTH_CODES.BUSINESS_ACCESS_DENIED, "Business access denied.", 403)
      );
    }
  };
}
