import { TAX_GL_ALIAS_RULES } from "./taxGlAliasRules.js";
import { normalizeQboGlAccountKey } from "./taxQboGlNormalizer.js";
const vehicleAccountKeys = new Set(TAX_GL_ALIAS_RULES.filter((rule) => rule.tax_category === "vehicle_expense").flatMap((rule) => rule.aliasKeys));

// Protection against bulk automation and finality are independent properties.
export const VEHICLE_WORKFLOW_AUTHORITY = Symbol("server-validated-vehicle-workflow");
export function vehicleRowMetadata(row = {}) { return row.metadata || row.raw?.metadata || row.raw?.classification?.metadata || { vehicle_id: row.vehicleId || row.raw?.vehicleId, decision_authority: row.decisionAuthority || row.raw?.decisionAuthority }; }
export function vehicleTaxTreatmentType(row = {}) {
  const types = [row.tax_treatment, row.raw?.tax_treatment, row.raw?.taxTreatment, row.raw?.raw?.tax_treatment, row.raw?.raw?.taxTreatment, row.taxTreatment]
    .map((value) => typeof value === "string" ? value : value?.type || "");
  return types.find((type) => type.startsWith("vehicle_")) || types.find(Boolean) || "";
}
export function isVehicleExpenseRow(row = {}) {
  const metadata = vehicleRowMetadata(row);
  const category = String(row.tax_category || row.taxCategory || row.raw?.tax_category || "").toLowerCase();
  if (metadata.vehicle_scope_released === true && !/vehicle|^auto$/.test(category)) return false;
  const treatment = vehicleTaxTreatmentType(row);
  return /vehicle|^auto$/.test(category) || String(treatment).startsWith("vehicle_") || vehicleAccountKeys.has(normalizeQboGlAccountKey(row.source_qbo_account_name || row.qboAccountName || row.bookkeeping_category || row.bookkeepingCategory || row.raw?.source_qbo_account_name || ""));
}
export function taxDecisionAuthority(row = {}) {
  const status = row.classification_status || row.classificationStatus || row.status;
  const metadata = vehicleRowMetadata(row);
  if (row.cpa_override || row.cpaOverride || ["cpa_confirmed", "accountant_reviewed"].includes(status)) return { type: "cpa", rank: 5, protected: true };
  if (status === "bizzi_operator_confirmed") return { type: "manual", rank: 4, protected: true };
  if (metadata.decision_authority === "vehicle_method" && !metadata.manual_vehicle_correction) return { type: "vehicle_method", rank: 2, protected: true };
  if (row.user_override || row.userOverride || status === "user_confirmed") return { type: "user", rank: 3, protected: true };
  return { type: (row.rule_code || row.ruleCode || row.source === "rule_engine") ? "suggestion" : "unresolved", rank: 1, protected: false };
}
export function vehicleTreatmentProvenanceLabel(row = {}) {
  const status = row.classification_status || row.classificationStatus || row.status;
  const requiresReview = ["needs_review", "needs_tax_review"].includes(status) || ((row.requires_review === true || row.requiresReview === true) && !["user_confirmed", "cpa_confirmed", "bizzi_operator_confirmed"].includes(status));
  if (requiresReview) return (row.source || row.classificationSource || row.raw?.source) === "rule_engine" ? "Suggested — needs confirmation" : "Needs Input";
  if (vehicleMethodNeedsConfirmation(row)) return "Needs Input";
  const authority = taxDecisionAuthority(row);
  if (authority.type === "cpa") return "Reviewed — CPA decision";
  const treatment = String(vehicleTaxTreatmentType(row));
  if (treatment.includes("standard_mileage")) return "Reviewed — covered by standard mileage";
  if (treatment.includes("no_business_use")) return "Reviewed — manually excluded";
  if (treatment.includes("actual_expense")) return `Reviewed — actual expenses at ${Number(row.deductible_percent ?? row.deductiblePercent ?? 0)}%`;
  if (treatment.includes("manual_excluded") || status === "excluded") return "Reviewed — manually excluded";
  return authority.protected ? "Reviewed — manual decision" : "Suggested — needs confirmation";
}

// Evidence is attached only by server reads of the persisted election/vehicle tables.
// A historical treatment string or protected/manual flag is never an election.
export function hasConfirmedVehicleElection(row = {}, method = null) {
  const evidence = row.vehicleElectionEvidence || row.raw?.vehicleElectionEvidence;
  const metadata = vehicleRowMetadata(row);
  const businessId = row.businessId || row.business_id || row.raw?.business_id;
  const taxYear = row.taxYear || row.tax_year || row.raw?.tax_year;
  const vehicleId = row.vehicleId || metadata.vehicle_id;
  const date = row.date || row.transaction_date || row.transactionDate;
  return Boolean(evidence?.id && evidence.electedBy && evidence.electedAt &&
    ["active", "finalized"].includes(evidence.status) && !evidence.supersededBy &&
    businessId && String(evidence.businessId) === String(businessId) &&
    Number(evidence.taxYear) === Number(taxYear) && vehicleId && String(evidence.vehicleId) === String(vehicleId) &&
    (!method || evidence.method === method) && date && evidence.effectiveStart <= date && evidence.effectiveEnd >= date);
}
export function vehicleMethodNeedsConfirmation(row = {}) {
  if (!isVehicleExpenseRow(row)) return false;
  const treatment = vehicleTaxTreatmentType(row);
  if (/manual_excluded|no_business_use/.test(treatment)) return false;
  const method = treatment.includes("standard_mileage") ? "standard_mileage" : treatment.includes("actual_expense") ? "actual_expenses" : null;
  return !hasConfirmedVehicleElection(row, method);
}
export function attachVehicleElectionEvidence(rows, { businessId, taxYear, workflows } = {}) {
  return rows.map(row => {
    const vehicleId = row.vehicleId || vehicleRowMetadata(row).vehicle_id;
    const vehicle = (workflows?.vehicles || []).find(v => String(v.id) === String(vehicleId));
    const election = vehicle?.status === "active" ? vehicle.election : null;
    return { ...row, businessId, taxYear, vehicleElectionEvidence: election ? {
      ...election, businessId, taxYear, vehicleId: vehicle.id,
    } : null };
  });
}
