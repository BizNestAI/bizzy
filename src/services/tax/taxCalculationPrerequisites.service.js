import { getTaxRuleConfig } from "./taxRuleConfig.repository.js";
import { FEDERAL_TAX_RULE_TYPES } from "./taxRuleTypes.js";
import { TAX_JURISDICTIONS, TAX_RULE_SUPPORT_LEVELS } from "./taxDomain.js";
import { getTaxProfile, computeTaxProfileCompleteness } from "./taxProfile.service.js";
import { countPostedTransactionsForTax } from "./taxPostedTransaction.repository.js";
import {
  getTaxClassificationLifecycleStatus,
  mapClassificationStatusToCalculationBlocker,
} from "./taxClassificationRun.service.js";

export async function evaluateTaxCalculationPrerequisites({
  supabase,
  businessId,
  taxYear,
  asOfDate = new Date().toISOString().slice(0, 10),
} = {}) {
  const profile = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
  const completeness = computeTaxProfileCompleteness(profile);
  if (!profile) return blocked("profile_required", { profile, completeness });
  if (!completeness.isCompleteForEstimate) return blocked("profile_draft", { profile, completeness, missingFields: completeness.missingRequired });

  const eligiblePostedCount = await countPostedTransactionsForTax({ supabase, businessId, taxYear });
  if (eligiblePostedCount <= 0) return blocked("pnl_authority_missing", { profile, completeness, eligiblePostedCount });

  const classification = await getTaxClassificationLifecycleStatus({ supabase, businessId, taxYear });
  const classificationBlocker = mapClassificationStatusToCalculationBlocker(classification.classificationStatus);
  if (classificationBlocker) return blocked(classificationBlocker, { profile, completeness, classification, eligiblePostedCount });

  try {
    await getTaxRuleConfig({
      supabase,
      taxYear,
      jurisdiction: TAX_JURISDICTIONS.FEDERAL,
      ruleType: FEDERAL_TAX_RULE_TYPES.STANDARD_DEDUCTION,
      filingStatus: profile.filing_status,
      entityType: profile.entity_type,
      asOfDate,
      minimumSupportLevel: TAX_RULE_SUPPORT_LEVELS.SIMPLIFIED,
    });
  } catch (error) {
    return blocked(error?.code === "tax_rule_config_missing" ? "standard_deduction_rule_missing" : "tax_rule_config_unavailable", {
      profile,
      completeness,
      classification,
      eligiblePostedCount,
      errorCode: error?.code || "tax_rule_config_unavailable",
    });
  }

  return {
    ready: true,
    blocker: null,
    profile,
    completeness,
    classification,
    eligiblePostedCount,
  };
}

function blocked(blocker, context = {}) {
  return {
    ready: false,
    blocker,
    ...context,
  };
}
