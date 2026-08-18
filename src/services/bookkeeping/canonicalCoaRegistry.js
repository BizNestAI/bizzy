export const AUTO_CREATE_ALLOWED = "AUTO_CREATE_ALLOWED";
export const ACCOUNTANT_REVIEW_REQUIRED = "ACCOUNTANT_REVIEW_REQUIRED";
export const DISABLED = "DISABLED";

export const CANONICAL_MAPPING_STATUSES = {
  EXISTING_EXACT: "existing_exact",
  EXISTING_APPROVED_EQUIVALENT: "existing_approved_equivalent",
  CREATED_BY_BIZZI: "created_by_bizzi",
  NEEDS_REVIEW: "needs_review",
  REJECTED: "rejected",
  DISABLED: "disabled",
};

const canonicalAccounts = [
  account("sales", "Sales", "Income", "ServiceFeeIncome", ACCOUNTANT_REVIEW_REQUIRED, true, "Operating sales and service revenue.", 10),
  account("other_income", "Other Income", "Other Income", "OtherMiscellaneousIncome", ACCOUNTANT_REVIEW_REQUIRED, true, "Non-operating income such as rewards or miscellaneous credits.", 20),
  account("software", "Software", "Expense", "DuesSubscriptions", AUTO_CREATE_ALLOWED, false, "Software, SaaS, cloud tools, and business subscriptions.", 100),
  account("electric", "Electric", "Expense", "Utilities", AUTO_CREATE_ALLOWED, false, "Electric utility costs.", 110),
  account("materials_supplies", "Supplies & Materials", "Expense", "SuppliesMaterials", AUTO_CREATE_ALLOWED, false, "Business supplies, job materials, hardware, and consumable materials.", 120),
  account("payment_processing_fees", "Payment Processing Fees", "Expense", "BankCharges", AUTO_CREATE_ALLOWED, false, "Merchant processing fees.", 130),
  account("advertising_marketing", "Advertising & Marketing", "Expense", "AdvertisingPromotional", AUTO_CREATE_ALLOWED, false, "Advertising, marketing, lead generation, and promotional spend.", 140),
  account("parking_tolls", "Parking & Tolls", "Expense", "ParkingAndTolls", AUTO_CREATE_ALLOWED, false, "Parking lots, meters, toll roads, and toll passes.", 150),
  account("bank_fees", "Bank Fees", "Expense", "BankCharges", AUTO_CREATE_ALLOWED, false, "Bank service charges and account fees.", 160),
  account("internet_services", "Internet Services", "Expense", "Utilities", AUTO_CREATE_ALLOWED, false, "Internet, broadband, and telecom utility services.", 170),
  account("office_expenses", "Office Expenses", "Expense", "OfficeGeneralAdministrativeExpenses", AUTO_CREATE_ALLOWED, false, "General office and administrative expenses.", 180),
  account("shipping", "Shipping", "Expense", "ShippingFreightDelivery", AUTO_CREATE_ALLOWED, false, "Shipping, postage, freight, and delivery costs.", 190),
  account("cleaning", "Cleaning", "Expense", "JanitorialExpenses", AUTO_CREATE_ALLOWED, false, "Cleaning and janitorial expenses.", 200),
  account("fuel", "Fuel", "Expense", "Auto", AUTO_CREATE_ALLOWED, false, "Fuel, gasoline, diesel, and routine charging costs.", 210),
  account("vehicle_expense", "Vehicle Expense", "Expense", "Auto", AUTO_CREATE_ALLOWED, false, "Routine auto and vehicle expenses.", 220),
  account("meals", "Meals", "Expense", "MealsEntertainment", AUTO_CREATE_ALLOWED, false, "Business meals and food expenses.", 230),
  account("travel", "Travel", "Expense", "Travel", AUTO_CREATE_ALLOWED, false, "Travel and lodging expenses.", 240),
  account("airfare", "Airfare", "Expense", "Travel", AUTO_CREATE_ALLOWED, false, "Airline and flight expenses.", 250),
  account("transportation", "Transportation", "Expense", "Travel", AUTO_CREATE_ALLOWED, false, "Rideshare, taxi, and local transportation costs.", 260),
  account("insurance", "Insurance", "Expense", "Insurance", AUTO_CREATE_ALLOWED, false, "Business insurance expenses.", 270),
  account("equipment_rental", "Equipment Rental", "Expense", "EquipmentRental", AUTO_CREATE_ALLOWED, false, "Equipment, tool, and jobsite rentals.", 280),
  account("business_licensing_fees", "Business Licensing Fees", "Expense", "TaxesPaid", AUTO_CREATE_ALLOWED, false, "Business licenses, permits, filings, and regulatory fees.", 290),
  account("waste_disposal", "Waste Disposal", "Expense", "DisposalFees", AUTO_CREATE_ALLOWED, false, "Dump fees, landfill, hauling, trash, and debris disposal.", 300),
  account("uniforms_laundry", "Uniforms & Laundry", "Expense", "Uniforms", AUTO_CREATE_ALLOWED, false, "Uniforms, laundry, and workwear.", 310),
  account("safety_ppe", "Safety & PPE", "Expense", "SuppliesMaterials", AUTO_CREATE_ALLOWED, false, "Safety gear and personal protective equipment.", 320),
  account("tools_equipment", "Tools & Equipment", "Expense", "ToolsMachinery", AUTO_CREATE_ALLOWED, false, "Small tools and non-capital equipment.", 330),
  account("owner_contributions", "Owner Contributions", "Equity", "OwnerEquity", ACCOUNTANT_REVIEW_REQUIRED, true, "Owner capital contributions and equity funding.", 900),
  account("owner_distributions", "Owner Distributions", "Equity", "OwnerEquity", ACCOUNTANT_REVIEW_REQUIRED, true, "Owner draws, distributions, and equity withdrawals.", 910),
  account("loans_payable", "Loans Payable", "Long Term Liability", "NotesPayable", ACCOUNTANT_REVIEW_REQUIRED, true, "Loan principal and note payable obligations.", 920),
  account("fixed_assets", "Fixed Assets", "Fixed Asset", "FixedAssetComputers", ACCOUNTANT_REVIEW_REQUIRED, true, "Capitalized fixed assets.", 930),
  account("accumulated_depreciation", "Accumulated Depreciation", "Fixed Asset", "AccumulatedDepreciation", ACCOUNTANT_REVIEW_REQUIRED, true, "Contra-asset accumulated depreciation.", 940),
  account("payroll_liabilities", "Payroll Liabilities", "Other Current Liability", "PayrollClearing", ACCOUNTANT_REVIEW_REQUIRED, true, "Payroll liabilities and withholding obligations.", 950),
  account("sales_tax_payable", "Sales Tax Payable", "Other Current Liability", "SalesTaxPayable", ACCOUNTANT_REVIEW_REQUIRED, true, "Sales tax collected and payable.", 960),
];

