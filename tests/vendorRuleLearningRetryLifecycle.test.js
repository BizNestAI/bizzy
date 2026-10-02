import test from "node:test";
import assert from "node:assert/strict";

import {
  processVendorRuleLearningRetryJobs,
  VENDOR_RULE_LEARNING_MAX_ATTEMPTS,
} from "../src/services/bookkeeping/vendorRuleLearningRetryService.js";

function retryDb(seed = {}) {
  const store = Object.fromEntries(Object.entries(seed).map(([key, rows]) => [key, rows.map((row) => ({ ...row }))]));
  class Query {
    constructor(table) { this.table = table; this.rows = [...(store[table] || [])]; this.patch = null; }
    select() { return this; }
    eq(field, value) { this.rows = this.rows.filter((row) => row[field] === value); return this; }
    not(field, op, value) { if (op === "is" && value === null) this.rows = this.rows.filter((row) => row[field] != null); return this; }
    order() { return this; }
    limit() { return this; }
    update(patch) { this.patch = patch; return this; }
    upsert(payload) {
      const existing = (store[this.table] ||= []).find((row) =>
        row.business_id === payload.business_id && row.match_type === payload.match_type && row.match_value === payload.match_value
      );
      if (existing) Object.assign(existing, payload);
      else store[this.table].push({ id: `rule-${store[this.table].length + 1}`, ...payload });
      this.rows = [existing || store[this.table].at(-1)];
      return this;
    }
    maybeSingle() {
      if (this.patch) this.rows.forEach((row) => Object.assign(row, this.patch));
      return Promise.resolve({ data: this.rows[0] || null, error: null });
    }
    then(resolve) { return Promise.resolve({ data: this.rows, error: null }).then(resolve); }
  }
  return { store, from: (table) => new Query(table) };
}

test("learned-rule retry completes idempotently and remains tenant isolated", async () => {
  const now = new Date("2026-10-02T12:00:00.000Z");
  const db = retryDb({
    vendor_rule_learning_jobs: [
      { id: "job-a", business_id: "biz-a", transaction_id: "txn-a", actor_id: "user-a", actor_type: "user", status: "pending", attempt_count: 0, process_after: now.toISOString() },
      { id: "job-b", business_id: "biz-b", transaction_id: "txn-b", actor_id: "user-b", actor_type: "user", status: "pending", attempt_count: 0, process_after: now.toISOString() },
    ],
    bank_transactions: [
      { id: "txn-a", business_id: "biz-a", name: "AplPay ROLLIN OUT LLC", merchant_name: "Rollin Out LLC", amount: -20, direction: "OUTFLOW" },
      { id: "txn-b", business_id: "biz-b", name: "AplPay SHAHIN INC", merchant_name: "Shahin Inc", amount: -18, direction: "OUTFLOW" },
    ],
    transaction_categorizations: [
      { transaction_id: "txn-a", business_id: "biz-a", final_qbo_account_id: "qbo-meals-a", final_qbo_account_name: "Meals", meta: {} },
      { transaction_id: "txn-b", business_id: "biz-b", final_qbo_account_id: "qbo-meals-b", final_qbo_account_name: "Meals", meta: {} },
    ],
    vendor_rules: [],
  });

  const first = await processVendorRuleLearningRetryJobs({ db, businessId: "biz-a", workerId: "worker-a", now });
  assert.equal(first.claimed, 1);
  assert.equal(first.completed, 1);
  assert.equal(db.store.vendor_rule_learning_jobs[0].status, "completed");
  assert.equal(db.store.vendor_rule_learning_jobs[1].status, "pending");
  assert.equal(db.store.vendor_rules.length, 1);
  assert.equal(db.store.vendor_rules[0].business_id, "biz-a");
  assert.equal(db.store.vendor_rules[0].default_qbo_account_id, "qbo-meals-a");

  const repeated = await processVendorRuleLearningRetryJobs({ db, businessId: "biz-a", workerId: "worker-a-2", now });
  assert.equal(repeated.claimed, 0);
  assert.equal(db.store.vendor_rules.length, 1);
});

test("learned-rule retry is bounded and ends visibly in dead letter", async () => {
  const now = new Date("2026-10-02T12:00:00.000Z");
  const db = retryDb({
    vendor_rule_learning_jobs: [
      { id: "job-missing", business_id: "biz-a", transaction_id: "missing", status: "pending", attempt_count: VENDOR_RULE_LEARNING_MAX_ATTEMPTS - 1, process_after: now.toISOString() },
    ],
    bank_transactions: [],
    transaction_categorizations: [],
    vendor_rules: [],
  });
  const result = await processVendorRuleLearningRetryJobs({ db, businessId: "biz-a", workerId: "worker-a", now });
  assert.equal(result.claimed, 1);
  assert.equal(result.dead_letter, 1);
  assert.equal(db.store.vendor_rule_learning_jobs[0].status, "dead_letter");
  assert.match(db.store.vendor_rule_learning_jobs[0].last_error, /learning_inputs_unavailable/);
  const repeated = await processVendorRuleLearningRetryJobs({ db, businessId: "biz-a", workerId: "worker-b", now });
  assert.equal(repeated.claimed, 0);
});

