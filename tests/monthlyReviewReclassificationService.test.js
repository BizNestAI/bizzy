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

test("Monthly Review posted Purchase builds allowlisted update payload from fetched QBO response", async () => {
  const db = makeDb({
    bank_transactions: [bankTxn()],
    transaction_categorizations: [cat({
      status: "posted",
      qbo_txn_id: "1294",
      qbo_txn_type: "Purchase",
      final_qbo_account_id: "24",
      final_qbo_account_name: "Software",
    })],
  });
  const fetchedPurchase = {
    Id: "1294",
    SyncToken: "7",
    domain: "QBO",
    sparse: false,
    MetaData: { CreateTime: "2026-08-15T00:00:00Z", LastUpdatedTime: "2026-08-25T00:00:00Z" },
    CustomField: [{ DefinitionId: "1", StringValue: "response-only" }],
    LinkedTxn: [{ TxnId: "linked-1" }],
    TotalAmt: 160,
    PrintStatus: "NeedToPrint",
    PaymentType: "CreditCard",
    AccountRef: { value: "19", name: "Credit Card" },
    EntityRef: { value: "vendor-1", name: "Instantly" },
    TxnDate: "2026-08-15",
    DocNumber: "1294",
    Line: [{
      Id: "1",
      LineNum: 1,
      Description: "INSTANTLY",
      Amount: 160,
      DetailType: "AccountBasedExpenseLineDetail",
      LinkedTxn: [{ TxnId: "line-linked" }],
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: "24", name: "Software" },
        CustomerRef: { value: "cust-1", name: "Client" },
        ClassRef: { value: "class-1", name: "Ops" },
        BillableStatus: "NotBillable",
        TaxCodeRef: { value: "NON" },
        UnsupportedReportField: "drop-me",
      },
    }],
  };
  const updates = [];
  const originalConsoleInfo = console.info;
  const payloadShapeLogs = [];
  console.info = (...args) => payloadShapeLogs.push(args);
  try {
    const result = await reclassifyBookkeepingTransaction({
      businessId: "biz-1",
      transactionId: "txn-1",
      targetQboAccountId: "1150040040",
      actor: "admin-1",
      db,
      validateQboAccount: validAccount({
        id: "1150040040",
        name: "Apartment",
        type: "Expense",
        subType: "OtherMiscellaneousServiceCost",
      }),
      getQBOClient: async () => ({
        getPurchase: (id, cb) => cb(null, { Purchase: fetchedPurchase }),
        updatePurchase: (payload, cb) => {
          updates.push(payload);
          cb(null, { Purchase: { Id: "1294", SyncToken: "8" } });
        },
        createPurchase: () => {
          throw new Error("createPurchase must not be called");
        },
      }),
    });

    assert.equal(result.qbo_update.qbo_txn_id, "1294");
    assert.equal(result.qbo_update.sync_token_before, "7");
    assert.equal(result.qbo_update.sync_token_after, "8");
  } finally {
    console.info = originalConsoleInfo;
  }

  assert.equal(updates.length, 1);
  const payload = updates[0];
  assert.equal(payload.Id, "1294");
  assert.equal(payload.SyncToken, "7");
  assert.equal(payload.sparse, true);
  assert.equal(payload.PaymentType, "CreditCard");
  assert.deepEqual(payload.AccountRef, { value: "19", name: "Credit Card" });
  assert.deepEqual(payload.EntityRef, { value: "vendor-1", name: "Instantly" });
  assert.equal(payload.TxnDate, "2026-08-15");
  assert.equal(payload.DocNumber, "1294");
  assert.equal(payload.Line.length, 1);
  assert.equal(payload.Line[0].Id, "1");
  assert.equal(payload.Line[0].Amount, 160);
  assert.equal(payload.Line[0].DetailType, "AccountBasedExpenseLineDetail");
  assert.equal(payload.Line[0].AccountBasedExpenseLineDetail.AccountRef.value, "1150040040");
  assert.equal(payload.Line[0].AccountBasedExpenseLineDetail.AccountRef.name, "Apartment");
  assert.equal(payload.Line[0].AccountBasedExpenseLineDetail.CustomerRef.value, "cust-1");
  assert.equal(payload.Line[0].AccountBasedExpenseLineDetail.ClassRef.value, "class-1");
  assert.equal(payload.Line[0].AccountBasedExpenseLineDetail.BillableStatus, "NotBillable");
  assert.equal(payload.Line[0].AccountBasedExpenseLineDetail.TaxCodeRef.value, "NON");
  assert.equal(payload.Line[0].LinkedTxn, undefined);
  assert.equal(payload.Line[0].AccountBasedExpenseLineDetail.UnsupportedReportField, undefined);
  assert.equal(payload.domain, undefined);
  assert.equal(payload.Sparse, undefined);
  assert.equal(payload.MetaData, undefined);
  assert.equal(payload.CustomField, undefined);
  assert.equal(payload.LinkedTxn, undefined);
  assert.equal(payload.TotalAmt, undefined);
  assert.equal(payload.PrintStatus, undefined);
  assert.equal(db.tables.transaction_categorizations[0].final_qbo_account_id, "1150040040");
  assert.equal(db.tables.transaction_categorizations[0].qbo_txn_id, "1294");
  assert.equal(payloadShapeLogs.length, 1);
  assert.equal(payloadShapeLogs[0][0], "[bookkeeping-reclassification] qbo transaction update payload shape");
  assert.deepEqual(payloadShapeLogs[0][1].top_level_keys, ["AccountRef", "DocNumber", "EntityRef", "Id", "Line", "PaymentType", "SyncToken", "TxnDate", "sparse"]);
  assert.deepEqual(payloadShapeLogs[0][1].line_shapes[0].keys, ["AccountBasedExpenseLineDetail", "Amount", "Description", "DetailType", "Id", "LineNum"]);
});

