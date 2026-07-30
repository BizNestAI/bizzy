// /src/api/tax/selfEmploymentTax.routes.js
import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import { computeSelfEmploymentTax } from "../../services/tax/selfEmployment/selfEmploymentTaxEngine.js";
import { getSelfEmploymentTaxRules } from "../../services/tax/selfEmployment/selfEmploymentRule.service.js";
import { evaluateTaxEntity } from "../../services/tax/entity/entityEngine.js";
import { getTaxProfile } from "../../services/tax/taxProfile.service.js";
import { normalizeEntityType, normalizeTaxElection } from "../../services/tax/taxDomain.js";
import { buildTaxRuleConfigSummary } from "../../services/tax/taxRuleConfig.repository.js";
import { validationError } from "../../services/tax/taxErrors.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalDate, optionalMoney, optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.post("/self-employment/calculate", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const body = req.body || {};
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(body.year ?? body.taxYear, new Date().getFullYear());
    const asOfDate = optionalDate(body.asOfDate, "asOfDate");
    const calculationMode = body.calculationMode || body.calculation_mode || "estimate";
    const scenarioOverrides = body.scenario === true || calculationMode === "scenario" ? validateScenarioOverrides(body) : null;
    if (!scenarioOverrides && hasProfileOverride(body)) {
      throw validationError("profile_override_requires_scenario", "Entity profile overrides require scenario=true or calculationMode=scenario.");
    }
    const entityContext = await evaluateTaxEntity({ supabase, businessId, taxYear, asOfDate, scenarioOverrides });
    const data = await computeSelfEmploymentTax({
      supabase,
      businessId,
      taxYear,
      asOfDate,
      entityContext,
      annualNetBusinessIncome: optionalMoney(body.annualNetBusinessIncome ?? body.annual_net_business_income, "annualNetBusinessIncome"),
      annualNetBusinessIncomeRange: normalizeRange(body.annualNetBusinessIncomeRange ?? body.annual_net_business_income_range),
      otherW2Wages: optionalMoney(body.otherW2Wages ?? body.other_w2_wages, "otherW2Wages"),
      calculationMode,
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "self_employment_tax_calculation_failed");
  }
});

router.get("/self-employment/rule-support", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query?.year ?? req.query?.taxYear, new Date().getFullYear());
    const profile = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
    const filingStatus = req.query?.filingStatus ?? req.query?.filing_status ?? profile?.filing_status;
    const rules = await getSelfEmploymentTaxRules({ supabase, taxYear, filingStatus });
    return sendTaxSuccess(res, {
      supportSummary: rules.supportSummary || buildTaxRuleConfigSummary(Object.values(rules.rules || {}).filter(Boolean)),
      ruleVersions: rules.ruleVersions,
      warnings: rules.warnings,
    });
  } catch (err) {
    return sendTaxError(res, err, "self_employment_rule_support_failed");
  }
});

function hasProfileOverride(body) {
  return body.entityType !== undefined ||
    body.entity_type !== undefined ||
    body.taxElection !== undefined ||
    body.tax_election !== undefined ||
    body.selfEmploymentTaxApplies !== undefined ||
    body.self_employment_tax_applies !== undefined;
}

function validateScenarioOverrides(body) {
  const overrides = {};
  if (body.entityType !== undefined || body.entity_type !== undefined) overrides.entity_type = normalizeEntityType(body.entityType ?? body.entity_type);
  if (body.taxElection !== undefined || body.tax_election !== undefined) overrides.tax_election = normalizeTaxElection(body.taxElection ?? body.tax_election);
  if (body.selfEmploymentTaxApplies !== undefined || body.self_employment_tax_applies !== undefined) {
    overrides.self_employment_tax_applies = Boolean(body.selfEmploymentTaxApplies ?? body.self_employment_tax_applies);
  }
  return Object.keys(overrides).length ? overrides : null;
}

function normalizeRange(value) {
  if (value == null) return null;
  if (Array.isArray(value) || typeof value !== "object") {
    throw validationError("invalid_income_range", "annualNetBusinessIncomeRange must be an object.", { field: "annualNetBusinessIncomeRange" });
  }
  return {
    low: rangeMoney(value.low, "annualNetBusinessIncomeRange.low"),
    base: value.base == null ? undefined : rangeMoney(value.base, "annualNetBusinessIncomeRange.base"),
    high: rangeMoney(value.high, "annualNetBusinessIncomeRange.high"),
  };
}

function rangeMoney(value, field) {
  const n = optionalMoney(value, field);
  if (n == null) throw validationError("invalid_income_range", "Income range values are required and must be finite numbers.", { field });
  return n;
}

export default router;
