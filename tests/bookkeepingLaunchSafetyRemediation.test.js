/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

test("Plaid policy is allowlisted and never maps arbitrary Equipment Rental", async () => {
  const { resolvePlaidCategoryIntent, isGenericEquipmentRentalBlocked } = await import("../src/services/bookkeeping/plaidCategoryIntentPolicy.js");
  assert.equal(resolvePlaidCategoryIntent({ category_detailed: "EQUIPMENT_RENTAL" }), null);
  assert.equal(isGenericEquipmentRentalBlocked({ category_detailed: "EQUIPMENT_RENTAL" }), true);
  assert.deepEqual(resolvePlaidCategoryIntent({ category_detailed: "GENERAL_MERCHANDISE_OFFICE_SUPPLIES" }), {
    intent: "office_supplies",
    plaid_category: "GENERAL_MERCHANDISE_OFFICE_SUPPLIES",
    source: "plaid_allowlist",
  });
});

test("generic intent scoring cannot infer Equipment Rental but manual account IDs remain untouched", async () => {
  const { mapIntentToCoa } = await import("../src/services/bookkeeping/intentToCoaMapper.js");
  const accounts = [{ id: "qbo-rental-7", name: "Equipment Rental", type: "Expense" }];
  assert.equal(mapIntentToCoa({ intent: "equipment_rental", coaAccounts: accounts }), null);
  assert.equal(accounts[0].id, "qbo-rental-7");
});

test("Amazon and Duke deterministic evidence stays authoritative", async () => {
  const { getUniversalVendorHintForTransaction } = await import("../src/services/bookkeeping/universalVendorHintMatcher.js");
  const amazon = getUniversalVendorHintForTransaction({ bankTxn: { name: "AMAZON MARKETPLACE NAMZN.COM/BILL", merchant_name: "Amazon" } });
  const duke = getUniversalVendorHintForTransaction({ bankTxn: { name: "BILL PAY DUKEENERGY 5612", merchant_name: "Duke Energy" } });
  assert.equal(amazon.primary_intent, "supplies_materials");
  assert.notEqual(amazon.primary_intent, "equipment_rental");
  assert.equal(duke.primary_intent, "electric");
  assert.equal(duke.confidence, "high");
  for (const bankTxn of [
    { merchant_name: "DUKE ENERGY" },
    { counterparty_name: "DUKEENERGY" },
    { name: "BILL PAY DUKEENERGY" },
    { name: "BILL PAY DUKEENERGY ********5612 RE" },
  ]) {
    const hint = getUniversalVendorHintForTransaction({ bankTxn });
    assert.equal(hint?.primary_intent, "electric");
    assert.equal(hint?.canonical_vendor, "Duke Energy");
  }
});

test("authoritative suggestion refresh replaces stale universal account pairs atomically", () => {
  const source = fs.readFileSync(new URL("../src/api/bookkeeping/routes/bookkeeping.suggest.routes.js", import.meta.url), "utf8");
  assert.match(source, /strongFreshUniversalEvidence\s*\n\s*\)/);
  assert.doesNotMatch(source, /strongFreshUniversalEvidence\s*&&\s*\(\s*existingSuggestedSuspense/);
  assert.match(source, /if \(!coaAccount\) return \{ id: null, name: "", type: null, subType: null \}/);
  assert.match(source, /suggested_qbo_account_id:\s*hintSuggested\.id/);
  assert.match(source, /suggested_qbo_account_name:\s*hintSuggested\.name/);
  assert.match(source, /suggested_canonical_account_key:\s*canonicalResolution\.canonical\?\.canonical_account_key/);
});

test("Rollin Out and Shahin normalize to stable distinct merchant identities", async () => {
  const { normalizeMerchantIdentity } = await import("../src/services/bookkeeping/merchantNormalization.js");
  assert.equal(normalizeMerchantIdentity("AplPay ROLLIN OUT LLC Charlotte 123456").normalized, "rollin out charlotte");
  assert.equal(normalizeMerchantIdentity("AplPay SHAHIN INC").normalized, "shahin");
  assert.equal(normalizeMerchantIdentity("Apple Pay SHAHIN INC 987654").normalized, "shahin");
});

function vendorRuleDb() {
  const rows = [];
  return {
    rows,
    from(table) {
      assert.equal(table, "vendor_rules");
      const filters = [];
      let mutation = null;
      const query = {
        select() { return this; },
        eq(column, value) { filters.push((row) => row[column] === value); return this; },
        not(column, op, value) { if (op === "is" && value === null) filters.push((row) => row[column] != null); return this; },
        order() { return this; },
        limit() { return this; },
        upsert(payload) { mutation = payload; return this; },
        maybeSingle() {
          if (mutation) {
            const index = rows.findIndex((row) => row.business_id === mutation.business_id && row.match_type === mutation.match_type && row.match_value === mutation.match_value);
            const saved = { ...(index >= 0 ? rows[index] : {}), ...mutation, id: index >= 0 ? rows[index].id : `rule-${rows.length + 1}` };
            if (index >= 0) rows[index] = saved; else rows.push(saved);
            return Promise.resolve({ data: saved, error: null });
          }
          return Promise.resolve({ data: rows.filter((row) => filters.every((filter) => filter(row)))[0] || null, error: null });
        },
        then(resolve) { return Promise.resolve({ data: rows.filter((row) => filters.every((filter) => filter(row))), error: null }).then(resolve); },
      };
      return query;
    },
  };
}

