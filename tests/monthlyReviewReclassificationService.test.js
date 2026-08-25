import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const {
  BookkeepingReclassificationError,
  reclassifyBookkeepingTransaction,
  updatePostedQboTransactionAccount,
} = await import("../src/services/bookkeeping/bookkeepingReclassificationService.js");

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function makeDb(initial = {}) {
  const tables = {
    business_profiles: [{ id: "biz-1", bookkeeping_start_date: "2026-01-01" }],
    bank_transactions: [],
    transaction_categorizations: [],
    clarification_requests: [],
    ...initial,
  };
  return {
    tables,
    from(table) {
      return new Query(tables, table);
    },
  };
}

class Query {
  constructor(tables, table) {
    this.tables = tables;
    this.table = table;
    this.filters = [];
    this.nullFilters = [];
    this.pendingUpdate = null;
    this.pendingSelect = false;
  }
  select() {
    this.pendingSelect = true;
    return this;
  }
  eq(column, value) {
    this.filters.push((row) => String(row[column]) === String(value));
    return this;
  }
  is(column, value) {
    this.nullFilters.push({ column, value });
    return this;
  }
  in(column, values) {
    const set = new Set((values || []).map(String));
    this.filters.push((row) => set.has(String(row[column])));
    return this;
  }
  update(payload) {
    this.pendingUpdate = payload;
    return this;
  }
  async maybeSingle() {
    const rows = this.rows();
    return { data: rows[0] || null, error: null };
  }
  async single() {
    if (this.pendingUpdate) {
      const rows = this.rows();
      const row = rows[0] || null;
      if (!row) return { data: null, error: { message: "row not found" } };
      Object.assign(row, this.pendingUpdate);
      return { data: { ...row }, error: null };
    }
    const row = this.rows()[0] || null;
    return row ? { data: { ...row }, error: null } : { data: null, error: { message: "row not found" } };
  }
  then(resolve) {
    if (this.pendingUpdate) {
      const rows = this.rows();
      rows.forEach((row) => Object.assign(row, this.pendingUpdate));
      return resolve({ data: rows.map((row) => ({ ...row })), error: null });
    }
    return resolve({ data: this.rows().map((row) => ({ ...row })), error: null });
  }
  rows() {
    return (this.tables[this.table] || []).filter((row) => {
      const filterHit = this.filters.every((fn) => fn(row));
      const nullHit = this.nullFilters.every(({ column, value }) => value === null ? row[column] == null : row[column] === value);
      return filterHit && nullHit;
    });
  }
}

const bankTxn = (overrides = {}) => ({
  id: "txn-1",
  business_id: "biz-1",
  date: "2026-08-15",
  name: "Office Depot",
  amount: -42,
  is_archived: false,
  pending: false,
  ...overrides,
});

const cat = (overrides = {}) => ({
  business_id: "biz-1",
  transaction_id: "txn-1",
  status: "needs_review",
  final_qbo_account_id: null,
  final_qbo_account_name: null,
  suggested_qbo_account_id: null,
  suggested_qbo_account_name: null,
  qbo_txn_id: null,
  qbo_txn_type: null,
  post_after: null,
  post_error: null,
  meta: {},
  ...overrides,
});

const validAccount = (overrides = {}) => async (businessId, accountId) => ({
  ok: true,
  realmId: "realm-1",
  account: {
    id: String(accountId),
    name: "Meals",
    type: "Expense",
    active: true,
    ...overrides,
  },
});