test("Monthly Review posted Purchase reclassification allows Expense and COGS targets", async () => {
  for (const target of [
    { id: "acct-expense", name: "Advertising", type: "Expense" },
    { id: "acct-cogs", name: "Materials", type: "Cost of Goods Sold" },
    { id: "acct-other-expense", name: "Other Expense", type: "Other Expense" },
  ]) {
    const db = makeDb({
      bank_transactions: [bankTxn()],
      transaction_categorizations: [cat({
        status: "posted",
        qbo_txn_id: "qbo-1",
        qbo_txn_type: "Purchase",
        final_qbo_account_id: "old",
        final_qbo_account_name: "Software",
      })],
    });
    const updates = [];
    const result = await reclassifyBookkeepingTransaction({
      businessId: "biz-1",
      transactionId: "txn-1",
      targetQboAccountId: target.id,
      actor: "admin-1",
      db,
      validateQboAccount: validAccount(target),
      getQBOClient: async () => ({
        getPurchase: (id, cb) => cb(null, { Purchase: { Id: "qbo-1", SyncToken: "2", Line: [{ AccountBasedExpenseLineDetail: { AccountRef: { value: "old" } } }] } }),
        updatePurchase: (payload, cb) => {
          updates.push(payload);
          cb(null, { Purchase: { Id: "qbo-1", SyncToken: "3" } });
        },
      }),
    });

    assert.equal(result.qbo_update.qbo_txn_id, "qbo-1");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].Line[0].AccountBasedExpenseLineDetail.AccountRef.value, target.id);
  }
});

test("Monthly Review posted Purchase rejects incompatible target accounts before QBO update", async () => {
  for (const target of [
    { id: "acct-income", name: "Fantasy", type: "Income", expected: "target_account_not_valid_for_purchase_reclassification" },
    { id: "acct-other-income", name: "Other Income", type: "Other Income", expected: "target_account_not_valid_for_purchase_reclassification" },
    { id: "acct-bank", name: "Checking", type: "Bank", expected: "target_account_not_valid_for_generic_gl_reclassification" },
    { id: "acct-card", name: "Credit Card", type: "Credit Card", expected: "target_account_not_valid_for_generic_gl_reclassification" },
    { id: "acct-ar", name: "A/R", type: "Accounts Receivable", expected: "target_account_not_valid_for_generic_gl_reclassification" },
    { id: "acct-ap", name: "A/P", type: "Accounts Payable", expected: "target_account_not_valid_for_generic_gl_reclassification" },
    { id: "acct-asset", name: "Asset", type: "Other Current Asset", expected: "target_account_not_valid_for_purchase_reclassification" },
    { id: "acct-liability", name: "Liability", type: "Other Current Liability", expected: "target_account_not_valid_for_purchase_reclassification" },
    { id: "acct-equity", name: "Equity", type: "Equity", expected: "target_account_not_valid_for_purchase_reclassification" },
  ]) {
    const db = makeDb({
      bank_transactions: [bankTxn()],
      transaction_categorizations: [cat({ status: "posted", qbo_txn_id: "qbo-1", qbo_txn_type: "Purchase", final_qbo_account_id: "old" })],
    });
    let qboRequested = false;
    await assert.rejects(
      reclassifyBookkeepingTransaction({
        businessId: "biz-1",
        transactionId: "txn-1",
        targetQboAccountId: target.id,
        actor: "admin-1",
        db,
        validateQboAccount: validAccount(target),
        getQBOClient: async () => {
          qboRequested = true;
          return {
            getPurchase: (id, cb) => cb(null, { Purchase: { Id: "qbo-1", SyncToken: "2", Line: [{ AccountBasedExpenseLineDetail: { AccountRef: { value: "old" } } }] } }),
            updatePurchase: (payload, cb) => cb(null, { SyncToken: "3" }),
          };
        },
      }),
      (err) => err instanceof BookkeepingReclassificationError && err.error === target.expected
    );
    assert.equal(qboRequested, false);
    assert.equal(db.tables.transaction_categorizations[0].final_qbo_account_id, "old");
  }
});

