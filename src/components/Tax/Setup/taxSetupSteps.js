import { isSCorp, isSoleOrDisregarded } from "./taxProfileFields.js";

export const TAX_SETUP_STEP_IDS = [
  "business_structure",
  "filing_context",
  "entity_details",
  "payment_planning",
  "tax_memory",
  "review",
];

export const TAX_SETUP_STEPS = [
  { id: "business_structure", title: "Business tax structure", fields: ["entity_type", "tax_election"] },
  { id: "filing_context", title: "Personal filing context", fields: ["filing_status", "primary_tax_state", "accounting_method"] },
  { id: "entity_details", title: "Entity-specific information", fields: ["self_employment_tax_applies", "qbi_eligible", "owner_reasonable_salary", "owner_w2_wages_ytd", "federal_withholding_ytd", "state_withholding_ytd", "health_insurance_deduction_ytd", "retirement_contributions_ytd", "hsa_contributions_ytd"] },
  { id: "payment_planning", title: "Estimated-payment planning", fields: ["safe_harbor_method", "prior_year_total_tax", "prior_year_agi", "reserve_buffer_percent"] },
  { id: "tax_memory", title: "Tax memory preferences", fields: [] },
  { id: "review", title: "Review", fields: [] },
];

export function getTaxSetupSteps(values = {}) {
  return TAX_SETUP_STEPS.map((step) => ({
    ...step,
    activeFields: getStepFields(step.id, values),
  }));
}

export function getStepFields(stepId, values = {}) {
  const step = TAX_SETUP_STEPS.find((item) => item.id === stepId);
  if (!step) return [];
  if (stepId !== "entity_details") return step.fields;
  if (isSCorp(values)) {
    return step.fields.filter((field) => field !== "self_employment_tax_applies");
  }
  if (isSoleOrDisregarded(values)) {
    return step.fields.filter((field) => !["owner_reasonable_salary", "owner_w2_wages_ytd"].includes(field));
  }
  return ["qbi_eligible", "federal_withholding_ytd", "state_withholding_ytd"];
}

export function stepIndex(stepId) {
  const index = TAX_SETUP_STEP_IDS.indexOf(stepId);
  return index >= 0 ? index : 0;
}

export function nextStepId(stepId) {
  return TAX_SETUP_STEP_IDS[Math.min(TAX_SETUP_STEP_IDS.length - 1, stepIndex(stepId) + 1)];
}

export function previousStepId(stepId) {
  return TAX_SETUP_STEP_IDS[Math.max(0, stepIndex(stepId) - 1)];
}

export function firstStepForMissingFields(missing = []) {
  const missingSet = new Set(missing || []);
  const match = TAX_SETUP_STEPS.find((step) => step.fields.some((field) => missingSet.has(field)));
  return match?.id || "business_structure";
}
