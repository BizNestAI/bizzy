import { conflictError, dataUnavailableError, forbiddenBusinessError, validationError } from "./taxErrors.js";
import { isValidUuid } from "./taxDomain.js";
import { vehicleTreatmentProvenanceLabel } from "./taxVehicleAuthority.js";

function customer(actor) {
  if (!actor.userId || actor.source !== "user" || actor.tenantMode === "admin_view") throw forbiddenBusinessError("Customer authorization is required.");
}
function uuid(value, field) {
  if (!isValidUuid(String(value || ""))) throw validationError("vehicle_command_invalid", `${field} must be a valid ID.`);
  return String(value);
}
export function normalizeVehicleCommand(input = {}) {
  if (!["amend", "assign", "exclude", "recategorize", "correct_mileage"].includes(input.action)) throw validationError("vehicle_command_invalid", "Choose a supported vehicle correction.");
  const reason = String(input.reason || "").trim();
  if (reason.length < 3 || reason.length > 1000) throw validationError("vehicle_command_reason_required", "Enter a reason between 3 and 1000 characters.");
  const transactionIds = input.transactionIds == null ? [] : input.transactionIds;
  if (!Array.isArray(transactionIds) || transactionIds.length > 1000 || new Set(transactionIds).size !== transactionIds.length) throw validationError("vehicle_scope_invalid", "Choose unique transactions in the current business.");
  if (typeof input.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.sourceFingerprint)) throw validationError("vehicle_projection_required", "Refresh the Tax workspace before changing treatment.");
  return {
    action: input.action, reason, projectionId: uuid(input.projectionId, "Projection"), sourceFingerprint: input.sourceFingerprint,
    vehicleId: input.vehicleId ? uuid(input.vehicleId, "Vehicle") : null,
    transactionIds: transactionIds.map((id) => uuid(id, "Transaction")),
    primaryVehicle: input.primaryVehicle === true, newVehicle: input.newVehicle === true,
    displayName: String(input.displayName || "").trim().slice(0, 120),
    method: input.method === "actual_expense" ? "actual_expenses" : input.method,
    businessUsePercent: input.businessUsePercent,
    ownershipType: ["owned", "leased"].includes(input.ownershipType) ? input.ownershipType : null,
    allBusinessConfirmed: input.allBusinessConfirmed === true, confirmYearRecalculation: input.confirmYearRecalculation === true,
    supersedeManual: input.supersedeManual === true, recordsConfirmed: input.recordsConfirmed === true,
    eligibility: Object.fromEntries(["ownedOrLeased", "firstYearAvailable", "fleetUnderFive", "noDisallowedDepreciation"].map((key) => [key, input.eligibility?.[key] === true])),
    entries: Array.isArray(input.entries) ? input.entries.map((entry) => ({ periodStart: entry.periodStart, periodEnd: entry.periodEnd, businessMiles: entry.businessMiles })) : [],
  };
}
export async function previewVehicleCommand({ supabase, businessId, taxYear, actor, input }) {
  customer(actor);
  const choices = normalizeVehicleCommand(input);
  const { data, error } = await supabase.rpc("preview_tax_vehicle_command", { b: businessId, y: Number(taxYear), u: actor.userId, i: choices });
  if (error) throw vehicleCommandError(error);
  const plan = data.plan;
  return { previewId: data.previewId, expiresInSeconds: data.expiresInSeconds, affectedCount: plan.affectedCount,
    beforeDeduction: plan.beforeDeduction, afterDeduction: plan.afterDeduction, mileageDeduction: plan.mileageDeduction, beforeMileageDeduction: plan.beforeMileageDeduction, afterMileageDeduction: plan.afterMileageDeduction,
    vehicleId: plan.vehicleId, skipped: plan.skipped, label: plan.label,
    rows: plan.rows.map((row) => ({ transactionId: row.transaction_id, date: row.transaction_date,
      accountName: row.source_qbo_account_name, signedAmount: Number(row.book_amount), previousDeductibleAmount: Number(row.previousDeductibleAmount),
      deductibleAmount: Number(row.deductible_amount), treatment: vehicleTreatmentProvenanceLabel(row) })),
  };
}
export async function applyVehicleCommand({ supabase, businessId, taxYear, actor, input }) {
  customer(actor);
  const previewId = uuid(input.previewId, "Preview");
  const key = String(input.idempotencyKey || "");
  if (key.length < 16 || key.length > 200) throw validationError("vehicle_command_key_invalid", "A valid retry key is required.");
  const { data, error } = await supabase.rpc("apply_tax_vehicle_command", { b: businessId, y: Number(taxYear), u: actor.userId, p_id: previewId, k: key });
  if (error) throw vehicleCommandError(error);
  return data;
}
export function vehicleCommandError(error) {
  if (["42P01", "42883", "PGRST202", "PGRST205"].includes(error.code)) return dataUnavailableError("Vehicle corrections require the vehicle-authority migration. Your current treatment was preserved.", { action: "contact_support" });
  const token = String(error.message || "").trim();
  const code = /^[a-z][a-z0-9_]+$/.test(token) ? token : "vehicle_command_failed";
  const messages = {
    vehicle_source_evidence_changed: "A posted source transaction changed, was archived, or moved outside this tax year. Refresh and preview again. Nothing was saved.",
    vehicle_scope_outside_matrix: "Select transactions in the current deductions matrix. Refresh the workspace or resolve their bookkeeping evidence first.",
    vehicle_ownership_history_conflict: "The ownership confirmation conflicts with recorded vehicle history. Resolve that history before changing methods.",
    standard_mileage_separate_gas_forbidden: "Standard Mileage covers these expenses. Change the vehicle/year method, assign another vehicle, recategorize as non-vehicle, or cancel.",
    vehicle_business_use_conflicts_with_election: "Change the percentage through a vehicle/year amendment so every eligible expense is recalculated.",
    mileage_period_requires_rate_allocation: "Allocate mileage within a configured rate period. This year may require rate configuration before a deduction can be calculated.",
    vehicle_method_eligibility_unknown_or_leased: "A method change needs confirmed owned-vehicle eligibility. A leased vehicle cannot change methods here.",
    manual_deduction_conflicts_with_mileage: "A manual deduction conflicts with Standard Mileage. Explicitly include that manual decision, assign it to another vehicle, recategorize it, or cancel.",
    cpa_deduction_conflicts_with_mileage: "A protected CPA deduction conflicts with Standard Mileage. A CPA must resolve it before this method change.",
    cpa_authority_protected: "This customer edit cannot supersede a CPA or professional decision.",
    standard_mileage_eligibility_unconfirmed: "Confirm first-year, lease, fleet and depreciation eligibility before choosing Standard Mileage.",
    vehicle_command_evidence_changed: "The projection, membership, method, or tax treatment changed. Refresh and preview again. Nothing was saved.",
    vehicle_projection_stale: "The workspace projection changed. Refresh and preview again.",
  };
  if (error.code === "42501") return forbiddenBusinessError(messages[code] || "This vehicle scope or decision is not available for this user.");
  if (error.code === "40001" || error.code === "23505") return conflictError(code, messages[code] || "The preview is stale or this request key was already used. Refresh and preview again.");
  return validationError(code, messages[code] || "Check the selected vehicle, dates, business-use percentage, and confirmation fields.");
}
