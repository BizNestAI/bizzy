/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const ROOT = new URL("../", import.meta.url);

function read(path) {
  return fs.readFileSync(new URL(path, ROOT), "utf8");
}

function makeVendorRuleDb(rows = []) {
  return {
    from(table) {
      assert.equal(table, "vendor_rules");
      const filters = [];
      return {
        select() { return this; },
        eq(column, value) {
          filters.push((row) => row[column] === value);
          return this;
        },
        not(column, op, value) {
          if (op === "is" && value === null) filters.push((row) => row[column] !== null && row[column] !== undefined);
          return this;
        },
        order() { return this; },
        limit() { return this; },
        then(resolve) {
          resolve({ data: rows.filter((row) => filters.every((fn) => fn(row))), error: null });
        },
      };
    },
  };
}

test("Monthly Review Needs Review decisions use the shared approval path that learns vendor rules", () => {
  const reclassification = read("src/services/bookkeeping/bookkeepingReclassificationService.js");
  const approval = read("src/services/bookkeeping/bookkeepingApprovalService.js");
  const route = read("src/api/bookkeeping/routes/bookkeeping.approvals.routes.js");

  assert.match(route, /approveBookkeepingTransactions\(\{/);
  assert.match(reclassification, /approveTransactions\(\{/);
  assert.match(reclassification, /requireNeedsReview:\s*true/);
  assert.match(approval, /import \{ learnVendorRuleFromTransaction \}/);
  assert.match(approval, /await learnVendorRuleFromTransaction\(\{/);
  assert.match(approval, /\.upsert\(payload, \{ onConflict: "business_id,transaction_id" \}\)/);
});

test("conditional merchant rules require exact identity, signed amount, and description evidence", async () => {
  const { getVendorRuleForTransaction } = await import("../src/services/bookkeeping/vendorRuleMatcher.js");
  const notes = JSON.stringify({
    source_type: "business_merchant_rule",
    authority: "user_confirmed",
    match_specificity: "exact_provider_merchant_id",
    state: "active",
  });
  const db = makeVendorRuleDb([
    {
      id: "rule-amazon-prime",
      business_id: "biz-1",
      match_type: "merchant_entity_id",
      match_value: "amazon-provider",
      counterparty_name: "Amazon",
      default_qbo_account_id: "24",
      default_qbo_account_name: "Software",
      direction_hint: "OUTFLOW",
      confidence: "high",
      source: "business_merchant_rule",
      notes,
      rule_kind: "category_default",
      match_conditions: {
        version: 1,
        amount: { exact_minor: -800, currency: "USD" },
        description: { include_any: ["amazon prime"], exclude_any: ["marketplace", "refund"] },
      },
    },
  ]);

  const base = { merchant_entity_id: "amazon-provider", merchant_name: "Amazon", direction: "OUTFLOW" };
  const match = await getVendorRuleForTransaction({
    businessId: "biz-1",
    bankTransaction: { ...base, name: "Amazon Prime", amount: -8 },
    db,
  });
  assert.equal(match.default_qbo_account_id, "24");
  assert.equal(match.match_conditions.amount.exact_minor, -800);

  for (const tx of [
    { ...base, name: "AMAZON MARKETPLACE NAMZN.COM/BILL", amount: -7.22 },
    { ...base, name: "Amazon Prime", amount: -10.51 },
    { ...base, name: "Amazon Prime refund", amount: 8, direction: "INFLOW" },
    { ...base, merchant_entity_id: "other-provider", merchant_name: "Other Merchant", name: "Amazon Prime", amount: -8 },
  ]) {
    assert.equal(await getVendorRuleForTransaction({ businessId: "biz-1", bankTransaction: tx, db }), null);
  }
});

test("malformed and unknown-version match conditions fail closed", async () => {
  const { getVendorRuleForTransaction } = await import("../src/services/bookkeeping/vendorRuleMatcher.js");
  const notes = JSON.stringify({ source_type: "business_merchant_rule", match_specificity: "exact_provider_merchant_id", state: "active" });
  for (const match_conditions of [
    { version: 2, amount: { exact_minor: -800 } },
    { version: 1, amount: { exact_minor: -8.01 } },
    { version: 1, unsupported: true },
  ]) {
    const db = makeVendorRuleDb([{
      id: "bad-rule",
      business_id: "biz-1",
      match_type: "merchant_entity_id",
      match_value: "amazon-provider",
      default_qbo_account_id: "24",
      default_qbo_account_name: "Software",
      direction_hint: "OUTFLOW",
      source: "business_merchant_rule",
      notes,
      rule_kind: "category_default",
      match_conditions,
    }]);
    const result = await getVendorRuleForTransaction({
      businessId: "biz-1",
      bankTransaction: { merchant_entity_id: "amazon-provider", merchant_name: "Amazon", name: "Amazon Prime", amount: -8, direction: "OUTFLOW" },
      db,
    });
    assert.equal(result, null);
  }
});

test("learned memo-prefix rules match future normalized merchant variants", async () => {
  const { getVendorRuleForTransaction } = await import("../src/services/bookkeeping/vendorRuleMatcher.js");
  const db = makeVendorRuleDb([
    {
      id: "rule-parkmobile",
      business_id: "biz-1",
      match_type: "memo_prefix",
      match_value: "parkmobile",
      counterparty_name: "Parkmobile",
      default_qbo_account_id: "acct-parking",
      default_qbo_account_name: "Parking",
      direction_hint: "OUTFLOW",
      confidence: "medium",
      rule_kind: "category_default",
      usage_count: 4,
    },
  ]);

  const rule = await getVendorRuleForTransaction({
    businessId: "biz-1",
    bankTransaction: {
      name: "PARK MOBILE CDOT PAY 000123 CO",
      merchant_name: null,
      counterparty_name: null,
      amount: -3.12,
      direction: "OUTFLOW",
    },
    db,
  });

  assert.equal(rule.id, "rule-parkmobile");
  assert.equal(rule.match_reason, "memo_prefix");
  assert.equal(rule.default_qbo_account_id, "acct-parking");
});

test("merchant-rule learner updates Chex-shaped rules without unordered update limits", async () => {
  const { learnVendorRuleFromTransaction } = await import("../src/services/bookkeeping/vendorRuleLearner.js");
  const rows = [{
    id: "rule-chex",
    business_id: "biz-1",
    match_type: "memo_prefix",
    match_value: "chex grill",
    rule_kind: "category_default",
    source: "business_merchant_rule",
    default_qbo_account_id: "1150040001",
    default_qbo_account_name: "Meals",
    direction_hint: "OUTFLOW",
    usage_count: 1,
    confidence: "high",
    counterparty_confidence: "medium",
    notes: JSON.stringify({ source_type: "business_merchant_rule", match_specificity: "exact_normalized_merchant", state: "active" }),
    match_conditions: null,
    updated_at: "2026-09-16T02:15:11.866Z",
  }];
  const calls = [];
  class GuardedQuery {
    constructor() {
      this.rows = [...rows];
      this.patch = null;
      this.ordered = false;
      this.limited = false;
    }
    select() { return this; }
    eq(column, value) {
      this.rows = this.rows.filter((row) => row[column] === value);
      return this;
    }
    order() {
      this.ordered = true;
      return this;
    }
    limit() {
      this.limited = true;
      return this;
    }
    update(patch) {
      this.patch = patch;
      calls.push({ op: "update", patch });
      return this;
    }
    maybeSingle() {
      if (this.limited && !this.ordered) throw new Error("A 'limit' was applied without an explicit 'order'");
      if (this.patch) Object.assign(this.rows[0], this.patch);
      return Promise.resolve({ data: this.rows[0] || null, error: null });
    }
    then(resolve) {
      if (this.limited && !this.ordered) throw new Error("A 'limit' was applied without an explicit 'order'");
      return Promise.resolve({ data: this.rows, error: null }).then(resolve);
    }
  }
  const db = { from(table) { assert.equal(table, "vendor_rules"); return new GuardedQuery(); } };

  const result = await learnVendorRuleFromTransaction({
    db,
    businessId: "biz-1",
    bankTxn: {
      id: "144742f9-77d7-4ca5-82b6-0f19930d079a",
      name: "AplPay CHEX GRILL &",
      merchant_name: "Chex Grill",
      amount: -13.65,
      direction: "OUTFLOW",
    },
    finalAccountId: "1150040001",
    finalAccountName: "Meals",
    options: { actorId: "operator-1", actorType: "user", authority: "user_confirmed", learnedFrom: "merchant_group_review" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.rule.id, "rule-chex");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].patch.usage_count, 2);
});

test("authorized exact merchant fingerprints stay tenant scoped and distinct from lookalike names", async () => {
  const { getVendorRuleForTransaction } = await import("../src/services/bookkeeping/vendorRuleMatcher.js");
  const notes = JSON.stringify({
    source_type: "business_merchant_rule",
    authority: "bookkeeper_confirmed",
    match_specificity: "exact_normalized_merchant",
    state: "active",
  });
  const db = makeVendorRuleDb([
    {
      id: "rule-greenpeace",
      business_id: "biz-1",
      match_type: "memo_prefix",
      match_value: "greenpeace",
      counterparty_name: "Greenpeace",
      default_qbo_account_id: "acct-charity",
      default_qbo_account_name: "Contributions to Charities",
      direction_hint: "OUTFLOW",
      confidence: "high",
      source: "business_merchant_rule",
      notes,
      rule_kind: "category_default",
      usage_count: 1,
    },
    {
      id: "rule-goodyear-auto",
      business_id: "biz-1",
      match_type: "memo_prefix",
      match_value: "goodyear auto service",
      counterparty_name: "Goodyear Auto Service",
      default_qbo_account_id: "acct-auto",
      default_qbo_account_name: "Auto Repairs",
      direction_hint: "OUTFLOW",
      confidence: "high",
      source: "business_merchant_rule",
      notes,
      rule_kind: "category_default",
      usage_count: 1,
    },
  ]);

  const greenpeace = await getVendorRuleForTransaction({
    businessId: "biz-1",
    bankTransaction: { name: "GREENPEACE DONATION", merchant_name: "Greenpeace", amount: -25, direction: "OUTFLOW" },
    db,
  });
  assert.equal(greenpeace.default_qbo_account_id, "acct-charity");
  assert.equal(greenpeace.source_type, "business_merchant_rule");

  const otherTenant = await getVendorRuleForTransaction({
    businessId: "biz-2",
    bankTransaction: { name: "GREENPEACE DONATION", merchant_name: "Greenpeace", amount: -25, direction: "OUTFLOW" },
    db,
  });
  assert.equal(otherTenant, null);

  const goodyearHouse = await getVendorRuleForTransaction({
    businessId: "biz-1",
    bankTransaction: { name: "THE GOODYEAR HOUSE CHARLOTTE", merchant_name: "The Goodyear House", amount: -81, direction: "OUTFLOW" },
    db,
  });
  assert.equal(goodyearHouse, null);
});

test("worker preflight releases only safe mapped handled expenses", async () => {
  const { classifyAutoPostBacklogCandidate } = await import("../src/services/bookkeeping/autoPostControl.js");
  const policy = {
    enabled: true,
    auto_post_effective_date: "2026-05-15",
    policy_columns_available: true,
    active_backlog_releases: [{ status: "active", release_start_date: "2026-05-15" }],
  };
  const safeItem = {
    status: "auto_approved",
    transaction_id: "txn-safe",
    final_qbo_account_id: "acct-fees",
    meta: { safe_to_auto_post: true },
  };
  const safeTxn = { id: "txn-safe", date: "2026-09-07", pending: false, amount: -8.4, direction: "OUTFLOW" };

  assert.equal(classifyAutoPostBacklogCandidate({ item: safeItem, bankTxn: safeTxn, policy }), "safe_new_post");
  assert.equal(
    classifyAutoPostBacklogCandidate({
      item: { ...safeItem, transaction_id: "txn-unsafe", meta: { safe_to_auto_post: false } },
      bankTxn: { ...safeTxn, id: "txn-unsafe" },
      policy,
    }),
    "unsafe_auto_post"
  );
  assert.equal(
    classifyAutoPostBacklogCandidate({
      item: { ...safeItem, transaction_id: "txn-missing", final_qbo_account_id: null },
      bankTxn: { ...safeTxn, id: "txn-missing" },
      policy,
    }),
    "missing_mapping"
  );
});

test("posting worker uses the same auto-post scope gate as backlog preview", () => {
  const worker = read("src/jobs/booksPost.cron.js");

  assert.match(worker, /classifyAutoPostOperationalScope/);
  assert.match(worker, /scope\.code === "historical_scope_review_required"/);
  assert.match(worker, /item\?\.meta\?\.safe_to_auto_post === true/);
  assert.match(worker, /cc_payment_mapping_not_safe/);
});