test("Monthly Review Needs Review reclassification delegates to shared approval authority", async () => {
  const db = makeDb({
    bank_transactions: [bankTxn()],
    transaction_categorizations: [cat({ status: "needs_review" })],
    clarification_requests: [{
      id: "req-1",
      business_id: "biz-1",
      transaction_id: "txn-1",
      status: "answered",
      resolved_at: null,
    }],
  });
  let approvalArgs = null;
  const result = await reclassifyBookkeepingTransaction({
    businessId: "biz-1",
    transactionId: "txn-1",
    targetQboAccountId: "acct-meals",
    actor: "admin-1",
    db,
    validateQboAccount: validAccount(),
    approveTransactions: async (args) => {
      approvalArgs = args;
      return { rows: [{ transaction_id: "txn-1", status: "approved", final_qbo_account_id: "acct-meals", post_after: null }] };
    },
  });

  assert.equal(result.mode, "needs_review_approval");
  assert.equal(approvalArgs.requireNeedsReview, true);
  assert.equal(approvalArgs.allowCcPaymentRejection, false);
  assert.equal(approvalArgs.items[0].final_qbo_account_id, "acct-meals");
  assert.equal(approvalArgs.items[0].final_qbo_account_name, "Meals");
  assert.equal(result.operator_response_resolution.resolved, 1);
  assert.equal(db.tables.clarification_requests[0].resolved_reason, "monthly_review_reclassified");
  assert.equal(db.tables.clarification_requests[0].resolved_final_qbo_account_id, "acct-meals");
});

test("Monthly Review handled unposted reclassification updates categorization without QBO create or auto-post changes", async () => {
  const db = makeDb({
    bank_transactions: [bankTxn()],
    transaction_categorizations: [cat({ status: "approved", final_qbo_account_id: "old", final_qbo_account_name: "Old", post_after: null })],
  });
  let qboRequested = false;
  const result = await reclassifyBookkeepingTransaction({
    businessId: "biz-1",
    transactionId: "txn-1",
    targetQboAccountId: "acct-meals",
    actor: "admin-1",
    db,
    validateQboAccount: validAccount(),
    approveTransactions: async () => {
      throw new Error("approval service should not be used for handled rows");
    },
    getQBOClient: async () => {
      qboRequested = true;
      throw new Error("QBO should not be called");
    },
  });

  assert.equal(result.mode, "handled_unposted_reclassification");
  assert.equal(result.categorization.final_qbo_account_id, "acct-meals");
  assert.equal(result.categorization.final_qbo_account_name, "Meals");
  assert.equal(result.categorization.qbo_txn_id, null);
  assert.equal(result.categorization.post_after, null);
  assert.equal(qboRequested, false);
});

test("Monthly Review target account validation rejects invalid cross-business inactive and spoofed account fields", async () => {
  const db = makeDb({
    bank_transactions: [bankTxn()],
    transaction_categorizations: [cat({ status: "approved" })],
  });
  await assert.rejects(
    reclassifyBookkeepingTransaction({
      businessId: "biz-1",
      transactionId: "txn-1",
      targetQboAccountId: "acct-other-realm",
      actor: "admin-1",
      db,
      validateQboAccount: async () => ({ ok: false, reason: "qbo_account_wrong_realm", realmId: "realm-2" }),
    }),
    (err) => err instanceof BookkeepingReclassificationError && err.error === "qbo_account_wrong_realm"
  );

  await assert.rejects(
    reclassifyBookkeepingTransaction({
      businessId: "biz-1",
      transactionId: "txn-1",
      targetQboAccountId: "inactive",
      actor: "admin-1",
      db,
      validateQboAccount: validAccount({ active: false, name: "Client Spoof Name" }),
    }),
    (err) => err.error === "inactive_qbo_account"
  );
});

