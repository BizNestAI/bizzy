// /src/api/tax/taxRuleConfig.routes.js
import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import { normalizeEntityType, normalizeFilingStatus, normalizeStateCode } from "../../services/tax/taxDomain.js";
import { getTaxProfile } from "../../services/tax/taxProfile.service.js";
import { getRequiredFederalTaxConfigSet, listTaxRuleConfigs, buildTaxRuleConfigSummary } from "../../services/tax/taxRuleConfig.repository.js";
import { getStateTaxConfigSet, listStateTaxRuleConfigs, buildStateSupportSummary } from "../../services/tax/stateTaxRule.repository.js";
import { listDeductionRules } from "../../services/tax/taxDeductionRule.repository.js";
import { validationError } from "../../services/tax/taxErrors.js";
import { optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.get("/rule-support", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query.year ?? req.query.taxYear, new Date().getFullYear());
    const profile = await getTaxProfile({ supabase, businessId, taxYear });
    const filingStatus = normalizeFilingStatus(req.query.filingStatus ?? req.query.filing_status ?? profile?.filing_status);
    const entityType = normalizeEntityType(req.query.entityType ?? req.query.entity_type ?? profile?.entity_type);
    const stateCode = normalizeStateCode(req.query.stateCode ?? req.query.state_code ?? profile?.primary_tax_state);

    if ((req.query.stateCode || req.query.state_code) && !stateCode) {
      throw validationError("invalid_state_code", "State code must be a valid US state or DC.", { field: "stateCode" });
    }

    const federal = await getRequiredFederalTaxConfigSet({ supabase, taxYear, filingStatus, entityType });
    const state = stateCode
      ? await getStateTaxConfigSet({ supabase, taxYear, stateCode, filingStatus, entityType })
      : {
          stateCode: null,
          supportLevel: "unsupported",
          missing: [{ ruleType: "individual_income_tax", code: "missing_primary_tax_state" }],
          warnings: [{ code: "missing_primary_tax_state", severity: "high", message: "Add a primary tax state to check state tax rule support." }],
          isUsableForEstimate: false,
          isUsableForReserve: false,
        };
    const deductionRules = await listDeductionRules({ supabase, businessId, taxYear, entityType, includeInactive: false });

    sendTaxSuccess(res, {
      federal: {
        supportLevel: federal.supportSummary.supportLevel,
        missingRules: federal.missing,
        warnings: federal.warnings,
      },
      state: {
        stateCode: state.stateCode,
        supportLevel: state.supportLevel,
        missingRules: state.missing,
        warnings: state.warnings,
      },
      deductions: {
        activeRuleCount: deductionRules.length,
        businessOverrideCount: deductionRules.filter((rule) => rule.business_id).length,
      },
      usableForEstimate: federal.missing.length === 0 && state.isUsableForEstimate,
      usableForReserve: federal.missing.length === 0 && state.isUsableForReserve,
    });
  } catch (err) {
    sendTaxError(res, err, "tax_rule_support_failed");
  }
});

router.get("/rule-configs/summary", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query.year ?? req.query.taxYear, new Date().getFullYear());
    const profile = await getTaxProfile({ supabase, businessId, taxYear });
    const filingStatus = normalizeFilingStatus(req.query.filingStatus ?? req.query.filing_status ?? profile?.filing_status);
    const entityType = normalizeEntityType(req.query.entityType ?? req.query.entity_type ?? profile?.entity_type);
    const stateCode = normalizeStateCode(req.query.stateCode ?? req.query.state_code ?? profile?.primary_tax_state);

    const federalConfigs = await listTaxRuleConfigs({ supabase, taxYear, filingStatus, entityType });
    const stateConfigs = stateCode ? await listStateTaxRuleConfigs({ supabase, taxYear, stateCode, filingStatus, entityType }) : [];
    const deductionRules = await listDeductionRules({ supabase, businessId, taxYear, entityType });

    sendTaxSuccess(res, {
      federal: buildTaxRuleConfigSummary(federalConfigs),
      state: buildStateSupportSummary(stateConfigs, { stateCode }),
      deductions: {
        activeRuleCount: deductionRules.length,
        businessOverrideCount: deductionRules.filter((rule) => rule.business_id).length,
        rules: deductionRules.map((rule) => ({
          id: rule.id,
          ruleCode: rule.rule_code,
          scope: rule.scope,
          taxCategory: rule.tax_category,
          deductibilityStatus: rule.deductibility_status,
          requiresReview: rule.requires_review,
          priority: rule.priority,
          version: rule.version,
          verifiedAt: rule.verified_at,
          updatedAt: rule.updated_at,
        })),
      },
    });
  } catch (err) {
    sendTaxError(res, err, "tax_rule_config_summary_failed");
  }
});

export default router;
