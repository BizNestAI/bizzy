// /src/services/tax/taxCategoryCatalog.js

const CATALOG = Object.freeze({
  advertising: entry("Advertising", 10, true),
  bank_fees: entry("Bank Fees", 20, true),
  contract_labor: entry("Contract Labor", 30, true),
  insurance: entry("Insurance", 40, true),
  interest_expense: entry("Interest Expense", 50, true),
  legal_professional: entry("Legal & Professional", 60, true),
  meals: entry("Meals", 70, true, { reviewSensitive: true }),
  office_expense: entry("Office Expense", 80, true),
  rent_lease: entry("Rent & Lease", 90, true),
  repairs_maintenance: entry("Repairs & Maintenance", 100, true),
  supplies_materials: entry("Materials & Supplies", 110, true),
  taxes_licenses: entry("Taxes & Licenses", 120, true),
  travel: entry("Travel", 130, true, { reviewSensitive: true }),
  vehicle: entry("Vehicle Expenses", 140, true, { reviewSensitive: true }),
  wages_payroll: entry("Wages & Payroll", 150, true),
  utilities: entry("Utilities", 160, true),
  loan_interest: entry("Loan Interest", 170, true, { reviewSensitive: true }),

  depreciation_asset: entry("Depreciation & Assets", 300, false, { defaultTone: "asset", reviewSensitive: true }),
  equipment_asset: entry("Equipment & Assets", 310, false, { defaultTone: "asset", reviewSensitive: true }),
  home_office: entry("Home Office", 320, true, { reviewSensitive: true }),

  charitable_contribution: entry("Charitable Contributions", 410, false, { reviewSensitive: true }),
  penalties_fines: entry("Penalties & Fines", 420, false, { defaultTone: "warning", reviewSensitive: true }),
  personal_expense: entry("Personal Expense", 430, false, { defaultTone: "warning", reviewSensitive: true }),

  transfer: entry("Transfers", 700, false, { defaultTone: "balance_sheet" }),
  owner_distribution: entry("Owner Distributions", 710, false, { defaultTone: "balance_sheet" }),
  owner_contribution: entry("Owner Contributions", 720, false, { defaultTone: "balance_sheet" }),
  credit_card_payment: entry("Credit Card Payments", 730, false, { defaultTone: "balance_sheet" }),
  loan_principal: entry("Loan Principal", 740, false, { defaultTone: "balance_sheet", reviewSensitive: true }),
  refund_or_reversal: entry("Refunds & Reversals", 750, false, { reviewSensitive: true }),
  income: entry("Income", 800, false),
  other: entry("Other", 900, false, { reviewSensitive: true }),
  unclassified: entry("Needs Review", 950, false, { defaultTone: "review", reviewSensitive: true }),
  excluded: entry("Excluded", 990, false),
});

export function getTaxCategoryCatalog() {
  return CATALOG;
}

export function getTaxCategoryMeta(taxCategory) {
  const key = taxCategory || "unclassified";
  return CATALOG[key] || {
    taxCategory: key,
    displayName: titleize(key),
    description: "Tax category assigned by classification.",
    sortOrder: 600,
    defaultTone: "default",
    currentDeductionCategory: false,
    reviewSensitive: true,
  };
}

export function sortTaxCategories(a, b) {
  const metaA = getTaxCategoryMeta(a?.taxCategory || a);
  const metaB = getTaxCategoryMeta(b?.taxCategory || b);
  if (metaA.sortOrder !== metaB.sortOrder) return metaA.sortOrder - metaB.sortOrder;
  return String(metaA.displayName).localeCompare(String(metaB.displayName));
}

function entry(displayName, sortOrder, currentDeductionCategory, options = {}) {
  return Object.freeze({
    displayName,
    description: `${displayName} classification bucket.`,
    sortOrder,
    defaultTone: options.defaultTone || "default",
    currentDeductionCategory,
    reviewSensitive: options.reviewSensitive === true,
  });
}

function titleize(value) {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Unclassified";
}
