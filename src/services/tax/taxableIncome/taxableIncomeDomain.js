// /src/services/tax/taxableIncome/taxableIncomeDomain.js

const freeze = (value) => Object.freeze(value);

export const TAXABLE_INCOME_COMPONENT_TYPES = freeze({
  GROSS_RECEIPTS: "gross_receipts",
  OTHER_BUSINESS_INCOME: "other_business_income",
  RETURNS_ALLOWANCES: "returns_allowances",
  COST_OF_GOODS_SOLD: "cost_of_goods_sold",
  DEDUCTIBLE_OPERATING_EXPENSES: "deductible_operating_expenses",
  NONDEDUCTIBLE_BOOK_EXPENSES: "nondeductible_book_expenses",
  CAPITALIZABLE_EXPENDITURES: "capitalizable_expenditures",
  DEPRECIATION_DEDUCTIONS: "depreciation_deductions",
  SECTION_179_DEDUCTIONS: "section_179_deductions",
  BONUS_DEPRECIATION: "bonus_depreciation",
  OWNER_WAGES: "owner_wages",
  GUARANTEED_PAYMENTS: "guaranteed_payments",
  HEALTH_INSURANCE_ADJUSTMENT: "health_insurance_adjustment",
  RETIREMENT_ADJUSTMENT: "retirement_adjustment",
  HSA_ADJUSTMENT: "hsa_adjustment",
  HALF_SELF_EMPLOYMENT_TAX_ADJUSTMENT: "half_self_employment_tax_adjustment",
  QBI_DEDUCTION: "qbi_deduction",
  TAX_ADJUSTMENT: "tax_adjustment",
  BOOK_TO_TAX_ADJUSTMENT: "book_to_tax_adjustment",
  TAXABLE_BUSINESS_INCOME: "taxable_business_income",
  TAXABLE_PERSONAL_INCOME_PLACEHOLDER: "taxable_personal_income_placeholder",
  UNSUPPORTED_COMPONENT: "unsupported_component",
});

export const TAXABLE_INCOME_SOURCES = freeze({
  TRANSACTION_CLASSIFICATIONS: "transaction_classifications",
  FINANCIAL_METRICS: "financial_metrics",
  TAX_ADJUSTMENTS: "tax_adjustments",
  TAX_PROFILE: "tax_profile",
  TAX_MEMORY: "tax_memory",
  MANUAL_OVERRIDE: "manual_override",
  IMPORTED_RETURN: "imported_return",
  PROJECTION: "projection",
  SYSTEM: "system",
});

export const TAXABLE_INCOME_CONFIDENCE_LEVELS = freeze({
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  UNAVAILABLE: "unavailable",
});

export const TAXABLE_INCOME_WARNING_CODES = freeze({
  INCOMPLETE_CLASSIFICATION_COVERAGE: "incomplete_classification_coverage",
  HIGH_NEEDS_REVIEW_AMOUNT: "high_needs_review_amount",
  UNSUPPORTED_INCOME_SOURCE: "unsupported_income_source",
  MISSING_REVENUE_SOURCE: "missing_revenue_source",
  BOOK_TAX_MISMATCH: "book_tax_mismatch",
  MISSING_DEPRECIATION_DATA: "missing_depreciation_data",
  MISSING_OWNER_WAGE_DATA: "missing_owner_wage_data",
  MISSING_ADJUSTMENTS: "missing_adjustments",
  INCOMPLETE_TAX_PROFILE: "incomplete_tax_profile",
  SOURCE_RECONCILIATION_DIFFERENCE: "source_reconciliation_difference",
  NEGATIVE_INCOME: "negative_income",
  UNSUPPORTED_ENTITY: "unsupported_entity",
  FUTURE_DATA_EXCLUDED: "future_data_excluded",
  STALE_DATA: "stale_data",
});

export const TaxableIncomeComponentTypeSet = immutableSet(Object.values(TAXABLE_INCOME_COMPONENT_TYPES));
export const TaxableIncomeSourceSet = immutableSet(Object.values(TAXABLE_INCOME_SOURCES));
export const TaxableIncomeWarningCodeSet = immutableSet(Object.values(TAXABLE_INCOME_WARNING_CODES));

function immutableSet(values) {
  const set = new Set(values);
  Object.defineProperties(set, {
    add: { value: immutableSetMutation, configurable: false },
    delete: { value: immutableSetMutation, configurable: false },
    clear: { value: immutableSetMutation, configurable: false },
  });
  return freeze(set);
}

function immutableSetMutation() {
  throw new TypeError("Taxable income domain sets are immutable.");
}

export function taxableWarning(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

export function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}
