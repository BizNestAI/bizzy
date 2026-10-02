// Reviewed Plaid-to-bookkeeping policy. Unknown provider taxonomy values must
// never become QuickBooks account names by string coincidence.
const PLAID_CATEGORY_INTENTS = Object.freeze({
  TRAVEL: "travel",
  TRAVEL_FLIGHTS: "airfare",
  TRAVEL_LODGING: "travel",
  FOOD_AND_DRINK: "meals",
  FOOD_AND_DRINK_RESTAURANTS: "meals",
  TRANSPORTATION: "vehicle_expense",
  TRANSPORTATION_GAS: "fuel",
  GENERAL_SERVICES_POSTAGE_AND_SHIPPING: "shipping",
  GENERAL_MERCHANDISE_OFFICE_SUPPLIES: "office_supplies",
  BANK_FEES: "bank_fees",
});

export function resolvePlaidCategoryIntent(transaction = {}) {
  const values = [
    transaction.category_detailed,
    transaction.personal_finance_category?.detailed,
    transaction.category_primary,
    transaction.personal_finance_category?.primary,
  ];
  for (const value of values) {
    const key = String(value || "").trim().toUpperCase();
    if (PLAID_CATEGORY_INTENTS[key]) {
      return { intent: PLAID_CATEGORY_INTENTS[key], plaid_category: key, source: "plaid_allowlist" };
    }
  }
  return null;
}

export function isGenericEquipmentRentalBlocked(transaction = {}) {
  return [
    transaction.category_detailed,
    transaction.personal_finance_category?.detailed,
    transaction.category_primary,
    transaction.personal_finance_category?.primary,
  ].some((value) => /EQUIPMENT[_\s-]*RENTAL/i.test(String(value || "")));
}

export { PLAID_CATEGORY_INTENTS };
