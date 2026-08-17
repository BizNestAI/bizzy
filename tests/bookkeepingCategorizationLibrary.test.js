import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getUniversalVendorHintForTransaction } from "../src/services/bookkeeping/universalVendorHintMatcher.js";
import { mapIntentToCoa } from "../src/services/bookkeeping/intentToCoaMapper.js";
import { classifyTaxonomy } from "../src/services/bookkeeping/taxonomyClassifier.js";

const root = process.cwd();

const coa = [
  { id: "sales", name: "Sales", type: "Income" },
  { id: "other_income", name: "Other Income", type: "Income" },
  { id: "fees", name: "Bank Charges & Fees", type: "Expense" },
  { id: "internet", name: "Internet Services", type: "Expense" },
  { id: "electric", name: "Electric", type: "Expense" },
  { id: "charging", name: "Gas/Charging", type: "Expense" },
  { id: "gas", name: "Gas", type: "Expense" },
  { id: "meals", name: "Meals", type: "Expense" },
  { id: "parking", name: "Parking/Tolls", type: "Expense" },
  { id: "software", name: "Software", type: "Expense" },
  { id: "entertainment", name: "Entertainment", type: "Expense" },
  { id: "clothing", name: "Clothing", type: "Expense" },
  { id: "transportation", name: "Transportation", type: "Expense" },
  { id: "rideshare", name: "Lyft/Uber", type: "Expense" },
  { id: "materials", name: "Supplies & Materials", type: "Expense" },
  { id: "licenses", name: "Business Licensing Fees", type: "Expense" },
  { id: "uncat", name: "Uncategorized Expense", type: "Expense" },
];

function hintFor(name, overrides = {}) {
  return getUniversalVendorHintForTransaction({
    bankTxn: {
      name,
      amount: overrides.amount ?? -10,
      direction: overrides.direction || "OUTFLOW",
      ...overrides,
    },
  });
}

test("Intuit invoice deposits and transaction fees map to Sales and Bank Charges & Fees", () => {
  const deposit = hintFor("DEPOSIT INTUIT 85873813 OPTIMIST B", { amount: 500, direction: "INFLOW" });
  assert.equal(deposit.primary_intent, "sales");
  assert.equal(mapIntentToCoa({ intent: deposit.primary_intent, coaAccounts: coa }).qbo_account_name, "Sales");

  const fee = hintFor("TRAN FEE INTUIT 87361313 OPTIMIST B", { amount: -14, direction: "OUTFLOW" });
  assert.equal(fee.primary_intent, "bank_fees");
  assert.equal(mapIntentToCoa({ intent: fee.primary_intent, coaAccounts: coa }).qbo_account_name, "Bank Charges & Fees");
});

test("specific utility vendors prefer specific utility accounts", () => {
  const att = hintFor("PAYMENT ATT PAYT patrick gebhard");
  assert.equal(att.primary_intent, "internet_services");
  assert.equal(mapIntentToCoa({ intent: att.primary_intent, coaAccounts: coa }).qbo_account_name, "Internet Services");
  assert.equal(
    mapIntentToCoa({
      intent: att.primary_intent,
      coaAccounts: [
        { id: "phone", name: "Phone Bill", type: "Expense" },
        { id: "internet", name: "Internet", type: "Expense" },
      ],
    }).qbo_account_name,
    "Internet"
  );
  assert.equal(
    mapIntentToCoa({
      intent: att.primary_intent,
      coaAccounts: [{ id: "phone", name: "Phone Bill", type: "Expense" }],
    }),
    null
  );

  const duke = hintFor("BILL PAY DUKEENERGY ********5612 RE");
  assert.equal(duke.primary_intent, "electric");
  assert.equal(mapIntentToCoa({ intent: duke.primary_intent, coaAccounts: coa }).qbo_account_name, "Electric");
});

