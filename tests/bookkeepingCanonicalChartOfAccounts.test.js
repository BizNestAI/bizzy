import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isChartAccountEligible,
  normalizeChartOfAccount,
} from "../src/services/bookkeeping/qboAccounts.js";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

const qboAccounts = [
  {
    Id: "10",
    Name: "Creation",
    FullyQualifiedName: "Creation",
    AccountType: "Expense",
    AccountSubType: "OtherBusinessExpenses",
    Active: true,
    SubAccount: false,
  },
  {
    Id: "11",
    Name: "Creation Sub",
    FullyQualifiedName: "Creation:Creation Sub",
    AccountType: "Expense",
    AccountSubType: "OtherBusinessExpenses",
    Active: true,
    SubAccount: true,
    ParentRef: { value: "10", name: "Creation" },
  },
];

test("canonical QBO account normalization preserves parent and active subaccount hierarchy", () => {
  const [parent, child] = qboAccounts.map((account) => normalizeChartOfAccount(account));
  assert.equal(parent.id, "10");
  assert.equal(parent.name, "Creation");
  assert.equal(child.id, "11");
  assert.equal(child.shortName, "Creation Sub");
  assert.equal(child.name, "Creation:Creation Sub");
  assert.equal(child.fullyQualifiedName, "Creation:Creation Sub");
  assert.equal(child.subAccount, true);
  assert.deepEqual(child.parentRef, { id: "10", name: "Creation" });
  assert.equal(child.depth, 1);
  assert.match(child.searchText, /creation sub/);
  assert.equal(isChartAccountEligible(child, "categorize"), true);
  assert.equal(isChartAccountEligible(child, "expense"), true);
});

test("workflow eligibility is centralized without removing valid posting subaccounts", () => {
  const expenseChild = normalizeChartOfAccount(qboAccounts[1]);
  const creditCardChild = normalizeChartOfAccount({
    ...qboAccounts[1],
    Id: "12",
    AccountType: "CreditCard",
    FullyQualifiedName: "Cards:Operating Card",
  });
  assert.equal(isChartAccountEligible(expenseChild, "credit_card_payment"), false);
  assert.equal(isChartAccountEligible(creditCardChild, "credit_card_payment"), true);
  assert.equal(isChartAccountEligible({ ...expenseChild, active: false }, "categorize"), false);
});

test("Books Review and Monthly Review consume the same subaccount-inclusive canonical fetcher", () => {
  const service = read("src/services/bookkeeping/qboAccounts.js");
  const booksRoute = read("src/api/bookkeeping/routes/bookkeeping.accounts.routes.js");
  const monthlyRoute = read("src/api/admin/monthlyReview.routes.js");
  const legacyRoute = read("src/api/accounting/bookkeeping.routes.js");

  assert.match(service, /includeSubaccounts = opts\?\.includeSubaccounts !== false/);
  assert.match(service, /normalizeChartOfAccount/);
  assert.match(booksRoute, /fetchChartOfAccounts\(businessId, \{ forceRefresh \}\)/);
  assert.match(monthlyRoute, /fetchChartOfAccounts\(businessId, \{ includeSubaccounts: true \}\)/);
  assert.match(monthlyRoute, /fullyQualifiedName: account\.fullyQualifiedName \|\| account\.name/);
  assert.match(legacyRoute, /import \{ fetchChartOfAccounts \} from "\.\.\/\.\.\/services\/bookkeeping\/qboAccounts\.js"/);
  assert.doesNotMatch(legacyRoute, /!a\.SubAccount/);
});

test("shared selectors search and display hierarchy while keeping exact QBO ids", () => {
  const dropdown = read("src/components/Accounting/BookkeepingFeed.jsx");
  const split = read("src/components/Accounting/SplitTransactionModal.jsx");

  assert.match(dropdown, /a\.fullyQualifiedName\?\.toLowerCase\(\)\.includes\(term\)/);
  assert.match(dropdown, /a\.parentRef\?\.name\?\.toLowerCase\(\)\.includes\(term\)/);
  assert.match(dropdown, /acct\.fullyQualifiedName \|\| acct\.name/);
  assert.match(dropdown, /onChange\(acct\.id\)/);
  assert.match(split, /account\.fullyQualifiedName \|\| account\.FullyQualifiedName \|\| account\.name/);
});

test("successful account creation invalidates the business-scoped canonical catalog", () => {
  const creation = read("src/services/bookkeeping/qboManualAccountCreationService.js");
  assert.match(creation, /invalidateChartOfAccountsCache\(businessId\)/);
  assert.ok(creation.indexOf("invalidateChartOfAccountsCache(businessId)") > creation.indexOf("createFn.call"));
});
