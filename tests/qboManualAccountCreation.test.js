import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  createManualQboAccountForBusiness,
  QboManualAccountCreationError,
} from "../src/services/bookkeeping/qboManualAccountCreationService.js";
import {
  normalizeExpectedQboAccountCreationResult,
} from "../src/services/bookkeeping/qboAccountCreationErrors.js";
import {
  getManualQboAccountCatalog,
  isValidManualQboAccountSubType,
} from "../src/services/bookkeeping/qboAccountTypes.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";

function qboMock(created = {}) {
  return {
    account: {
      create(payload, cb) {
        cb(null, {
          Account: {
            Id: created.id || "99",
            Name: payload.Name,
            AccountType: payload.AccountType,
            AccountSubType: payload.AccountSubType,
            Active: true,
          },
        });
      },
    },
  };
}

async function createWith({
  accountType = "Expense",
  accountSubType = "OtherBusinessExpenses",
  activeAccounts = [],
  inactiveAccounts = [],
  getQBOClient = async () => qboMock(),
} = {}) {
  return createManualQboAccountForBusiness({
    businessId: BUSINESS_ID,
    name: "Charitable Contributions",
    accountType,
    accountSubType,
    description: "Manual account",
    actor: "tester",
    deps: {
      getQBOClient,
      findAccountsByActive: async (_qbo, active) => (active ? activeAccounts : inactiveAccounts),
    },
  });
}

test("manual QBO account catalog exposes only supported P&L account types", () => {
  const types = getManualQboAccountCatalog().map((entry) => entry.accountType);
  assert.deepEqual(types, ["Income", "Other Income", "Expense", "Cost of Goods Sold"]);
});

test("manual QBO account creation accepts valid Expense, COGS, Income, and Other Income accounts", async () => {
  const rows = [
    ["Expense", "OtherBusinessExpenses"],
    ["Cost of Goods Sold", "OtherCostsOfServiceCos"],
    ["Income", "ServiceFeeIncome"],
    ["Other Income", "OtherMiscellaneousIncome"],
  ];
  for (const [accountType, accountSubType] of rows) {
    const result = await createWith({ accountType, accountSubType });
    assert.equal(result.ok, true);
    assert.equal(result.account.type, accountType);
    assert.equal(result.account.subType, accountSubType);
  }
});

test("manual QBO account creation rejects invalid account type", async () => {
  await assert.rejects(
    createWith({ accountType: "Bank", accountSubType: "Checking" }),
    (err) => err instanceof QboManualAccountCreationError && err.error === "invalid_qbo_account_type"
  );
});

test("manual QBO account creation rejects invalid subtype/type combination", async () => {
  assert.equal(isValidManualQboAccountSubType("Expense", "ServiceFeeIncome"), false);
  await assert.rejects(
    createWith({ accountType: "Expense", accountSubType: "ServiceFeeIncome" }),
    (err) => err instanceof QboManualAccountCreationError && err.error === "invalid_qbo_account_type_detail_type"
  );
});

test("manual QBO account creation rejects active duplicate names without numbering", async () => {
  await assert.rejects(
    createWith({
      activeAccounts: [{ id: "7", name: "Charitable   Contributions", type: "Expense", subType: "CharitableContributions", active: true }],
    }),
    (err) =>
      err instanceof QboManualAccountCreationError &&
      err.error === "qbo_account_already_exists" &&
      err.details.existing_account.id === "7"
  );
});

test("manual QBO account creation rejects inactive duplicate names", async () => {
  await assert.rejects(
    createWith({
      inactiveAccounts: [{ id: "8", name: "Charitable Contributions", type: "Expense", subType: "CharitableContributions", active: false }],
    }),
    (err) =>
      err instanceof QboManualAccountCreationError &&
      err.error === "qbo_inactive_account_exists" &&
      err.details.existing_account.id === "8"
  );
});

test("manual QBO account creation rejects disconnected QuickBooks", async () => {
  await assert.rejects(
    createWith({ getQBOClient: async () => { throw new Error("quickbooks_needs_reconnect"); } }),
    (err) => err instanceof QboManualAccountCreationError && err.error === "quickbooks_reconnect_required"
  );
});

test("manual QBO account creation sanitizes provider failures", async () => {
  await assert.rejects(
    createWith({
      getQBOClient: async () => ({
        account: {
          create(_payload, cb) {
            cb({ message: "Bearer secret-token raw provider payload" });
          },
        },
      }),
    }),
    (err) =>
      err instanceof QboManualAccountCreationError &&
      err.error === "qbo_account_create_failed" &&
      !/secret-token/.test(err.message)
  );
});

