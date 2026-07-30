// /src/services/tax/selfEmployment/selfEmploymentTaxMath.js
import { validationError } from "../taxErrors.js";
import { SELF_EMPLOYMENT_TAX_COMPONENTS, SELF_EMPLOYMENT_WARNING_CODES, round2, seWarning } from "./selfEmploymentTaxDomain.js";

export function computeSelfEmploymentTaxMath({
  netBusinessIncome,
  netEarningsFactor,
  socialSecurityRate,
  medicareRate,
  socialSecurityWageBase,
  otherSocialSecurityWages = 0,
  additionalMedicareRate = 0,
  additionalMedicareThreshold = null,
  otherMedicareWages = 0,
  deductiblePortionRate = 0.5,
} = {}) {
  const input = finite(netBusinessIncome, "netBusinessIncome");
  const factor = rate(netEarningsFactor, "netEarningsFactor");
  const ssRate = rate(socialSecurityRate, "socialSecurityRate");
  const medRate = rate(medicareRate, "medicareRate");
  const wageBase = nonnegative(socialSecurityWageBase, "socialSecurityWageBase");
  const ssWages = nonnegative(otherSocialSecurityWages, "otherSocialSecurityWages");
  const addlRate = rate(additionalMedicareRate || 0, "additionalMedicareRate");
  const addlThreshold = additionalMedicareThreshold == null ? null : nonnegative(additionalMedicareThreshold, "additionalMedicareThreshold");
  const medWages = nonnegative(otherMedicareWages, "otherMedicareWages");
  const deductibleRate = rate(deductiblePortionRate, "deductiblePortionRate");
  const warnings = [];

  if (input <= 0) {
    warnings.push(seWarning(SELF_EMPLOYMENT_WARNING_CODES.NEGATIVE_SE_INCOME, "low", "Self-employment tax is zero because net business income is not positive."));
  }

  const netEarnings = Math.max(0, input * factor);
  const remainingWageBase = Math.max(0, wageBase - ssWages);
  if (ssWages >= wageBase && wageBase > 0) {
    warnings.push(seWarning(SELF_EMPLOYMENT_WARNING_CODES.WAGE_BASE_CONSUMED, "medium", "Other Social Security wages consume the Social Security wage base."));
  }
  const socialSecurityTaxableBase = Math.min(netEarnings, remainingWageBase);
  const socialSecurityTax = socialSecurityTaxableBase * ssRate;
  const medicareTaxableBase = netEarnings;
  const medicareTax = medicareTaxableBase * medRate;
  const addl = computeAdditionalMedicare({
    netEarnings,
    otherMedicareWages: medWages,
    threshold: addlThreshold,
    rate: addlRate,
    warnings,
  });
  const totalSelfEmploymentTax = socialSecurityTax + medicareTax + addl.tax;
  const deductibleHalfSelfEmploymentTax = totalSelfEmploymentTax * deductibleRate;

  return {
    netBusinessIncome: round2(input),
    netEarningsFromSelfEmployment: round2(netEarnings),
    socialSecurity: {
      wageBase: round2(wageBase),
      otherWages: round2(ssWages),
      remainingWageBase: round2(remainingWageBase),
      taxableBase: round2(socialSecurityTaxableBase),
      rate: ssRate,
      tax: round2(socialSecurityTax),
    },
    medicare: {
      taxableBase: round2(medicareTaxableBase),
      rate: medRate,
      tax: round2(medicareTax),
    },
    additionalMedicare: addl,
    totalSelfEmploymentTax: round2(totalSelfEmploymentTax),
    deductibleHalfSelfEmploymentTax: round2(deductibleHalfSelfEmploymentTax),
    effectiveRate: input > 0 ? round2(totalSelfEmploymentTax / input) : 0,
    components: [
      component(SELF_EMPLOYMENT_TAX_COMPONENTS.NET_PROFIT_INPUT, input),
      component(SELF_EMPLOYMENT_TAX_COMPONENTS.NET_EARNINGS_FACTOR, factor),
      component(SELF_EMPLOYMENT_TAX_COMPONENTS.NET_EARNINGS_FROM_SELF_EMPLOYMENT, netEarnings),
      component(SELF_EMPLOYMENT_TAX_COMPONENTS.REMAINING_SOCIAL_SECURITY_WAGE_BASE, remainingWageBase),
      component(SELF_EMPLOYMENT_TAX_COMPONENTS.SOCIAL_SECURITY_TAXABLE_BASE, socialSecurityTaxableBase),
      component(SELF_EMPLOYMENT_TAX_COMPONENTS.SOCIAL_SECURITY_TAX, socialSecurityTax),
      component(SELF_EMPLOYMENT_TAX_COMPONENTS.MEDICARE_TAXABLE_BASE, medicareTaxableBase),
      component(SELF_EMPLOYMENT_TAX_COMPONENTS.MEDICARE_TAX, medicareTax),
      component(SELF_EMPLOYMENT_TAX_COMPONENTS.ADDITIONAL_MEDICARE_TAX, addl.tax),
      component(SELF_EMPLOYMENT_TAX_COMPONENTS.TOTAL_SELF_EMPLOYMENT_TAX, totalSelfEmploymentTax),
      component(SELF_EMPLOYMENT_TAX_COMPONENTS.DEDUCTIBLE_HALF_SE_TAX, deductibleHalfSelfEmploymentTax),
      component(SELF_EMPLOYMENT_TAX_COMPONENTS.WAGES_SUBJECT_TO_FICA, ssWages),
    ],
    warnings,
  };
}

function computeAdditionalMedicare({ netEarnings, otherMedicareWages, threshold, rate, warnings }) {
  if (!rate || threshold == null) {
    if (rate) {
      warnings.push(seWarning(SELF_EMPLOYMENT_WARNING_CODES.ADDITIONAL_MEDICARE_NOT_COMPUTED, "medium", "Additional Medicare threshold is unavailable, so Additional Medicare tax was not computed."));
    }
    return {
      threshold,
      combinedIncomeConsidered: round2(otherMedicareWages + netEarnings),
      taxableBase: 0,
      rate,
      tax: 0,
      applied: false,
    };
  }
  const combinedBeforeSe = otherMedicareWages;
  const combinedAfterSe = otherMedicareWages + netEarnings;
  const taxableBase = Math.max(0, combinedAfterSe - Math.max(threshold, combinedBeforeSe));
  return {
    threshold: round2(threshold),
    combinedIncomeConsidered: round2(combinedAfterSe),
    taxableBase: round2(taxableBase),
    rate,
    tax: round2(taxableBase * rate),
    applied: taxableBase > 0,
  };
}

function component(componentType, rawAmount) {
  return { componentType, amount: round2(rawAmount) };
}

function finite(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw validationError(`invalid_${field}`, `${field} must be a finite number.`, { field });
  return n;
}

function nonnegative(value, field) {
  const n = finite(value, field);
  if (n < 0) throw validationError(`invalid_${field}`, `${field} cannot be negative.`, { field });
  return n;
}

function rate(value, field) {
  const n = finite(value, field);
  if (n < 0 || n > 1) throw validationError(`invalid_${field}`, `${field} must be between 0 and 1.`, { field });
  return n;
}
