// /src/api/tax/taxRouteUtils.js
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import {
  TAX_ERROR_CODES,
  forbiddenBusinessError,
  notFoundError,
  unauthorizedError,
  validationError,
} from "../../services/tax/taxErrors.js";
import { isValidUuid } from "../../services/tax/taxDomain.js";
import { validateTaxCalculationRequest, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError } from "./taxHttp.js";

/**
 * Return the authenticated Supabase user id attached by requireAuth.
 */
export function getAuthenticatedUserId(req) {
  return req?.user?.id || req?.user?.sub || req?.user?.user_id || null;
}

/**
 * Resolve business ID in priority order:
 * 1. route param businessId
 * 2. body businessId/business_id
 * 3. query businessId/business_id
 * 4. request-scoped businessId / authenticated business_id
 */
export function resolveTaxBusinessId(req) {
  const raw =
    req?.params?.businessId ||
    req?.body?.businessId ||
    req?.body?.business_id ||
    req?.query?.businessId ||
    req?.query?.business_id ||
    req?.businessId ||
    req?.user?.business_id ||
    null;

  if (!raw) {
    throw validationError(TAX_ERROR_CODES.MISSING_BUSINESS_ID, "businessId is required.", { field: "businessId" });
  }
  if (!isValidUuid(String(raw))) {
    throw validationError("invalid_businessId", "businessId must be a valid UUID.", { field: "businessId" });
  }
  return String(raw);
}

/**
 * Check business_profiles ownership for the authenticated user.
 * The current canonical minimum rule is business_profiles.id + user_id.
 */
export async function assertTaxBusinessAccess({ req, businessId, supabase = defaultSupabase }) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) throw unauthorizedError();
  if (!businessId) {
    throw validationError(TAX_ERROR_CODES.MISSING_BUSINESS_ID, "businessId is required.", { field: "businessId" });
  }

  req.__taxBusinessAccessCache ||= new Map();
  const cacheKey = `${userId}:${businessId}`;
  if (req.__taxBusinessAccessCache.has(cacheKey)) return req.__taxBusinessAccessCache.get(cacheKey);

  const { data, error } = await supabase
    .from("business_profiles")
    .select("id,user_id")
    .eq("id", businessId)
    .maybeSingle();

  if (error) {
    throw validationError("business_lookup_failed", "Could not verify business access.", { businessId });
  }
  if (!data) {
    throw notFoundError("business_not_found", "Business was not found.", { businessId });
  }
  if (String(data.user_id) !== String(userId)) {
    throw forbiddenBusinessError("You do not have access to this business.", { businessId });
  }

  const context = { businessId: data.id, userId };
  req.__taxBusinessAccessCache.set(cacheKey, context);
  return context;
}

export function requireTaxBusiness(req, res, next) {
  getTaxRequestContext(req, res)
    .then((ctx) => {
      req.tax = ctx;
      next();
    })
    .catch((err) => sendTaxError(res, err, "tax_request_failed"));
}

export async function getTaxRequestContext(req, _res, options = {}) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) throw unauthorizedError();

  const calculation = options.calculation === true ? validateTaxCalculationRequest(req) : null;
  const businessId = calculation?.businessId || validateBusinessIdInput(req);
  await assertTaxBusinessAccess({ req, businessId, supabase: options.supabase || defaultSupabase });

  return {
    userId,
    businessId,
    taxYear: calculation?.taxYear ?? options.taxYear ?? null,
    requestId: req?.id || req?.headers?.["x-request-id"] || null,
    calculation,
  };
}