const intentMappings = {
  sales: "sales",
  quickbooks_revenue: "sales",
  invoice_revenue: "sales",
  other_income: "other_income",
  cashback: "other_income",
  cash_back: "other_income",
  rewards: "other_income",
  software: "software",
  subscriptions: "software",
  subscription: "software",
  streaming: "software",
  productivity: "software",
  construction_ops: "software",
  electric: "electric",
  electricity: "electric",
  electric_utility: "electric",
  materials: "materials_supplies",
  supplies: "materials_supplies",
  general_supplies: "materials_supplies",
  food_supplies: "materials_supplies",
  payment_processing: "payment_processing_fees",
  bank_fees: "bank_fees",
  advertising: "advertising_marketing",
  ads: "advertising_marketing",
  leads: "advertising_marketing",
  parking_tolls: "parking_tolls",
  parking: "parking_tolls",
  parking_toll: "parking_tolls",
  tolls: "parking_tolls",
  internet_services: "internet_services",
  wifi: "internet_services",
  internet: "internet_services",
  telecom: "internet_services",
  utilities_internet: "internet_services",
  office_supplies: "office_expenses",
  medical: "office_expenses",
  training: "office_expenses",
  shipping: "shipping",
  postage: "shipping",
  cleaning: "cleaning",
  fuel: "fuel",
  gas_charging: "fuel",
  ev_charging: "fuel",
  vehicle_charging: "fuel",
  vehicle_expense: "vehicle_expense",
  vehicle_lease: "vehicle_expense",
  meals: "meals",
  travel: "travel",
  lodging: "travel",
  airfare: "airfare",
  transportation: "transportation",
  car_rental: "travel",
  insurance: "insurance",
  equipment_rental: "equipment_rental",
  rentals: "equipment_rental",
  business_licensing_fees: "business_licensing_fees",
  business_license: "business_licensing_fees",
  business_licensing: "business_licensing_fees",
  licensing_fees: "business_licensing_fees",
  permits: "business_licensing_fees",
  permit_fees: "business_licensing_fees",
  permits_fees: "business_licensing_fees",
  waste_disposal: "waste_disposal",
  uniforms_laundry: "uniforms_laundry",
  safety_ppe: "safety_ppe",
  tools: "tools_equipment",
  equipment: "tools_equipment",
  owner_contribution: "owner_contributions",
  owner_contributions: "owner_contributions",
  owner_draw: "owner_distributions",
  owner_distribution: "owner_distributions",
  owner_distributions: "owner_distributions",
  loan_principal: "loans_payable",
};

