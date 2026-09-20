const FINANCIAL_STATEMENTS = Object.freeze({
  PNL: "Profit & Loss",
  BALANCE_SHEET: "Balance Sheet",
});

const MANUAL_QBO_ACCOUNT_CATALOG = Object.freeze([
  {
    financialStatement: FINANCIAL_STATEMENTS.PNL,
    accountType: "Income",
    label: "Income",
    subTypes: [
      ["ServiceFeeIncome", "Service/Fee Income"],
      ["SalesOfProductIncome", "Sales of Product Income"],
      ["OtherPrimaryIncome", "Other Primary Income"],
      ["NonProfitIncome", "Non-Profit Income"],
    ],
  },
  {
    financialStatement: FINANCIAL_STATEMENTS.PNL,
    accountType: "Other Income",
    label: "Other Income",
    subTypes: [
      ["OtherMiscellaneousIncome", "Other Miscellaneous Income"],
      ["InterestEarned", "Interest Earned"],
      ["DividendIncome", "Dividend Income"],
      ["GainLossOnSaleOfAssets", "Gain/Loss on Sale of Assets"],
    ],
  },
  {
    financialStatement: FINANCIAL_STATEMENTS.PNL,
    accountType: "Expense",
    label: "Expense",
    subTypes: [
      ["AdvertisingPromotional", "Advertising/Promotional"],
      ["Auto", "Auto"],
      ["BankCharges", "Bank Charges"],
      ["CharitableContributions", "Charitable Contributions"],
      ["DuesSubscriptions", "Dues & Subscriptions"],
      ["EquipmentRental", "Equipment Rental"],
      ["Insurance", "Insurance"],
      ["JanitorialExpenses", "Janitorial Expenses"],
      ["LegalProfessionalFees", "Legal & Professional Fees"],
      ["MealsEntertainment", "Meals & Entertainment"],
      ["OfficeGeneralAdministrativeExpenses", "Office/General Administrative Expenses"],
      ["OtherBusinessExpenses", "Other Business Expenses"],
      ["ParkingAndTolls", "Parking & Tolls"],
      ["RentOrLeaseOfBuildings", "Rent or Lease of Buildings"],
      ["ShippingFreightDelivery", "Shipping, Freight & Delivery"],
      ["SuppliesMaterials", "Supplies & Materials"],
      ["TaxesPaid", "Taxes Paid"],
      ["ToolsMachinery", "Tools & Machinery"],
      ["Travel", "Travel"],
      ["Utilities", "Utilities"],
    ],
  },
  {
    financialStatement: FINANCIAL_STATEMENTS.PNL,
    accountType: "Other Expense",
    label: "Other Expense",
    subTypes: [
      ["OtherMiscellaneousExpense", "Other Miscellaneous Expense"],
      ["Amortization", "Amortization"],
      ["Depreciation", "Depreciation"],
      ["ExchangeGainOrLoss", "Exchange Gain or Loss"],
      ["PenaltiesSettlements", "Penalties & Settlements"],
    ],
  },
  {
    financialStatement: FINANCIAL_STATEMENTS.PNL,
    accountType: "Cost of Goods Sold",
    label: "Cost of Goods Sold",
    subTypes: [
      ["CostOfLaborCos", "Cost of Labor"],
      ["EquipmentRentalCos", "Equipment Rental"],
      ["OtherCostsOfServiceCos", "Other Costs of Service"],
      ["ShippingFreightDeliveryCos", "Shipping, Freight & Delivery"],
      ["SuppliesMaterialsCogs", "Supplies & Materials"],
    ],
  },
  {
    financialStatement: FINANCIAL_STATEMENTS.BALANCE_SHEET,
    accountType: "Bank",
    label: "Bank",
    unavailable: true,
    unavailableReason: "Connect bank accounts through the Plaid mapping workflow.",
    subTypes: [
      ["Checking", "Checking"],
      ["Savings", "Savings"],
      ["CashOnHand", "Cash on Hand"],
      ["MoneyMarket", "Money Market"],
    ],
  },
  {
    financialStatement: FINANCIAL_STATEMENTS.BALANCE_SHEET,
    accountType: "Accounts Receivable",
    label: "Accounts Receivable",
    unavailable: true,
    unavailableReason: "QuickBooks manages receivable accounts. Use an existing A/R account.",
    subTypes: [["AccountsReceivable", "Accounts Receivable"]],
  },
  {
    financialStatement: FINANCIAL_STATEMENTS.BALANCE_SHEET,
    accountType: "Other Current Asset",
    label: "Other Current Asset",
    subTypes: [
      ["OtherCurrentAssets", "Other Current Assets"],
      ["EmployeeCashAdvances", "Employee Cash Advances"],
      ["Inventory", "Inventory"],
      ["LoansToOfficers", "Loans to Officers"],
      ["LoansToOthers", "Loans to Others"],
      ["PrepaidExpenses", "Prepaid Expenses"],
      ["Retainage", "Retainage"],
      ["UndepositedFunds", "Undeposited Funds"],
    ],
  },
  {
    financialStatement: FINANCIAL_STATEMENTS.BALANCE_SHEET,
    accountType: "Fixed Asset",
    label: "Fixed Asset",
    subTypes: [
      ["Vehicles", "Vehicles"],
      ["MachineryAndEquipment", "Machinery and Equipment"],
      ["FurnitureAndFixtures", "Furniture and Fixtures"],
      ["Buildings", "Buildings"],
      ["Land", "Land"],
      ["LeaseholdImprovements", "Leasehold Improvements"],
      ["AccumulatedDepreciation", "Accumulated Depreciation"],
      ["OtherFixedAssets", "Other Fixed Assets"],
    ],
  },
  {
    financialStatement: FINANCIAL_STATEMENTS.BALANCE_SHEET,
    accountType: "Other Asset",
    label: "Other Asset",
    subTypes: [
      ["OtherAssets", "Other Assets"],
      ["OtherLongTermAssets", "Other Long Term Assets"],
      ["SecurityDeposits", "Security Deposits"],
      ["Goodwill", "Goodwill"],
      ["AccumulatedAmortization", "Accumulated Amortization"],
    ],
  },
  {
    financialStatement: FINANCIAL_STATEMENTS.BALANCE_SHEET,
    accountType: "Accounts Payable",
    label: "Accounts Payable",
    unavailable: true,
    unavailableReason: "QuickBooks manages payable accounts. Use an existing A/P account.",
    subTypes: [["AccountsPayable", "Accounts Payable"]],
  },
  {
    financialStatement: FINANCIAL_STATEMENTS.BALANCE_SHEET,
    accountType: "Credit Card",
    label: "Credit Card",
    unavailable: true,
    unavailableReason: "Create credit-card accounts from the card mapping workflow.",
    subTypes: [["CreditCard", "Credit Card"]],
  },
  {
    financialStatement: FINANCIAL_STATEMENTS.BALANCE_SHEET,
    accountType: "Other Current Liability",
    label: "Other Current Liability",
    subTypes: [
      ["CurrentLiabilities", "Current Liabilities"],
      ["LoanPayable", "Loan Payable"],
      ["LineOfCredit", "Line of Credit"],
      ["OtherCurrentLiabilities", "Other Current Liabilities"],
      ["PayrollTaxPayable", "Payroll Tax Payable"],
      ["SalesTaxPayable", "Sales Tax Payable"],
      ["StateLocalIncomeTaxPayable", "State/Local Income Tax Payable"],
    ],
  },
  {
    financialStatement: FINANCIAL_STATEMENTS.BALANCE_SHEET,
    accountType: "Long Term Liability",
    label: "Long-Term Liability",
    subTypes: [
      ["NotesPayable", "Notes Payable"],
      ["OtherLongTermLiabilities", "Other Long-Term Liabilities"],
      ["ShareholderNotesPayable", "Shareholder Notes Payable"],
    ],
  },
  {
    financialStatement: FINANCIAL_STATEMENTS.BALANCE_SHEET,
    accountType: "Equity",
    label: "Equity",
    subTypes: [
      ["OwnersEquity", "Owner's Equity"],
      ["PaidInCapitalOrSurplus", "Paid-in Capital or Surplus"],
      ["PartnerContributions", "Partner Contributions"],
      ["PartnerDistributions", "Partner Distributions"],
      ["PartnersEquity", "Partner's Equity"],
      ["OpeningBalanceEquity", "Opening Balance Equity"],
      ["CommonStock", "Common Stock"],
      ["PreferredStock", "Preferred Stock"],
      ["TreasuryStock", "Treasury Stock"],
    ],
  },
]);

