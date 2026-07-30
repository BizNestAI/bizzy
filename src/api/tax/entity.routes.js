// /src/api/tax/entity.routes.js
import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import { normalizeEntityType, normalizeMoney, normalizeTaxElection } from "../../services/tax/taxDomain.js";
import { getTaxProfile } from "../../services/tax/taxProfile.service.js";
import { evaluateTaxEntity } from "../../services/tax/entity/entityEngine.js";
import { resolveEntityPath } from "../../services/tax/entity/entityResolver.js";
import { getEntityRequirements } from "../../services/tax/entity/entityRequirements.js";
import { validationError } from "../../services/tax/taxErrors.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalDate, optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.get("/entity/evaluate", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query?.year ?? req.query?.taxYear, new Date().getFullYear());
    const asOfDate = optionalDate(req.query?.asOfDate, "asOfDate");
    const data = await evaluateTaxEntity({ supabase, businessId, taxYear, asOfDate });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "entity_evaluation_failed");
  }
});

router.post("/entity/evaluate", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const body = req.body || {};
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(body.year ?? body.taxYear, new Date().getFullYear());
    const asOfDate = optionalDate(body.asOfDate, "asOfDate");
    const scenarioOverrides = validateScenarioOverrides(body);
    const data = await evaluateTaxEntity({ supabase, businessId, taxYear, asOfDate, scenarioOverrides });
    return sendTaxSuccess(res, data, { scenario: Boolean(scenarioOverrides), persisted: false });
  } catch (err) {
    return sendTaxError(res, err, "entity_evaluation_failed");
  }
});

router.get("/entity/requirements", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query?.year ?? req.query?.taxYear, new Date().getFullYear());
    const profile = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
    const resolution = resolveEntityPath({ profile });
    const requirements = getEntityRequirements({ entityPath: resolution.entityPath, calculationType: "estimate" });
    return sendTaxSuccess(res, {
      entity: {
        entityType: resolution.entityType,
        taxElection: resolution.taxElection,
        entityPath: resolution.entityPath,
        supportStatus: resolution.supportStatus,
      },
      requirements,
      supportedEngines: {
        federalIncomeTax: !resolution.blockers.length && resolution.entityPath !== "unsupported" && resolution.entityPath !== "unknown",
        selfEmploymentTax: ["sole_proprietor", "single_member_llc_disregarded"].includes(resolution.entityPath),
        sCorp: resolution.entityPath === "s_corporation",
      },
      unsupportedScenarios: resolution.entityPath === "unsupported" ? resolution.warnings : [],
      blockers: resolution.blockers,
      warnings: resolution.warnings,
    });
  } catch (err) {
    return sendTaxError(res, err, "entity_requirements_failed");
  }
});

function validateScenarioOverrides(body) {
  const allowed = [
    "entityType",
    "entity_type",
    "taxElection",
    "tax_election",
    "ownerReasonableSalary",
    "owner_reasonable_salary",
    "ownerW2WagesYtd",
    "owner_w2_wages_ytd",
    "selfEmploymentTaxApplies",
    "self_employment_tax_applies",
  ];
  const present = allowed.some((field) => body[field] !== undefined);
  if (!present) return null;
  const overrides = {};
  if (body.entityType !== undefined || body.entity_type !== undefined) overrides.entity_type = normalizeEntityType(body.entityType ?? body.entity_type);
  if (body.taxElection !== undefined || body.tax_election !== undefined) overrides.tax_election = normalizeTaxElection(body.taxElection ?? body.tax_election);
  if (body.ownerReasonableSalary !== undefined || body.owner_reasonable_salary !== undefined) {
    overrides.owner_reasonable_salary = money(body.ownerReasonableSalary ?? body.owner_reasonable_salary, "ownerReasonableSalary");
  }
  if (body.ownerW2WagesYtd !== undefined || body.owner_w2_wages_ytd !== undefined) {
    overrides.owner_w2_wages_ytd = money(body.ownerW2WagesYtd ?? body.owner_w2_wages_ytd, "ownerW2WagesYtd");
  }
  if (body.selfEmploymentTaxApplies !== undefined || body.self_employment_tax_applies !== undefined) {
    overrides.self_employment_tax_applies = Boolean(body.selfEmploymentTaxApplies ?? body.self_employment_tax_applies);
  }
  return overrides;
}

function money(value, field) {
  const n = normalizeMoney(value);
  if (value != null && n == null) throw validationError(`invalid_${field}`, `${field} must be a finite number.`, { field });
  return n;
}

export default router;
