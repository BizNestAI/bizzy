const MANUAL_QBO_ACCOUNT_CATALOG = Object.freeze([
  {
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
]);

const TYPE_BY_KEY = new Map(
  MANUAL_QBO_ACCOUNT_CATALOG.map((entry) => [normalizeAccountTypeKey(entry.accountType), entry])
);

export function normalizeAccountTypeKey(value = "") {
  return String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
}

export function getManualQboAccountCatalog() {
  return MANUAL_QBO_ACCOUNT_CATALOG.map((entry) => ({
    accountType: entry.accountType,
    label: entry.label,
    subTypes: entry.subTypes.map(([value, label]) => ({ value, label })),
  }));
}

export function normalizeManualQboAccountType(value = "") {
  return TYPE_BY_KEY.get(normalizeAccountTypeKey(value))?.accountType || null;
}

export function isSupportedManualQboAccountType(value = "") {
  return Boolean(normalizeManualQboAccountType(value));
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
  isSupportedManualQboAccountType,
  isValidManualQboAccountSubType,
  normalizeAccountTypeKey,
  normalizeManualQboAccountType,
};
