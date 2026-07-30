// /src/services/tax/federal/federalTaxDomain.js

const freeze = (value) => Object.freeze(value);

export const FEDERAL_TAX_COMPONENTS = freeze({
  GROSS_INCOME_INPUT: "gross_income_input",
  BUSINESS_INCOME: "business_income",
  OTHER_INCOME_PLACEHOLDER: "other_income_placeholder",
  ABOVE_THE_LINE_ADJUSTMENTS: "above_the_line_adjustments",
  ADJUSTED_GROSS_INCOME: "adjusted_gross_income",
  STANDARD_DEDUCTION: "standard_deduction",
  ITEMIZED_DEDUCTION_PLACEHOLDER: "itemized_deduction_placeholder",
  TAXABLE_INCOME_BEFORE_QBI: "taxable_income_before_qbi",
  QBI_DEDUCTION_PLACEHOLDER: "qbi_deduction_placeholder",
  TAXABLE_INCOME_AFTER_QBI: "taxable_income_after_qbi",
  REGULAR_INCOME_TAX: "regular_income_tax",
  ADDITIONAL_MEDICARE_TAX_PLACEHOLDER: "additional_medicare_tax_placeholder",
  CREDITS_PLACEHOLDER: "credits_placeholder",
  FEDERAL_INCOME_TAX: "federal_income_tax",
  UNSUPPORTED_PERSONAL_TAX_ITEMS: "unsupported_personal_tax_items",
});

export const FEDERAL_TAX_WARNING_CODES = freeze({
  MISSING_FILING_STATUS: "missing_filing_status",
  MISSING_STANDARD_DEDUCTION_RULE: "missing_standard_deduction_rule",
  MISSING_BRACKETS: "missing_brackets",
  UNSUPPORTED_ITEMIZED_DEDUCTIONS: "unsupported_itemized_deductions",
  UNSUPPORTED_CREDITS: "unsupported_credits",
  UNSUPPORTED_OTHER_INCOME: "unsupported_other_income",
  UNSUPPORTED_DEPENDENTS: "unsupported_dependents",
  UNSUPPORTED_CAPITAL_GAINS: "unsupported_capital_gains",
  UNSUPPORTED_NET_OPERATING_LOSS: "unsupported_net_operating_loss",
  QBI_NOT_APPLIED: "qbi_not_applied",
  PROFILE_INCOMPLETE: "profile_incomplete",
  RULE_SUPPORT_INSUFFICIENT: "rule_support_insufficient",
});

export function federalWarning(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

export function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}