test("manual Rollin/Shahin rules are tenant-scoped, use stable QBO IDs, and latest correction wins", async () => {
  const { learnVendorRuleFromTransaction } = await import("../src/services/bookkeeping/vendorRuleLearner.js");
  const { getVendorRuleForTransaction } = await import("../src/services/bookkeeping/vendorRuleMatcher.js");
  const db = vendorRuleDb();
  const merchants = [
    { name: "AplPay ROLLIN OUT LLC Charlotte 123456", merchant_name: "Rollin Out LLC" },
    { name: "AplPay SHAHIN INC", merchant_name: "Shahin Inc" },
  ];
  for (const merchant of merchants) {
    const txn = { ...merchant, amount: -13.65, direction: "OUTFLOW" };
    const learned = await learnVendorRuleFromTransaction({ businessId: "biz-a", bankTxn: txn, finalAccountId: "qbo-meals-1", finalAccountName: "Meals", options: { actor: { id: "user-1", role: "user" } }, db });
    assert.equal(learned.ok, true);
    const future = await getVendorRuleForTransaction({ businessId: "biz-a", bankTransaction: txn, db });
    assert.equal(future.default_qbo_account_id, "qbo-meals-1");
    assert.equal(await getVendorRuleForTransaction({ businessId: "biz-b", bankTransaction: txn, db }), null);
  }
  const rollin = { ...merchants[0], amount: -20, direction: "OUTFLOW" };
  await learnVendorRuleFromTransaction({ businessId: "biz-a", bankTxn: rollin, finalAccountId: "qbo-supplies-2", finalAccountName: "Supplies", options: { actor: { id: "user-1", role: "user" } }, db });
  const corrected = await getVendorRuleForTransaction({ businessId: "biz-a", bankTransaction: rollin, db });
  assert.equal(corrected.default_qbo_account_id, "qbo-supplies-2");
  assert.equal(corrected.default_qbo_account_name, "Supplies");
});

test("explicit user-confirmed Equipment Rental rules remain business scoped", async () => {
  const { learnVendorRuleFromTransaction } = await import("../src/services/bookkeeping/vendorRuleLearner.js");
  const { getVendorRuleForTransaction } = await import("../src/services/bookkeeping/vendorRuleMatcher.js");
  const db = vendorRuleDb();
  const txn = {
    name: "UNITED RENTALS 4812",
    merchant_name: "United Rentals",
    amount: -425,
    direction: "OUTFLOW",
  };
  const learned = await learnVendorRuleFromTransaction({
    businessId: "biz-rental",
    bankTxn: txn,
    finalAccountId: "qbo-equipment-rental-9",
    finalAccountName: "Equipment Rental",
    options: { actor: { id: "user-7", role: "user" } },
    db,
  });
  assert.equal(learned.ok, true);
  const sameBusiness = await getVendorRuleForTransaction({ businessId: "biz-rental", bankTransaction: txn, db });
  assert.equal(sameBusiness.default_qbo_account_id, "qbo-equipment-rental-9");
  assert.equal(await getVendorRuleForTransaction({ businessId: "biz-other", bankTransaction: txn, db }), null);
});

test("approval keeps rule-learning failures visible and durably retryable", () => {
  const approval = fs.readFileSync(new URL("../src/services/bookkeeping/bookkeepingApprovalService.js", import.meta.url), "utf8");
  const ui = fs.readFileSync(new URL("../src/pages/accounting/BookkeepingCleanup.jsx", import.meta.url), "utf8");
  const migration = fs.readFileSync(new URL("../supabase/migrations/20261002120000_vendor_rule_learning_jobs.sql", import.meta.url), "utf8");
  assert.match(approval, /vendor_rule_learning_jobs/);
  assert.match(approval, /approval_succeeded:\s*true/);
  assert.match(approval, /retryable:\s*true/);
  assert.match(ui, /Approved; merchant learning will retry/);
  assert.match(migration, /unique \(business_id, transaction_id\)/i);
});

test("Books Review labels suggested, unsaved, final, and blocker states", () => {
  const ui = fs.readFileSync(new URL("../src/components/Accounting/BookkeepingTransactionMirrorTable.jsx", import.meta.url), "utf8");
  assert.match(ui, /User-selected · Not saved/);
  assert.match(ui, /Final approved account/);
  assert.match(ui, /Suggested account/);
  assert.match(ui, /Blocked:/);
});

test("current explicit account selection is the account submitted for confirmation", () => {
  const ui = fs.readFileSync(new URL("../src/pages/accounting/BookkeepingCleanup.jsx", import.meta.url), "utf8");
  assert.match(ui, /const glAccountId = newAccountId \|\| txn\.glAccountId \|\| txn\.suggestedAccountId \|\| null/);
  assert.match(ui, /newAccountId: glAccountId, newAccountName: glAccountName/);
});

test("precedence protects final rows and lets deterministic evidence replace only stale unresolved suggestions", () => {
  const suggest = fs.readFileSync(new URL("../src/api/bookkeeping/routes/bookkeeping.suggest.routes.js", import.meta.url), "utf8");
  const lifecycle = fs.readFileSync(new URL("../src/services/bookkeeping/bookkeepingLifecycleState.js", import.meta.url), "utf8");
  assert.match(lifecycle, /isHandledReviewStatus\(row\.status\) \|\| Boolean\(row\.final_qbo_account_id \|\| row\.qbo_txn_id \|\| row\.posted_at\)/);
  assert.match(suggest, /Business-learned vendor rules are the strongest category signal and should win before global hints/);
  assert.match(suggest, /strongFreshUniversalEvidence/);
  assert.match(suggest, /bypassExistingForFreshEvidence/);
  assert.match(suggest, /existingCat && existingCat\.suggested_qbo_account_id && !bypassExistingForFreshEvidence/);
  assert.match(suggest, /source:\s*"plaid_allowlist"/);
  assert.match(suggest, /Fallback to/);
});
