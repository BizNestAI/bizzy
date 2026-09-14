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
