// /src/api/tax/federalTax.routes.js
import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import { TAX_FILING_STATUSES, TAX_RULE_SUPPORT_LEVELS, normalizeEntityType, normalizeFilingStatus } from "../../services/tax/taxDomain.js";
import { getTaxProfile } from "../../services/tax/taxProfile.service.js";
import { getTaxRuleConfig, buildTaxRuleConfigSummary } from "../../services/tax/taxRuleConfig.repository.js";
import { FEDERAL_TAX_RULE_TYPES } from "../../services/tax/taxRuleTypes.js";
import { computeFederalIncomeTax } from "../../services/tax/federal/federalTaxEngine.js";
import { validationError } from "../../services/tax/taxErrors.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalDate, optionalMoney, optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.post("/federal/calculate", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const body = req.body || {};
    const taxYear = optionalTaxYear(body.year ?? body.taxYear, new Date().getFullYear());
    const asOfDate = optionalDate(body.asOfDate, "asOfDate");
    const profile = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
    const profileFilingStatus = normalizeFilingStatus(profile?.filing_status);
    const requestedFilingStatus = normalizeFilingStatus(body.filingStatus ?? body.filing_status ?? profileFilingStatus);
    if (!requestedFilingStatus || requestedFilingStatus === TAX_FILING_STATUSES.UNKNOWN) {
      throw validationError("missing_filing_status", "Federal calculation requires a known filing status.", { field: "filingStatus" });
    }
    if (profileFilingStatus && profileFilingStatus !== TAX_FILING_STATUSES.UNKNOWN && requestedFilingStatus !== profileFilingStatus && body.calculationMode !== "scenario") {
      throw validationError("filing_status_override_requires_scenario", "Filing status override requires calculationMode=scenario.", { field: "filingStatus" });
    }
    const data = await computeFederalIncomeTax({
      supabase,
      businessId,
      taxYear,
      asOfDate,
      filingStatus: requestedFilingStatus,
      entityType: normalizeEntityType(body.entityType ?? body.entity_type ?? profile?.entity_type),
      annualBusinessTaxableIncome: optionalMoney(body.annualBusinessTaxableIncome ?? body.annual_business_taxable_income, "annualBusinessTaxableIncome") ?? 0,
      annualBusinessTaxableIncomeRange: normalizeRange(body.annualBusinessTaxableIncomeRange ?? body.annual_business_taxable_income_range),
      otherIncome: body.otherIncome ?? body.other_income ?? null,
      aboveTheLineAdjustments: optionalMoney(body.aboveTheLineAdjustments ?? body.above_the_line_adjustments, "aboveTheLineAdjustments") ?? 0,
      qbiDeduction: optionalMoney(body.qbiDeduction ?? body.qbi_deduction, "qbiDeduction") ?? 0,
      calculationMode: body.calculationMode || body.calculation_mode || "estimate",
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "federal_tax_calculation_failed");
  }
});

router.get("/federal/rule-support", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query?.year ?? req.query?.taxYear, new Date().getFullYear());
    const profile = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
    const filingStatus = normalizeFilingStatus(req.query?.filingStatus ?? req.query?.filing_status ?? profile?.filing_status);
    const entityType = normalizeEntityType(profile?.entity_type);
    const rows = [];
    for (const ruleType of [FEDERAL_TAX_RULE_TYPES.FEDERAL_INCOME_TAX_BRACKETS, FEDERAL_TAX_RULE_TYPES.STANDARD_DEDUCTION]) {
      try {
        rows.push(await getTaxRuleConfig({
          supabase,
          taxYear,
          ruleType,
          filingStatus,
          entityType,
          minimumSupportLevel: TAX_RULE_SUPPORT_LEVELS.VERIFIED,
        }));
      } catch (err) {
        rows.push({ rule_type: ruleType, support_level: TAX_RULE_SUPPORT_LEVELS.UNSUPPORTED, error: err.code });
      }
    }
    return sendTaxSuccess(res, buildTaxRuleConfigSummary(rows));
  } catch (err) {
    return sendTaxError(res, err, "federal_rule_support_failed");
  }
});

function normalizeRange(value) {
  if (value == null) return null;
  if (Array.isArray(value) || typeof value !== "object") {
    throw validationError("invalid_income_range", "annualBusinessTaxableIncomeRange must be an object.", { field: "annualBusinessTaxableIncomeRange" });
  }
  return {
    low: normalizeRangeValue(value.low, "annualBusinessTaxableIncomeRange.low"),
    base: normalizeRangeValue(value.base, "annualBusinessTaxableIncomeRange.base"),
    high: normalizeRangeValue(value.high, "annualBusinessTaxableIncomeRange.high"),
  };
}

function normalizeRangeValue(value, field) {
  if (value == null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) throw validationError("invalid_income_range", "Income range values must be finite numbers.", { field });
  return n;
}

export default router;