test("Tesla charging, Costco, and Secretary of State filings map to the intended accounts", () => {
  const tesla = hintFor("TESLA MOTO TESLA MOTORS 2WOADE1");
  assert.equal(tesla.primary_intent, "gas_charging");
  assert.equal(mapIntentToCoa({ intent: tesla.primary_intent, coaAccounts: coa }).qbo_account_name, "Gas/Charging");

  const costco = hintFor("COSTCO WHSE 1234");
  assert.equal(costco.primary_intent, "materials");
  assert.equal(mapIntentToCoa({ intent: costco.primary_intent, coaAccounts: coa }).qbo_account_name, "Supplies & Materials");

  const filing = hintFor("FILINGS NC SECRETARY OF STATE");
  assert.equal(filing.primary_intent, "business_licensing_fees");
  assert.equal(mapIntentToCoa({ intent: filing.primary_intent, coaAccounts: coa }).qbo_account_name, "Business Licensing Fees");
});

test("ambiguous Venmo and cocktail bar memos are not forced into a category", () => {
  assert.equal(hintFor("VENMO PAYMENT JOHN SMITH"), null);
  assert.equal(hintFor("DOTDOTDOT CHARLOTTE COCKTAIL BAR"), null);
});

test("credit card payment classifier recognizes issuer-specific and paired payment context", () => {
  const amex = classifyTaxonomy({
    name: "ACH PMT AMEX EPAYMENT M3358 INTERNET",
    amount: -322.57,
    direction: "OUTFLOW",
  });
  assert.equal(amex.type, "cc_payment");

  const discover = classifyTaxonomy({
    name: "E-PAYMENT DISCOVER 9734 INTERNET",
    amount: -133.92,
    direction: "OUTFLOW",
  });
  assert.equal(discover.type, "cc_payment");

  const chase = classifyTaxonomy({
    name: "EPAY CHASE CREDIT CRD",
    amount: -517.55,
    direction: "OUTFLOW",
  });
  assert.equal(chase.type, "cc_payment");

  const mobilePayment = classifyTaxonomy(
    {
      name: "MOBILE PAYMENT - THANK YOU",
      amount: 322.57,
      direction: "INFLOW",
    },
    { currentAccountType: "credit", currentAccountSubtype: "credit card" }
  );
  assert.equal(mobilePayment.type, "cc_payment");

  const genericThankYou = classifyTaxonomy(
    {
      name: "Payment Thank You-Mobile",
      amount: 3303.52,
      direction: "INFLOW",
    },
    { currentAccountType: "credit", currentAccountSubtype: "credit card" }
  );
  assert.equal(genericThankYou.type, "cc_payment");
});

test("parking vendors map to Parking/Tolls instead of broad transportation accounts", () => {
  const parkMobile = hintFor("PARK MOBILE CDOT PAY", { amount: -3.12 });
  assert.equal(parkMobile.primary_intent, "parking_tolls");

  const mapped = mapIntentToCoa({ intent: parkMobile.primary_intent, coaAccounts: coa });
  assert.equal(mapped.qbo_account_name, "Parking/Tolls");
});

test("known restaurant vendors map to Meals instead of Lyft/Uber", () => {
  const names = [
    "McDonald's",
    "10093 CAVA SOUTHEND",
    "Chipotle Mexican Grill",
    "Chick-fil-A",
    "Bonefish Grill",
  ];

  for (const name of names) {
    const hint = hintFor(name);
    assert.equal(hint.primary_intent, "meals", name);
    assert.equal(mapIntentToCoa({ intent: hint.primary_intent, coaAccounts: coa }).qbo_account_name, "Meals", name);
  }
});

test("software and subscription vendors map to Software", () => {
  const names = [
    "ATLASSIAN",
    "APPLE.COM/BILL",
    "PARAMOUNT+",
    "YOUTUBETV",
    "Workspace_bizn",
    "ADOBE *800-833-6687",
    "OPENAI *CHATGPT SUBSCR",
    "FIGMA",
    "INSTANTLY",
    "SPOTIFY",
    "RAILWAY",
    "CANVA",
    "SUPABASE SINGAPORE SG",
  ];

  for (const name of names) {
    const hint = hintFor(name);
    assert.equal(hint.primary_intent, "software", name);
    assert.equal(mapIntentToCoa({ intent: hint.primary_intent, coaAccounts: coa }).qbo_account_name, "Software", name);
  }
});

