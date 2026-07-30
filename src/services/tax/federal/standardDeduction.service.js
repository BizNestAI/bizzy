// /src/services/tax/federal/standardDeduction.service.js
import { TAX_FILING_STATUSES } from "../taxDomain.js";
import { validationError } from "../taxErrors.js";
import { FEDERAL_TAX_WARNING_CODES, federalWarning, round2 } from "./federalTaxDomain.js";

export function getStandardDeduction({ config, filingStatus, profile, taxYear } = {}) {
  if (!config) {
    throw validationError("missing_standard_deduction_config", "Standard deduction config is required.", { taxYear });
  }
  if (!filingStatus || filingStatus === TAX_FILING_STATUSES.UNKNOWN) {
    throw validationError("missing_filing_status", "Filing status is required for standard deduction.", { field: "filingStatus" });
  }
  const warnings = [];
  const assumptions = [];
  const baseAmount = resolveBaseAmount(config, filingStatus);
  let additionalAmount = 0;

  const additionalConfig = config.additionalAmounts || config.additional_amounts || null;
  if (additionalConfig) {
    const explicit = profile?.metadata?.standardDeductionAdditional || profile?.standard_deduction_additional;
    if (explicit != null) additionalAmount = Number(explicit) || 0;
    else warnings.push(federalWarning(
      FEDERAL_TAX_WARNING_CODES.UNSUPPORTED_PERSONAL_TAX_ITEMS,
      "low",
      "Additional standard deduction amounts require explicit age/blindness inputs and were not applied."
    ));
  }

  assumptions.push("Standard deduction is used; itemized deduction optimization is not implemented.");
  return {
    amount: round2(baseAmount + additionalAmount),
    baseAmount: round2(baseAmount),
    additionalAmount: round2(additionalAmount),
    assumptions,
    warnings,
  };
}

function resolveBaseAmount(config, filingStatus) {
  const byStatus = config.amountByFilingStatus || config.amount_by_filing_status || config.amountsByFilingStatus || config.amounts_by_filing_status;
  const value = byStatus ? byStatus[filingStatus] : config.amount;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw validationError("missing_standard_deduction_rule", "Standard deduction amount is missing for filing status.", { filingStatus });
  }
  return amount;
}
