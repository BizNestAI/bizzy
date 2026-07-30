// /src/services/tax/federal/federalTaxableIncome.service.js
import { FEDERAL_TAX_WARNING_CODES, federalWarning, round2 } from "./federalTaxDomain.js";
import { getStandardDeduction } from "./standardDeduction.service.js";

export function prepareFederalTaxableIncome({
  businessTaxableIncome,
  profile,
  adjustments,
  standardDeductionConfig,
  otherIncome = null,
  personalAdjustments = null,
  qbiDeduction = 0,
} = {}) {
  const warnings = [];
  const unsupportedItems = [];
  const businessIncome = Number(businessTaxableIncome || 0);
  const supportedOtherIncome = normalizeAmount(otherIncome?.amount ?? otherIncome ?? 0);
  if (otherIncome && typeof otherIncome === "object" && otherIncome.unsupported === true) {
    unsupportedItems.push("other_income");
    warnings.push(federalWarning(FEDERAL_TAX_WARNING_CODES.UNSUPPORTED_OTHER_INCOME, "medium", "Other income was supplied but is marked unsupported and was not included."));
  }
  const profileAdjustments = supportedAboveLineAdjustments(profile);
  const explicitAdjustments = normalizeAmount(personalAdjustments?.amount ?? personalAdjustments ?? 0);
  const aboveTheLineAdjustments = round2(profileAdjustments + explicitAdjustments + normalizeAmount(adjustments));
  const grossIncome = round2(businessIncome + supportedOtherIncome);
  const adjustedGrossIncome = round2(grossIncome - aboveTheLineAdjustments);
  const standard = getStandardDeduction({
    config: standardDeductionConfig,
    filingStatus: profile?.filing_status,
    profile,
    taxYear: profile?.tax_year,
  });
  const taxableIncomeBeforeQbi = round2(Math.max(0, adjustedGrossIncome - standard.amount));
  const qbi = Math.max(0, Number(qbiDeduction || 0));
  if (qbi === 0 && profile?.qbi_eligible === true) {
    warnings.push(federalWarning(FEDERAL_TAX_WARNING_CODES.QBI_NOT_APPLIED, "medium", "QBI deduction is not calculated in this engine and was not applied."));
    unsupportedItems.push("qbi_deduction");
  }
  const taxableIncomeAfterQbi = round2(Math.max(0, taxableIncomeBeforeQbi - qbi));
  unsupportedItems.push("itemized_deductions", "credits", "dependents", "capital_gains", "net_operating_loss");
  warnings.push(
    federalWarning(FEDERAL_TAX_WARNING_CODES.UNSUPPORTED_ITEMIZED_DEDUCTIONS, "low", "Itemized deduction optimization is not implemented."),
    federalWarning(FEDERAL_TAX_WARNING_CODES.UNSUPPORTED_CREDITS, "low", "Credits are not implemented."),
    federalWarning(FEDERAL_TAX_WARNING_CODES.UNSUPPORTED_DEPENDENTS, "low", "Dependent-related tax items are not implemented."),
    ...standard.warnings
  );

  return {
    businessIncome: round2(businessIncome),
    otherIncomeIncluded: round2(supportedOtherIncome),
    grossIncome,
    aboveTheLineAdjustments,
    adjustedGrossIncome,
    standardDeduction: standard.amount,
    itemizedDeductionUsed: 0,
    taxableIncomeBeforeQbi,
    qbiDeduction: qbi,
    taxableIncomeAfterQbi,
    unsupportedItems: [...new Set(unsupportedItems)],
    warnings,
    standardDeductionDetails: standard,
  };
}

function supportedAboveLineAdjustments(profile) {
  return round2(
    normalizeAmount(profile?.health_insurance_deduction_ytd) +
    normalizeAmount(profile?.retirement_contributions_ytd) +
    normalizeAmount(profile?.hsa_contributions_ytd)
  );
}

function normalizeAmount(value) {
  if (value == null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