test("gas station vendors use Meals for small purchases and Gas for larger fuel-like purchases", () => {
  const smallGasStationPurchases = [
    "QUIKTRIP 1234",
    "WAWA# 5321",
    "SPINX #271",
    "SPEEDWAY",
    "SPPEDWAY",
    "CIRCLE K 1234",
    "SHEETZ 0001",
  ];

  for (const name of smallGasStationPurchases) {
    const hint = hintFor(name, { amount: -6.73 });
    assert.equal(hint.primary_intent, "meals", name);
    assert.equal(mapIntentToCoa({ intent: hint.primary_intent, coaAccounts: coa }).qbo_account_name, "Meals", name);
  }

  const largerFuel = hintFor("WAWA# 5321", { amount: -52.18 });
  assert.equal(largerFuel.primary_intent, "fuel");
  assert.equal(mapIntentToCoa({ intent: largerFuel.primary_intent, coaAccounts: coa }).qbo_account_name, "Gas");
});

test("retail and grocery vendors map to the requested materials or meals accounts", () => {
  const materialsNames = ["Walmart", "Target", "Walgreens"];
  for (const name of materialsNames) {
    const hint = hintFor(name);
    assert.equal(hint.primary_intent, "materials", name);
    assert.equal(mapIntentToCoa({ intent: hint.primary_intent, coaAccounts: coa }).qbo_account_name, "Supplies & Materials", name);
  }

  const mealsNames = [
    "Publix",
    "Whole Foods",
    "Starbucks",
    "Panera Bread",
    "Smoothie King",
    "Lowes Foods",
    "CRUMBL",
    "CTLP*SHORT STOP VENDIN",
    "MICRO MART",
    "PoppyCox",
    "DOORDASH",
    "UBER EATS",
  ];
  for (const name of mealsNames) {
    const hint = hintFor(name);
    assert.equal(hint.primary_intent, "meals", name);
    assert.equal(mapIntentToCoa({ intent: hint.primary_intent, coaAccounts: coa }).qbo_account_name, "Meals", name);
  }
});

test("entertainment and clothing vendors map to their dedicated accounts", () => {
  const entertainmentNames = ["Ticketmaster", "Fandango", "Monster Mini Golf", "Rebill Gametime", "Gametime"];
  for (const name of entertainmentNames) {
    const hint = hintFor(name);
    assert.equal(hint.primary_intent, "entertainment", name);
    assert.equal(mapIntentToCoa({ intent: hint.primary_intent, coaAccounts: coa }).qbo_account_name, "Entertainment", name);
  }

  const clothingNames = ["Nordstrom", "Dillards", "Dillard's"];
  for (const name of clothingNames) {
    const hint = hintFor(name);
    assert.equal(hint.primary_intent, "clothing", name);
    assert.equal(mapIntentToCoa({ intent: hint.primary_intent, coaAccounts: coa }).qbo_account_name, "Clothing", name);
  }
});