test("manual QBO account creation uses the provided customer business id, not a staff business id", async () => {
  let usedBusinessId = "";
  const result = await createManualQboAccountForBusiness({
    businessId: BUSINESS_ID,
    name: "Job Materials",
    accountType: "Cost of Goods Sold",
    accountSubType: "SuppliesMaterialsCogs",
    deps: {
      getQBOClient: async (businessId) => {
        usedBusinessId = businessId;
        return qboMock();
      },
      findAccountsByActive: async () => [],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(usedBusinessId, BUSINESS_ID);
  assert.notEqual(usedBusinessId, STAFF_BUSINESS_ID);
});

test("manual QBO account creation service does not mutate transaction categorization state", async () => {
  const calls = [];
  await createManualQboAccountForBusiness({
    businessId: BUSINESS_ID,
    name: "Services Revenue",
    accountType: "Income",
    accountSubType: "ServiceFeeIncome",
    deps: {
      getQBOClient: async () => qboMock(),
      findAccountsByActive: async () => {
        calls.push("findAccountsByActive");
        return [];
      },
    },
  });
  assert.deepEqual(calls, ["findAccountsByActive", "findAccountsByActive"]);
});

test("customer and admin routes preserve tenant and read-only boundaries", () => {
  const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const customerRoutes = fs.readFileSync(new URL("../src/api/bookkeeping/routes/bookkeeping.qboCoaCreate.routes.js", import.meta.url), "utf8");
  const adminRoutes = fs.readFileSync(new URL("../src/api/admin/monthlyReview.routes.js", import.meta.url), "utf8");
  assert.match(server, /app\.use\("\/api\/bookkeeping", \.\.\.requireCustomerOrAdminView, bookkeepingPlaidRouter\)/);
  assert.match(server, /rejectAdminViewWrites\(\)/);
  assert.match(customerRoutes, /router\.post\("\/qbo\/accounts"/);
  assert.match(adminRoutes, /router\.post\("\/businesses\/:businessId\/qbo\/accounts"/);
  assert.match(adminRoutes, /assertMonthlyReviewBusinessExists\(req\.params\.businessId\)/);
});

test("shared dropdown source keeps add-account pinned and transaction actions explicit", () => {
  const dropdown = fs.readFileSync(new URL("../src/components/Accounting/BookkeepingFeed.jsx", import.meta.url), "utf8");
  const modal = fs.readFileSync(new URL("../src/components/Accounting/CreateQuickBooksAccountModal.jsx", import.meta.url), "utf8");
  const mirror = fs.readFileSync(new URL("../src/components/Accounting/BookkeepingTransactionMirrorTable.jsx", import.meta.url), "utf8");
  const monthly = fs.readFileSync(new URL("../src/pages/Admin/MonthlyReviewConsole.jsx", import.meta.url), "utf8");
  assert.ok(dropdown.indexOf("Add new account") < dropdown.indexOf("Search accounts"));
  assert.match(dropdown, /sticky top-0/);
  assert.match(modal, /Create Account/);
  assert.match(mirror, /onCreatedAccountSelect/);
  assert.match(monthly, /Confirm Reclass/);
  assert.match(monthly, /handlePnlAccountDraftChange\(txn, String\(account\.id\)\)/);
});

test("manual account creation modal removes show-all checkbox and native selects", () => {
  const modal = fs.readFileSync(new URL("../src/components/Accounting/CreateQuickBooksAccountModal.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(modal, /Show all P&L account types/);
  assert.doesNotMatch(modal, /type="checkbox"/);
  assert.doesNotMatch(modal, /<select\b/);
  assert.doesNotMatch(modal, /<option\b/);
  assert.match(modal, /role="listbox"/);
  assert.match(modal, /aria-haspopup="listbox"/);
  assert.match(modal, /ArrowDown/);
  assert.match(modal, /ArrowUp/);
  assert.match(modal, /max-h-56 overflow-y-auto/);
});

test("manual account creation modal always exposes the four supported P&L account types", () => {
  const modal = fs.readFileSync(new URL("../src/components/Accounting/CreateQuickBooksAccountModal.jsx", import.meta.url), "utf8");
  const catalogTypes = getManualQboAccountCatalog().map((entry) => entry.accountType);
  assert.deepEqual(catalogTypes, ["Income", "Other Income", "Expense", "Cost of Goods Sold"]);
  assert.match(modal, /DEFAULT_ACCOUNT_TYPES\.map\(\(fallback\) =>/);
  assert.match(modal, /fromCatalog \|\| fallback/);
  assert.doesNotMatch(modal, /Bank/);
  assert.doesNotMatch(modal, /Credit Card/);
  assert.doesNotMatch(modal, /Accounts Receivable/);
  assert.doesNotMatch(modal, /Accounts Payable/);
  assert.doesNotMatch(modal, /Liabilities/);
  assert.doesNotMatch(modal, /Equity/);
});

test("manual account creation modal uses safe transaction-aware defaults without filtering choices", () => {
  const modal = fs.readFileSync(new URL("../src/components/Accounting/CreateQuickBooksAccountModal.jsx", import.meta.url), "utf8");
  assert.match(modal, /function defaultTypeForContext/);
  assert.match(modal, /return "Income";/);
  assert.match(modal, /return "Expense";/);
  assert.match(modal, /Expense: "OtherBusinessExpenses"/);
  assert.match(modal, /"Cost of Goods Sold": "OtherCostsOfServiceCos"/);
  assert.doesNotMatch(modal, /return "Cost of Goods Sold";/);
});

test("manual account creation modal updates detail type when account type changes and preserves success behavior", () => {
  const modal = fs.readFileSync(new URL("../src/components/Accounting/CreateQuickBooksAccountModal.jsx", import.meta.url), "utf8");
  const dropdown = fs.readFileSync(new URL("../src/components/Accounting/BookkeepingFeed.jsx", import.meta.url), "utf8");
  assert.match(modal, /const selectedType = supportedTypes\.find/);
  assert.match(modal, /const subTypes = React\.useMemo\(\(\) => selectedType\.subTypes \|\| \[\]/);
  assert.match(modal, /setAccountSubType\(preferredSubTypeForAccountType\(selectedType\.accountType, subTypes\)\)/);
  assert.match(modal, /onChange=\{setAccountType\}/);
  assert.match(modal, /onChange=\{setAccountSubType\}/);
  assert.match(dropdown, /onCreatedAccountSelect \? onCreatedAccountSelect\(createdAccount\) : onChange\(createdAccount\.id\)/);
});

test("expected duplicate account conflicts normalize to inline modal state", () => {
  const result = normalizeExpectedQboAccountCreationResult({
    status: 409,
    body: {
      error: "qbo_account_already_exists",
      existing_account: {
        id: "42",
        name: "Charitable Contributions",
        active: true,
      },
    },
  });
  assert.deepEqual(result, {
    ok: false,
    expected: true,
    code: "qbo_account_already_exists",
    error: "qbo_account_already_exists",
    existing_account_id: "42",
    existing_account_name: "Charitable Contributions",
    active: true,
    existing_account: {
      id: "42",
      name: "Charitable Contributions",
      active: true,
    },
  });
  assert.equal(normalizeExpectedQboAccountCreationResult({ status: 500, body: { error: "qbo_account_create_failed" } }), null);
});

test("shared account creation modal is a body portal with global viewport layering and focus handling", () => {
  const modal = fs.readFileSync(new URL("../src/components/Accounting/CreateQuickBooksAccountModal.jsx", import.meta.url), "utf8");
  const dropdown = fs.readFileSync(new URL("../src/components/Accounting/BookkeepingFeed.jsx", import.meta.url), "utf8");
  assert.match(modal, /ReactDOM\.createPortal/);
  assert.match(modal, /document\.body/);
  assert.match(modal, /fixed inset-0 z-\[2147483000\]/);
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /nameInputRef\.current\?\.focus\(\)/);
  assert.match(modal, /const returnFocusNode = returnFocusRef\?\.current \|\| null/);
  assert.match(modal, /returnFocusNode\?\.focus\?\.\(\)/);
  assert.match(modal, /event\.key === "Escape"/);
  assert.match(modal, /event\.key !== "Tab"/);
  assert.match(modal, /event\.stopPropagation\(\)/);
  assert.match(dropdown, /setOpen\(false\);\s*setCreateOpen\(true\);/);
  assert.match(dropdown, /returnFocusRef=\{buttonRef\}/);
});

test("Books Review row keyboard handler ignores editable and modal targets", () => {
  const dropdown = fs.readFileSync(new URL("../src/components/Accounting/BookkeepingFeed.jsx", import.meta.url), "utf8");
  assert.match(dropdown, /function isEditableKeyboardTarget/);
  assert.match(dropdown, /input, textarea, select/);
  assert.match(dropdown, /\[role="textbox"\]/);
  assert.match(dropdown, /\[role="combobox"\]/);
  assert.match(dropdown, /\[data-qbo-account-modal="true"\]/);
  assert.match(dropdown, /if \(isEditableKeyboardTarget\(e\.target\)\) return;/);
});