test("Monthly Review posted Purchase Deposit and CreditCardCharge update existing QBO entity in place", async () => {
  for (const [qboTxnType, entity] of [
    ["Purchase", { Id: "qbo-1", SyncToken: "2", Line: [{ AccountBasedExpenseLineDetail: { AccountRef: { value: "old" } } }] }],
    ["Deposit", { Id: "qbo-1", SyncToken: "2", Line: [{ DepositLineDetail: { AccountRef: { value: "old" } } }] }],
    ["CreditCardCharge", { Id: "qbo-1", SyncToken: "2", Line: [{ AccountBasedExpenseLineDetail: { AccountRef: { value: "old" } } }] }],
  ]) {
    const updates = [];
    const qbo = qboTxnType === "CreditCardCharge"
      ? {
          creditCardCharge: {
            get: (id, cb) => cb(null, { CreditCardCharge: { ...entity } }),
            update: (payload, cb) => {
              updates.push(payload);
              cb(null, { SyncToken: "3" });
            },
          },
        }
      : {
          [`get${qboTxnType}`]: (id, cb) => cb(null, { [qboTxnType]: { ...entity } }),
          [`update${qboTxnType}`]: (payload, cb) => {
            updates.push(payload);
            cb(null, { SyncToken: "3" });
          },
        };
    const result = await updatePostedQboTransactionAccount({
      businessId: "biz-1",
      qboTxnId: "qbo-1",
      qboTxnType,
      accountId: "acct-new",
      accountName: "Meals",
      getQBOClient: async () => qbo,
    });
    assert.equal(result.qbo_txn_id, "qbo-1");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].Id, "qbo-1");
    assert.equal(updates[0].SyncToken, "2");
    const line = updates[0].Line[0];
    const ref = line.DepositLineDetail?.AccountRef || line.AccountBasedExpenseLineDetail?.AccountRef;
    assert.equal(ref.value, "acct-new");
  }
});

test("Monthly Review posted provider failure fails closed before Bizzi GL persistence", async () => {
  const db = makeDb({
    bank_transactions: [bankTxn()],
    transaction_categorizations: [cat({ status: "posted", qbo_txn_id: "qbo-1", qbo_txn_type: "Purchase", final_qbo_account_id: "old" })],
  });
  await assert.rejects(
    reclassifyBookkeepingTransaction({
      businessId: "biz-1",
      transactionId: "txn-1",
      targetQboAccountId: "acct-new",
      actor: "admin-1",
      db,
      validateQboAccount: validAccount(),
      getQBOClient: async () => ({
        getPurchase: (id, cb) => cb(null, { Purchase: { Id: "qbo-1", SyncToken: "2", Line: [{ AccountBasedExpenseLineDetail: { AccountRef: { value: "old" } } }] } }),
        updatePurchase: (payload, cb) => cb(new Error("stale SyncToken")),
      }),
    }),
    (err) => err instanceof BookkeepingReclassificationError && err.error === "qbo_update_failed_Purchase"
  );
  assert.equal(db.tables.transaction_categorizations[0].final_qbo_account_id, "old");
  assert.equal(db.tables.transaction_categorizations[0].qbo_txn_id, "qbo-1");
});

test("Monthly Review generic reclassification rejects protected special workflows", async () => {
  for (const [taxonomy, expected] of [
    ["cc_payment", "cc_payment_generic_reclassification_not_supported"],
    ["transfer_internal", "special_workflow_reclassification_not_supported"],
    ["owner_draw", "special_workflow_reclassification_not_supported"],
    ["refund", "special_workflow_reclassification_not_supported"],
  ]) {
    const db = makeDb({
      bank_transactions: [bankTxn()],
      transaction_categorizations: [cat({ status: "approved", meta: {
        taxonomy_type: taxonomy,
        cc_payment_pair_id: taxonomy === "cc_payment" ? "pair-1" : undefined,
        cc_payment_pair_status: taxonomy === "cc_payment" ? "confirmed" : undefined,
        cc_payment_pair_confidence: taxonomy === "cc_payment" ? "high" : undefined,
        cc_payment_bank_qbo_account_id: taxonomy === "cc_payment" ? "bank-qbo" : undefined,
        cc_payment_cc_qbo_account_id: taxonomy === "cc_payment" ? "cc-qbo" : undefined,
      } })],
    });
    await assert.rejects(
      reclassifyBookkeepingTransaction({
        businessId: "biz-1",
        transactionId: "txn-1",
        targetQboAccountId: "acct-new",
        actor: "admin-1",
        db,
        validateQboAccount: validAccount(),
      }),
      (err) => err.error === expected
    );
  }
}
);