test("Monthly Review posted CreditCardCharge rejects Income target before provider update", async () => {
  const db = makeDb({
    bank_transactions: [bankTxn()],
    transaction_categorizations: [cat({ status: "posted", qbo_txn_id: "qbo-1", qbo_txn_type: "CreditCardCharge", final_qbo_account_id: "old" })],
  });
  let qboRequested = false;
  await assert.rejects(
    reclassifyBookkeepingTransaction({
      businessId: "biz-1",
      transactionId: "txn-1",
      targetQboAccountId: "acct-income",
      actor: "admin-1",
      db,
      validateQboAccount: validAccount({ id: "acct-income", name: "Fantasy", type: "Income" }),
      getQBOClient: async () => {
        qboRequested = true;
      },
    }),
    (err) => err.error === "target_account_not_valid_for_credit_card_charge_reclassification"
  );
  assert.equal(qboRequested, false);
});

test("Monthly Review posted Deposit uses independent income-side target validation", async () => {
  const incomeDb = makeDb({
    bank_transactions: [bankTxn({ amount: 100, signed_amount: 100, direction: "INFLOW" })],
    transaction_categorizations: [cat({ status: "posted", qbo_txn_id: "dep-1", qbo_txn_type: "Deposit", final_qbo_account_id: "old" })],
  });
  const updates = [];
  const result = await reclassifyBookkeepingTransaction({
    businessId: "biz-1",
    transactionId: "txn-1",
    targetQboAccountId: "acct-income",
    actor: "admin-1",
    db: incomeDb,
    validateQboAccount: validAccount({ id: "acct-income", name: "Services", type: "Income" }),
    getQBOClient: async () => ({
      getDeposit: (id, cb) => cb(null, { Deposit: { Id: "dep-1", SyncToken: "2", Line: [{ DepositLineDetail: { AccountRef: { value: "old" } } }] } }),
      updateDeposit: (payload, cb) => {
        updates.push(payload);
        cb(null, { Deposit: { Id: "dep-1", SyncToken: "3" } });
      },
    }),
  });
  assert.equal(result.qbo_update.qbo_txn_id, "dep-1");
  assert.equal(updates.length, 1);

  const expenseDb = makeDb({
    bank_transactions: [bankTxn({ amount: 100, signed_amount: 100, direction: "INFLOW" })],
    transaction_categorizations: [cat({ status: "posted", qbo_txn_id: "dep-1", qbo_txn_type: "Deposit", final_qbo_account_id: "old" })],
  });
  let qboRequested = false;
  await assert.rejects(
    reclassifyBookkeepingTransaction({
      businessId: "biz-1",
      transactionId: "txn-1",
      targetQboAccountId: "acct-expense",
      actor: "admin-1",
      db: expenseDb,
      validateQboAccount: validAccount({ id: "acct-expense", name: "Meals", type: "Expense" }),
      getQBOClient: async () => {
        qboRequested = true;
      },
    }),
    (err) => err.error === "target_account_not_valid_for_deposit_reclassification"
  );
  assert.equal(qboRequested, false);
});

