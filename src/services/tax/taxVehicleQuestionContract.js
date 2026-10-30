export const VEHICLE_QUESTION_ANSWER_CONTRACT = Object.freeze({
  schema: {
    required: ["vehicleMethod"],
    vehicleMethod: { enum: ["standard_mileage", "actual_expense", "not_sure"] },
    actualExpenseUse: { enum: ["all_business", "mixed_use", "not_business"], requiredWhen: "vehicleMethod=actual_expense" },
    businessUsePercent: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 100, precision: 2, requiredWhen: "actualExpenseUse=mixed_use" },
  },
  outcomes: {
    standard_mileage: { taxTreatment: "vehicle_standard_mileage_no_separate_gas", deductibilityStatus: "nondeductible", deductiblePercent: 0, directVehicleExpenseDeduction: false },
    actual_expense_all_business: { taxTreatment: "vehicle_actual_expense_business_use", deductibilityStatus: "fully_deductible", deductiblePercent: 100 },
    actual_expense_mixed_use: { taxTreatment: "vehicle_actual_expense_business_use", deductibilityStatus: "partially_deductible", deductiblePercent: "input" },
    actual_expense_not_business: { taxTreatment: "vehicle_actual_expense_no_business_use", deductibilityStatus: "nondeductible", deductiblePercent: 0 },
    not_sure: { taxTreatment: "unchanged", deductibilityStatus: "unchanged", deductiblePercent: "unchanged", savesDefault: false },
  },
});

export function vehicleTreatmentForAnswer({ taxCategory, vehicleMethod, actualExpenseUse, businessUsePercent } = {}) {
  if (vehicleMethod === "standard_mileage") {
    if (supplied(actualExpenseUse) || supplied(businessUsePercent)) throw vehicleInputError("inconsistent_vehicle_decision", "Standard mileage cannot include an actual-expense allocation.");
    return {
      taxCategory,
      deductibilityStatus: "nondeductible",
      deductiblePercent: 0,
      taxTreatment: "vehicle_standard_mileage_no_separate_gas",
    };
  }
  if (vehicleMethod !== "actual_expense") throw vehicleInputError("invalid_vehicle_method", "Choose standard mileage or actual expenses.");
  if (actualExpenseUse === "all_business") {
    if (supplied(businessUsePercent)) throw vehicleInputError("inconsistent_vehicle_decision", "Entirely-business actual expenses cannot include a different percentage.");
    return vehicleActualTreatment(taxCategory, 100);
  }
  if (actualExpenseUse === "not_business") {
    if (supplied(businessUsePercent)) throw vehicleInputError("inconsistent_vehicle_decision", "Nonbusiness actual expenses cannot include a different percentage.");
    return {
      taxCategory,
      deductibilityStatus: "nondeductible",
      deductiblePercent: 0,
      taxTreatment: "vehicle_actual_expense_no_business_use",
    };
  }
  if (actualExpenseUse !== "mixed_use") throw vehicleInputError("invalid_vehicle_business_use", "Choose how much of these vehicle expenses was for business.");
  const raw = String(businessUsePercent ?? "");
  if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(raw)) throw vehicleInputError("invalid_vehicle_business_use_percent", "Mixed business use must be greater than 0 and less than 100, with at most two decimal places.");
  const percent = Number(raw);
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) throw vehicleInputError("invalid_vehicle_business_use_percent", "Mixed business use must be greater than 0 and less than 100.");
  return vehicleActualTreatment(taxCategory, percent);
}

function vehicleActualTreatment(taxCategory, percent) {
  return {
    taxCategory,
    deductibilityStatus: percent === 100 ? "fully_deductible" : "partially_deductible",
    deductiblePercent: percent,
    taxTreatment: "vehicle_actual_expense_business_use",
  };
}

function vehicleInputError(code, message) {
  return Object.assign(new Error(message), { code });
}

function supplied(value) {
  return value != null && value !== "";
}