const TYPE_BY_KEY = new Map(
  MANUAL_QBO_ACCOUNT_CATALOG.map((entry) => [normalizeAccountTypeKey(entry.accountType), entry])
);

export function normalizeAccountTypeKey(value = "") {
  return String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
}

export function getManualQboAccountCatalog() {
  return MANUAL_QBO_ACCOUNT_CATALOG.map((entry) => ({
    financialStatement: entry.financialStatement,
    accountType: entry.accountType,
    label: entry.label,
    unavailable: entry.unavailable === true,
    unavailableReason: entry.unavailableReason || null,
    subTypes: entry.subTypes.map(([value, label]) => ({ value, label })),
  }));
}

export function normalizeManualQboAccountType(value = "") {
  return TYPE_BY_KEY.get(normalizeAccountTypeKey(value))?.accountType || null;
}

export function isSupportedManualQboAccountType(value = "") {
  const entry = TYPE_BY_KEY.get(normalizeAccountTypeKey(value));
  return Boolean(entry && entry.unavailable !== true);
}

export function getManualQboAccountTypeRestriction(value = "") {
  const entry = TYPE_BY_KEY.get(normalizeAccountTypeKey(value));
  if (!entry || entry.unavailable !== true) return null;
  return {
    accountType: entry.accountType,
    reason: entry.unavailableReason || "This QuickBooks account type is managed by another workflow.",
  };
}

export function isValidManualQboAccountSubType(accountType = "", accountSubType = "") {
  const entry = TYPE_BY_KEY.get(normalizeAccountTypeKey(accountType));
  if (!entry) return false;
  const wanted = String(accountSubType || "").trim();
  return entry.subTypes.some(([value]) => value === wanted);
}

export function getManualQboAccountSubTypes(accountType = "") {
  const entry = TYPE_BY_KEY.get(normalizeAccountTypeKey(accountType));
  return entry ? entry.subTypes.map(([value, label]) => ({ value, label })) : [];
}

export default {
  getManualQboAccountCatalog,
  getManualQboAccountSubTypes,
  getManualQboAccountTypeRestriction,
  isSupportedManualQboAccountType,
  isValidManualQboAccountSubType,
  normalizeAccountTypeKey,
  normalizeManualQboAccountType,
};
