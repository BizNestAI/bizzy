// /src/api/tax/taxProfile.routes.js
import { Router } from "express";
import { supabase } from "../../services/supabaseAdmin.js";
import {
  archiveTaxProfile,
  buildTaxProfileWarnings,
  computeTaxProfileCompleteness,
  computeTaxProfileReadiness,
  createTaxProfile,
  getOrInitializeTaxProfile,
  getTaxProfile,
  assertTaxProfileMutableBody,
  sanitizeTaxProfileForClient,
  upsertTaxProfile,
} from "../../services/tax/taxProfile.service.js";
import { TAX_CHANGE_TYPES, emitTaxDataChanged } from "../../services/tax/taxChangeEvents.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalTaxYear, requireUuid, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.get("/profile", async (req, res) => {
  setTaxNoStore(res);
  try {
    const { businessId, taxYear } = await authorizedProfileContext(req);
    const profile = await getTaxProfile({ supabase, businessId, taxYear });
    const completeness = computeTaxProfileCompleteness(profile);
    return sendTaxSuccess(res, {
      profile,
      completeness,
      readiness: computeTaxProfileReadiness(profile),
      warnings: buildTaxProfileWarnings(profile),
      suggestedDefaults: profile?.metadata?.suggestedDefaults || {},
    });
  } catch (err) {
    return sendTaxError(res, err, "tax_profile_request_failed");
  }
});

router.post("/profile", async (req, res) => {
  setTaxNoStore(res);
  try {
    const { businessId, taxYear } = await authorizedProfileContext(req);
    assertTaxProfileMutableBody(req.body || {});
    const profile = await createTaxProfile({
      supabase,
      businessId,
      taxYear,
      input: req.body || {},
      userId: req.user.id,
    });
    emitTaxDataChanged({ businessId, taxYear, changeType: TAX_CHANGE_TYPES.PROFILE_CREATED, entityId: profile.id, userId: req.user.id });
    return sendTaxSuccess(res, {
      profile: sanitizeTaxProfileForClient(profile),
      completeness: computeTaxProfileCompleteness(profile),
      readiness: computeTaxProfileReadiness(profile),
      warnings: buildTaxProfileWarnings(profile),
    });
  } catch (err) {
    return sendTaxError(res, err, "tax_profile_create_failed");
  }
});

router.patch("/profile", async (req, res) => {
  setTaxNoStore(res);
  try {
    const { businessId, taxYear } = await authorizedProfileContext(req);
    assertTaxProfileMutableBody(req.body || {});
    const before = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
    const profile = await upsertTaxProfile({
      supabase,
      businessId,
      taxYear,
      input: req.body || {},
      userId: req.user.id,
      source: req.body?.source,
    });
    emitTaxDataChanged({
      businessId,
      taxYear,
      changeType: before ? TAX_CHANGE_TYPES.PROFILE_UPDATED : TAX_CHANGE_TYPES.PROFILE_CREATED,
      entityId: profile.id,
      userId: req.user.id,
      metadata: {
        source: req.body?.source || profile?.source || null,
        changedFields: changedFields(before, profile),
        before: pickProfileEventFields(before),
        after: pickProfileEventFields(profile),
      },
    });
    return sendTaxSuccess(res, {
      profile: sanitizeTaxProfileForClient(profile),
      completeness: computeTaxProfileCompleteness(profile),
      readiness: computeTaxProfileReadiness(profile),
      warnings: buildTaxProfileWarnings(profile),
    });
  } catch (err) {
    return sendTaxError(res, err, "tax_profile_update_failed");
  }
});

router.post("/profile/initialize", async (req, res) => {
  setTaxNoStore(res);
  try {
    const { businessId, taxYear } = await authorizedProfileContext(req);
    assertTaxProfileMutableBody(req.body || {});
    const profile = await getOrInitializeTaxProfile({
      supabase,
      businessId,
      taxYear,
      userId: req.user.id,
      source: req.body?.source || "system",
    });
    emitTaxDataChanged({ businessId, taxYear, changeType: TAX_CHANGE_TYPES.PROFILE_CREATED, entityId: profile.id, userId: req.user.id });
    return sendTaxSuccess(res, {
      profile,
      completeness: computeTaxProfileCompleteness(profile),
      readiness: computeTaxProfileReadiness(profile),
      warnings: buildTaxProfileWarnings(profile),
      suggestedDefaults: profile?.metadata?.suggestedDefaults || {},
    });
  } catch (err) {
    return sendTaxError(res, err, "tax_profile_initialize_failed");
  }
});

router.post("/profile/archive", async (req, res) => {
  setTaxNoStore(res);
  try {
    const { businessId, taxYear } = await authorizedProfileContext(req);
    const profile = await archiveTaxProfile({ supabase, businessId, taxYear, userId: req.user.id });
    emitTaxDataChanged({ businessId, taxYear, changeType: TAX_CHANGE_TYPES.PROFILE_ARCHIVED, entityId: profile.id, userId: req.user.id });
    return sendTaxSuccess(res, profile);
  } catch (err) {
    return sendTaxError(res, err, "tax_profile_archive_failed");
  }
});

router.get("/profile/years", async (req, res) => {
  setTaxNoStore(res);
  try {
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const { data, error } = await supabase
      .from("tax_profiles")
      .select("tax_year,profile_status,updated_at")
      .eq("business_id", businessId)
      .order("tax_year", { ascending: false });
    if (error) throw error;
    return sendTaxSuccess(res, { years: data || [] });
  } catch (err) {
    return sendTaxError(res, err, "tax_profile_years_failed");
  }
});

async function authorizedProfileContext(req) {
  const businessId = validateProfileBusinessIdInput(req);
  const src = req.query || {};
  const taxYear = optionalTaxYear(src?.year ?? src?.taxYear, new Date().getFullYear());
  await assertTaxBusinessAccess({ req, businessId, supabase });
  return { businessId, taxYear };
}

function validateProfileBusinessIdInput(req) {
  const value = req?.params?.businessId ?? req?.query?.businessId ?? req?.query?.business_id ?? req?.businessId ?? req?.user?.business_id;
  return requireUuid(value, "businessId");
}

function changedFields(before = {}, after = {}) {
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter((field) => before?.[field] !== after?.[field]);
}

function pickProfileEventFields(profile = {}) {
  const fields = [
    "entity_type",
    "tax_election",
    "filing_status",
    "primary_tax_state",
    "accounting_method",
    "safe_harbor_method",
    "self_employment_tax_applies",
    "prior_year_total_tax",
    "prior_year_agi",
    "source",
  ];
  return Object.fromEntries(fields.map((field) => [field, profile?.[field]]).filter(([, value]) => value !== undefined));
}

export default router;
