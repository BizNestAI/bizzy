// /src/services/tax/entity/entityRequirements.js
import { ENTITY_PATHS } from "./entityDomain.js";

const BASE_REQUIRED = Object.freeze(["filing_status", "primary_tax_state", "accounting_method", "business_taxable_income"]);
const BASE_RECOMMENDED = Object.freeze(["prior_year_total_tax", "federal_estimated_payments_ytd", "state_estimated_payments_ytd", "health_insurance_deduction_ytd", "retirement_contributions_ytd", "qbi_eligible", "other_income"]);

export function getEntityRequirements({ entityPath, calculationType = "estimate" } = {}) {
  switch (entityPath) {
    case ENTITY_PATHS.SOLE_PROPRIETOR:
      return build({
        entityPath,
        calculationType,
        requiredInputs: [...BASE_REQUIRED, "self_employment_tax_applies"],
        recommendedInputs: [...BASE_RECOMMENDED],
        entitySpecificRequirements: ["schedule_c_like_business_income", "self_employment_tax_configuration"],
      });
    case ENTITY_PATHS.SINGLE_MEMBER_LLC_DISREGARDED:
      return build({
        entityPath,
        calculationType,
        requiredInputs: [...BASE_REQUIRED, "tax_election", "self_employment_tax_applies"],
        recommendedInputs: [...BASE_RECOMMENDED],
        entitySpecificRequirements: ["confirmed_disregarded_entity_election", "schedule_c_like_business_income", "self_employment_tax_configuration"],
      });
    case ENTITY_PATHS.S_CORPORATION:
      return build({
        entityPath,
        calculationType,
        requiredInputs: [
          ...BASE_REQUIRED,
          "tax_election",
          "owner_reasonable_salary",
          "owner_w2_wages_ytd",
          "federal_withholding_ytd",
          "state_withholding_ytd",
          "pass_through_taxable_income",
        ],
        recommendedInputs: ["payroll_tax_records", "distributions_ytd", "health_insurance_treatment", "retirement_contributions_ytd", "prior_year_total_tax", "state_s_corp_rules"],
        entitySpecificRequirements: ["confirmed_s_corp_election", "owner_wage_and_withholding_inputs", "payroll_tax_diagnostics"],
      });
    case ENTITY_PATHS.UNKNOWN:
      return build({
        entityPath,
        calculationType,
        requiredInputs: ["entity_type", "tax_election"],
        recommendedInputs: [],
        entitySpecificRequirements: ["confirm_entity_type_and_tax_election"],
      });
    case ENTITY_PATHS.UNSUPPORTED:
    default:
      return build({
        entityPath: entityPath || ENTITY_PATHS.UNSUPPORTED,
        calculationType,
        requiredInputs: ["supported_entity_type"],
        recommendedInputs: [],
        entitySpecificRequirements: ["unsupported_entity_requires_cpa_or_future_engine"],
      });
  }
}

export function findMissingEntityInputs({ requirements, profile = {}, taxableIncomeContext = null, projectionContext = null } = {}) {
  const missingInputs = [];
  for (const field of requirements?.requiredInputs || []) {
    if (!hasRequirementValue(field, profile, taxableIncomeContext, projectionContext)) missingInputs.push(field);
  }
  return [...new Set(missingInputs)];
}

function build({ entityPath, calculationType, requiredInputs, recommendedInputs, entitySpecificRequirements }) {
  return {
    entityPath,
    calculationType,
    requiredInputs,
    recommendedInputs,
    entitySpecificRequirements,
  };
}

function hasRequirementValue(field, profile, taxableIncomeContext, projectionContext) {
  const directMap = {
    entity_type: "entity_type",
    tax_election: "tax_election",
    filing_status: "filing_status",
    primary_tax_state: "primary_tax_state",
    accounting_method: "accounting_method",
    self_employment_tax_applies: "self_employment_tax_applies",
    owner_reasonable_salary: "owner_reasonable_salary",
    owner_w2_wages_ytd: "owner_w2_wages_ytd",
    federal_withholding_ytd: "federal_withholding_ytd",
    state_withholding_ytd: "state_withholding_ytd",
    prior_year_total_tax: "prior_year_total_tax",
  };
  if (field === "business_taxable_income" || field === "pass_through_taxable_income") {
    return taxableIncomeContext?.businessTaxableIncome?.finalBusinessTaxableIncome != null ||
      projectionContext?.projectedAnnual?.taxableBusinessIncome != null;
  }
  if (field === "supported_entity_type") return false;
  const profileField = directMap[field] || field;
  const value = profile?.[profileField];
  return value != null && value !== "" && value !== "unknown";
}