test("movie, gaming, charging, toll, cashback, and Amazon batch rules map correctly", () => {
  const entertainmentNames = [
    "AMC 0685 PARK TERRACCHARLOTTE",
    "AMC 9640 ONLINE*9640LEAWOOD",
    "PRIME VIDEO CHANNELS AMZN.COM/BILL",
    "PLAYSTATION NETWORK",
  ];
  for (const name of entertainmentNames) {
    const hint = hintFor(name);
    assert.equal(hint.primary_intent, "entertainment", name);
    assert.equal(mapIntentToCoa({ intent: hint.primary_intent, coaAccounts: coa }).qbo_account_name, "Entertainment", name);
  }

  const chargeOnSite = hintFor("AplPay CHARGEONSITE.CHARLOTTE", { amount: -21.81 });
  assert.equal(chargeOnSite.primary_intent, "gas_charging");
  assert.equal(mapIntentToCoa({ intent: chargeOnSite.primary_intent, coaAccounts: coa }).qbo_account_name, "Gas/Charging");

  const quickPass = hintFor("NC QUICK PASS");
  assert.equal(quickPass.primary_intent, "parking_tolls");
  assert.equal(mapIntentToCoa({ intent: quickPass.primary_intent, coaAccounts: coa }).qbo_account_name, "Parking/Tolls");

  const lot = hintFor("PPS - SURFACE LOT");
  assert.equal(lot.primary_intent, "parking_tolls");
  assert.equal(mapIntentToCoa({ intent: lot.primary_intent, coaAccounts: coa }).qbo_account_name, "Parking/Tolls");

  const carillonPark = hintFor("99072 - THE CARILLON PARK");
  assert.equal(carillonPark.primary_intent, "parking_tolls");
  assert.equal(mapIntentToCoa({ intent: carillonPark.primary_intent, coaAccounts: coa }).qbo_account_name, "Parking/Tolls");

  const cashBack = hintFor("Cash Back Reward", { amount: 12.34, direction: "INFLOW" });
  assert.equal(cashBack.primary_intent, "other_income");
  assert.equal(mapIntentToCoa({ intent: cashBack.primary_intent, coaAccounts: coa }).qbo_account_name, "Other Income");

  const statementCredit = hintFor("AUTOMATIC STATEMENT CREDIT", { amount: 1.63, direction: "INFLOW" });
  assert.equal(statementCredit.primary_intent, "other_income");
  assert.equal(mapIntentToCoa({ intent: statementCredit.primary_intent, coaAccounts: coa }).qbo_account_name, "Other Income");

  const amazonMaterials = hintFor("AMAZON MKTPLACE PMTS", { amount: -42.18 });
  assert.equal(amazonMaterials.primary_intent, "materials");
  assert.equal(mapIntentToCoa({ intent: amazonMaterials.primary_intent, coaAccounts: coa }).qbo_account_name, "Supplies & Materials");

  const amazonSubscriptionEight = hintFor("AMAZON MKTPLACE PMTS", { amount: -8 });
  assert.equal(amazonSubscriptionEight.primary_intent, "software");
  assert.equal(mapIntentToCoa({ intent: amazonSubscriptionEight.primary_intent, coaAccounts: coa }).qbo_account_name, "Software");

  const amazonPrimeEight = hintFor("Amazon Prime", { amount: -8 });
  assert.equal(amazonPrimeEight.primary_intent, "software");
  assert.equal(mapIntentToCoa({ intent: amazonPrimeEight.primary_intent, coaAccounts: coa }).qbo_account_name, "Software");

  const amazonSubscriptionEightNinetyNine = hintFor("AMAZON MKTPLACE PMTS", { amount: -8.99 });
  assert.equal(amazonSubscriptionEightNinetyNine.primary_intent, "software");
  assert.equal(mapIntentToCoa({ intent: amazonSubscriptionEightNinetyNine.primary_intent, coaAccounts: coa }).qbo_account_name, "Software");
});

test("Lime maps to Transportation", () => {
  const lime = hintFor("LIME RIDE");
  assert.equal(lime.primary_intent, "transportation");
  assert.equal(mapIntentToCoa({ intent: lime.primary_intent, coaAccounts: coa }).qbo_account_name, "Transportation");
});

test("suggest route uses same-amount credit-card context without amount-only matching", () => {
  const source = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.suggest.routes.js"), "utf8");

  assert.match(source, /findCreditCardPaymentPairTxnId/);
  assert.match(source, /hasCreditCardPaymentMemoSignal\(row\)/);
  assert.match(source, /plaidAccountLooksCredit/);
  assert.match(source, /cc_payment_pair_txn_id/);
});
