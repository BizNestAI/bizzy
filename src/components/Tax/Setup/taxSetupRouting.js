import { firstStepForMissingFields } from "./taxSetupSteps.js";

const WORKFLOW_CODES = new Set([
  "profile_incomplete",
  "tax_profile_missing",
  "entity_unknown",
  "missing_entity_type",
  "missing_filing_status",
  "missing_primary_tax_state",
  "missing_prior_year_total_tax",
  "missing_s_corp_salary",
]);

export function resolveTaxSetupAction(action = {}, model = {}) {
  const code = action.code || action.id || model?.status?.setupState?.code || "";
  const route = action.route || action.href || "";

  if (code === "entity_unknown" || code === "missing_entity_type") {
    return { type: "workflow", initialStepId: "business_structure" };
  }
  if (WORKFLOW_CODES.has(code)) {
    const missing = model?.status?.setupState?.missingRequired || model?.profile?.completeness?.missingRequired || [];
    return { type: "workflow", initialStepId: firstStepForMissingFields(missing) };
  }
  if (code === "state_rules_missing" || code === "verify_state_rules") {
    return { type: "support_limitation", message: "State tax support is limited for this setup. Your profile does not need to change if the state is already correct." };
  }
  if (code === "payments_incomplete" || code === "tax_payment_changed") {
    return { type: "route", route: "/dashboard/tax/history" };
  }
  if (code === "reserve_setup_incomplete" || code === "tax_reserve_account") {
    return { type: "route", route: "/dashboard/tax/reserve" };
  }
  if (code === "classifications_missing" || route.includes("deductions")) {
    return { type: "route", route: "/dashboard/tax" };
  }
  if (route) return { type: "route", route };
  return { type: "ask_bizzi" };
}