test("Monthly Review generic reclassification allows stale cc_payment taxonomy without durable pair evidence", async () => {
  const db = makeDb({
    bank_transactions: [bankTxn({ name: "APPLE.COM/BILL", amount: -21.62 })],
    transaction_categorizations: [cat({
      status: "approved",
      final_qbo_account_id: "old",
      final_qbo_account_name: "Old",
      meta: { taxonomy_type: "cc_payment", cc_payment_rejected: false },
    })],
  });

  const result = await reclassifyBookkeepingTransaction({
    businessId: "biz-1",
    transactionId: "txn-1",
    targetQboAccountId: "acct-meals",
    actor: "admin-1",
    db,
    validateQboAccount: validAccount(),
  });

  assert.equal(result.mode, "handled_unposted_reclassification");
  assert.equal(result.categorization.final_qbo_account_id, "acct-meals");
  assert.equal(result.categorization.qbo_txn_id, null);
});

test("Monthly Review route is thin and no longer owns provider update or forced unposted posting", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const bodyStart = route.indexOf('router.patch("/runs/:runId/transactions/:transactionId/account"');
  const bodyEnd = route.indexOf('\nrouter.post("/runs/:runId/transactions/:transactionId/retry-qbo-sync"', bodyStart);
  const body = route.slice(bodyStart, bodyEnd);

  assert.match(body, /reclassifyBookkeepingTransaction/);
  assert.doesNotMatch(body, /final_qbo_account_name \|\| req\.body\?\.account_name/);
  assert.doesNotMatch(body, /runBooksPostOnce/);
  assert.doesNotMatch(body, /updatePostedQboTransactionAccount\(/);
  assert.doesNotMatch(route, /function updatePostedQboTransactionAccount/);
  assert.match(route, /BookkeepingReclassificationError/);
});

test("Monthly Review reclassification preserves auto-post and canonical COA authority boundaries", () => {
  const service = read("src/services/bookkeeping/bookkeepingReclassificationService.js");
  const approval = read("src/services/bookkeeping/bookkeepingApprovalService.js");

  assert.match(service, /approveTransactions\(\{/);
  assert.match(service, /requireNeedsReview: true/);
  assert.doesNotMatch(service, /computePostAfterForAutoPost/);
  assert.match(approval, /computePostAfterForAutoPost\(autoPostEnabled, 24\)/);
  assert.doesNotMatch(service, /auto_post_to_quickbooks/);
  assert.doesNotMatch(service, /createPreferredQboAccountForCanonical|createQboAccountFromCanonical|createAccount/);
});

test("Monthly Review posted reclassification cannot create duplicate QBO transactions", () => {
  const service = read("src/services/bookkeeping/bookkeepingReclassificationService.js");

  assert.match(service, /updatePostedQboTransactionAccount/);
  assert.match(service, /fetchQboTransaction/);
  assert.match(service, /updateQboTransaction/);
  assert.match(service, /\.eq\("qbo_txn_id", previous\.qbo_txn_id\)/);
  assert.doesNotMatch(service, /createQboPurchase|createQboDeposit|createCreditCardCharge|createPurchase|createDeposit/);
  assert.doesNotMatch(service, /qbo_txn_id:\s*null/);
});

test("Monthly Review Phase 2A collapsed P&L behavior remains wired after reclassification refactor", () => {
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");

  assert.match(ui, /useState\(\(\) => new Set\(\)\)/);
  assert.match(ui, /setExpandedAccountKeys\(\(current\) => \{/);
  assert.match(ui, /aria-expanded=\{expanded\}/);
  assert.match(ui, /\{expanded \? \(/);
  assert.match(ui, /onChange=\{\(accountId\) => onAccountChange\(txn, accountId\)\}/);
});