test("Monthly Review posted provider failure fails closed before Bizzi GL persistence", async () => {
  const db = makeDb({
    bank_transactions: [bankTxn()],
    transaction_categorizations: [cat({ status: "posted", qbo_txn_id: "qbo-1", qbo_txn_type: "Purchase", final_qbo_account_id: "old" })],
  });
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    await assert.rejects(
      reclassifyBookkeepingTransaction({
        businessId: "biz-1",
        transactionId: "txn-1",
        targetQboAccountId: "acct-new",
        actor: "admin-1",
        db,
        validateQboAccount: validAccount(),
        getQBOClient: async () => ({
          getPurchase: (id, cb) => cb(null, {
            Purchase: {
              Id: "qbo-1",
              SyncToken: "2",
              PaymentType: "CreditCard",
              AccountRef: { value: "card-1" },
              Line: [{ AccountBasedExpenseLineDetail: { AccountRef: { value: "old" } } }],
            },
          }),
          updatePurchase: (payload, cb) => {
            const err = new Error("Business Validation Error token access_token=secret");
            err.statusCode = 400;
            err.Fault = {
              type: "ValidationFault",
              Error: [{
                code: "6000",
                Message: "Business Validation Error",
                Detail: "Stale SyncToken on AccountRef",
                element: "Line.AccountBasedExpenseLineDetail.AccountRef",
              }],
            };
            cb(err);
          },
        }),
      }),
      (err) => {
        assert.ok(err instanceof BookkeepingReclassificationError);
        assert.equal(err.error, "qbo_update_failed_Purchase");
        assert.equal(err.details.diagnostic_code, "qbo_stale_object");
        assert.equal(err.details.qbo_provider_error.operation, "updatePurchase");
        assert.equal(err.details.qbo_provider_error.http_status, 400);
        assert.equal(err.details.qbo_provider_error.intuit_fault_type, "ValidationFault");
        assert.equal(err.details.qbo_provider_error.intuit_error_code, "6000");
        assert.equal(err.details.qbo_provider_error.message, "Business Validation Error");
        assert.equal(err.details.qbo_provider_error.detail, "Stale SyncToken on AccountRef");
        assert.equal(err.details.qbo_provider_error.field_path, "Line.AccountBasedExpenseLineDetail.AccountRef");
        assert.equal(err.details.qbo_update_diagnostic.operation, "updatePurchase");
        assert.equal(err.details.qbo_update_diagnostic.qbo_txn_type, "Purchase");
        assert.equal(err.details.qbo_update_diagnostic.qbo_txn_id, "qbo-1");
        assert.equal(err.details.qbo_update_diagnostic.sync_token_present, true);
        assert.equal(err.details.qbo_update_diagnostic.fetched_payment_type, "CreditCard");
        assert.equal(err.details.qbo_update_diagnostic.fetched_payment_account_ref_present, true);
        assert.equal(err.details.qbo_update_diagnostic.line_count, 1);
        assert.deepEqual(err.details.qbo_update_diagnostic.line_detail_types, ["AccountBasedExpenseLineDetail"]);
        assert.equal(err.details.qbo_update_diagnostic.target_qbo_account_id, "acct-new");
        assert.equal(err.details.qbo_update_diagnostic.target_qbo_account_type, "Expense");
        assert.equal(JSON.stringify(err.details).includes("access_token=secret"), false);
        return true;
      }
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "[bookkeeping-reclassification] qbo transaction update failed");
  assert.equal(logs[0][1].operation, "updatePurchase");
  assert.equal(logs[0][1].provider_error.intuit_error_code, "6000");
  assert.equal(db.tables.transaction_categorizations[0].final_qbo_account_id, "old");
  assert.equal(db.tables.transaction_categorizations[0].qbo_txn_id, "qbo-1");
});

test("Monthly Review QBO provider diagnostics do not include raw update payloads or tokens", () => {
  const service = read("src/services/bookkeeping/bookkeepingReclassificationService.js");
  const route = read("src/api/admin/monthlyReview.routes.js");

  assert.match(service, /sanitizeQboProviderError/);
  assert.match(service, /buildQboUpdateDiagnostic/);
  assert.match(service, /qbo_provider_error/);
  assert.match(service, /qbo_update_diagnostic/);
  assert.match(service, /line_detail_types/);
  assert.match(service, /target_qbo_account_type/);
  assert.match(service, /classifyQboProviderError/);
  assert.match(route, /qbo_provider_error: e\?\.details\?\.qbo_provider_error/);
  assert.match(route, /qbo_update_diagnostic: e\?\.details\?\.qbo_update_diagnostic/);
  assert.doesNotMatch(service, /payload:\s*payload|raw_payload|Authorization|refresh_token:/);
  assert.doesNotMatch(route, /req\.headers\.authorization|access_token|refresh_token/);
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
  assert.match(ui, /onChange=\{\(accountId\) => handlePnlAccountDraftChange\(txn, accountId\)\}/);
  assert.match(ui, /Confirm Reclass/);
  assert.match(ui, /transactionId: txn\.bizzi_transaction_id/);
});