const approvedEquivalents = {
  software: ["Software", "Software Expense", "Software Subscriptions"],
  electric: ["Electric", "Electricity"],
  materials_supplies: ["Supplies & Materials", "Materials", "Job Materials"],
  payment_processing_fees: ["Payment Processing Fees", "Merchant Fees"],
  advertising_marketing: ["Advertising & Marketing", "Advertising", "Marketing"],
  parking_tolls: ["Parking & Tolls", "Parking/Tolls"],
  bank_fees: ["Bank Fees", "Bank Charges", "Bank Charges & Fees"],
  internet_services: ["Internet Services"],
  office_expenses: ["Office Expenses"],
  shipping: ["Shipping"],
  cleaning: ["Cleaning"],
  fuel: ["Fuel", "Gas", "Gas/Charging"],
  vehicle_expense: ["Vehicle Expense"],
  meals: ["Meals", "Meals & Entertainment"],
  travel: ["Travel"],
  airfare: ["Airfare"],
  transportation: ["Transportation"],
  insurance: ["Insurance"],
  equipment_rental: ["Equipment Rental"],
  business_licensing_fees: ["Business Licensing Fees"],
  waste_disposal: ["Waste Disposal"],
  uniforms_laundry: ["Uniforms & Laundry"],
  safety_ppe: ["Safety & PPE"],
  tools_equipment: ["Tools & Equipment"],
};

function account(canonicalAccountKey, preferredAccountName, qboAccountType, qboAccountSubType, autoCreatePolicy, reviewRequired, purpose, sortOrder) {
  return {
    canonical_account_key: canonicalAccountKey,
    preferred_account_name: preferredAccountName,
    qbo_account_type: qboAccountType,
    qbo_account_subtype: qboAccountSubType,
    is_active: true,
    auto_create_policy: autoCreatePolicy,
    review_required: reviewRequired,
    purpose,
    sort_order: sortOrder,
  };
}

export function normalizeCanonicalName(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveIntentToCanonicalKey(intent = "") {
  const key = String(intent || "").toLowerCase();
  return intentMappings[key] || key;
}

export function getCanonicalAccountByKey(key = "") {
  const normalizedKey = String(key || "").toLowerCase();
  return canonicalAccounts.find((acct) => acct.canonical_account_key === normalizedKey) || null;
}

export function getCanonicalAccountForIntent(intent = "") {
  return getCanonicalAccountByKey(resolveIntentToCanonicalKey(intent));
}

export function getApprovedEquivalentNames(canonicalAccountKey = "") {
  const acct = getCanonicalAccountByKey(canonicalAccountKey);
  const names = new Set();
  if (acct?.preferred_account_name) names.add(acct.preferred_account_name);
  (approvedEquivalents[acct?.canonical_account_key] || []).forEach((name) => names.add(name));
  return Array.from(names);
}

export function isApprovedEquivalentName(canonicalAccountKey = "", name = "") {
  const normalized = normalizeCanonicalName(name);
  return getApprovedEquivalentNames(canonicalAccountKey)
    .map(normalizeCanonicalName)
    .includes(normalized);
}

export function getCanonicalAccounts() {
  return canonicalAccounts.map((acct) => ({ ...acct }));
}

export function getCanonicalIntentMappings() {
  return { ...intentMappings };
}

export default {
  AUTO_CREATE_ALLOWED,
  ACCOUNTANT_REVIEW_REQUIRED,
  DISABLED,
  CANONICAL_MAPPING_STATUSES,
  normalizeCanonicalName,
  resolveIntentToCanonicalKey,
  getCanonicalAccountByKey,
  getCanonicalAccountForIntent,
  getApprovedEquivalentNames,
  isApprovedEquivalentName,
  getCanonicalAccounts,
  getCanonicalIntentMappings,
};
