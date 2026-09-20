import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

let servicePromise = null;
async function confirmCreditCardPaymentMatchForTransaction(args) {
  servicePromise ||= import("../src/services/bookkeeping/creditCardPaymentPairService.js");
  const service = await servicePromise;
  return service.confirmCreditCardPaymentMatchForTransaction(args);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.action = "select";
    this.filters = [];
    this.orFilter = null;
    this.payload = null;
    this.single = false;
    this.max = null;
  }

  select() { return this; }
  eq(field, value) { this.filters.push((row) => String(row[field]) === String(value)); return this; }
  neq(field, value) { this.filters.push((row) => String(row[field]) !== String(value)); return this; }
  gte(field, value) { this.filters.push((row) => String(row[field]) >= String(value)); return this; }
  lte(field, value) { this.filters.push((row) => String(row[field]) <= String(value)); return this; }
  in(field, values) {
    const set = new Set((values || []).map(String));
    this.filters.push((row) => set.has(String(row[field])));
    return this;
  }
  is(field, value) { this.filters.push((row) => row[field] === value); return this; }
  or(expr) { this.orFilter = expr; return this; }
  limit(value) { this.max = Number(value); return this; }
  maybeSingle() { this.single = true; return this; }
  insert(payload) { this.action = "insert"; this.payload = payload; return this; }
  update(payload) { this.action = "update"; this.payload = payload; return this; }
  upsert(payload) { this.action = "upsert"; this.payload = payload; return this; }

  then(resolve, reject) {
    try {
      return Promise.resolve(this.execute()).then(resolve, reject);
    } catch (err) {
      return Promise.reject(err).then(resolve, reject);
    }
  }

  rows() {
    let rows = this.db[this.table] || [];
    for (const filter of this.filters) rows = rows.filter(filter);
    if (this.orFilter) {
      const checks = this.orFilter.split(",").map((part) => {
        const [field, op, value] = part.split(".");
        return (row) => op === "eq" && String(row[field]) === String(value);
      });
      rows = rows.filter((row) => checks.some((check) => check(row)));
    }
    if (this.max != null) rows = rows.slice(0, this.max);
    return rows;
  }

  execute() {
    if (this.action === "insert") {
      const row = { id: `pair-${this.db.credit_card_payment_pairs.length + 1}`, ...clone(this.payload) };
      this.db[this.table].push(row);
      return { data: this.single ? clone(row) : [clone(row)], error: null };
    }
    if (this.action === "update") {
      const rows = this.rows();
      rows.forEach((row) => Object.assign(row, clone(this.payload)));
      return { data: this.single ? clone(rows[0] || null) : clone(rows), error: null };
    }
    if (this.action === "upsert") {
      const payload = clone(this.payload);
      const rows = this.db[this.table];
      const idx = rows.findIndex((row) =>
        String(row.business_id) === String(payload.business_id) &&
        String(row.transaction_id) === String(payload.transaction_id)
      );
      if (idx >= 0) rows[idx] = { ...rows[idx], ...payload };
      else rows.push(payload);
      const row = idx >= 0 ? rows[idx] : payload;
      return { data: this.single ? clone(row) : [clone(row)], error: null };
    }
    const rows = this.rows();
    return { data: this.single ? clone(rows[0] || null) : clone(rows), error: null };
  }
}

function makeDb(overrides = {}) {
  const businessId = "biz-1";
  const rows = {
    bank_transactions: [
      {
        id: "checking-aug5",
        business_id: businessId,
        plaid_account_id: "plaid-checking",
        amount: 322.57,
        signed_amount: -322.57,
        direction: "OUTFLOW",
        date: "2026-08-05",
        name: "ACH PMT AMEX EPAYMENT M335",
        is_archived: false,
        pending: false,
        accounting_review_required: true,
      },
      {
        id: "card-aug4",
        business_id: businessId,
        plaid_account_id: "plaid-amex",
        amount: 322.5700000001,
        signed_amount: 322.5700000001,
        direction: "INFLOW",
        date: "2026-08-04",
        name: "MOBILE PAYMENT - THANK YOU",
        is_archived: false,
        pending: false,
        accounting_review_required: true,
      },
    ],
    plaid_accounts: [
      { business_id: businessId, plaid_account_id: "plaid-checking", name: "Checking 8626", type: "depository", subtype: "checking" },
      { business_id: businessId, plaid_account_id: "plaid-amex", name: "Blue Cash Everyday", type: "credit", subtype: "credit card" },
    ],
    plaid_qbo_account_mappings: [
      { business_id: businessId, plaid_account_id: "plaid-checking", qbo_account_id: "qbo-bank", qbo_account_name: "Checking", qbo_account_type: "Bank" },
      { business_id: businessId, plaid_account_id: "plaid-amex", qbo_account_id: "qbo-blue", qbo_account_name: "Blue Cash Everyday", qbo_account_type: "CreditCard" },
    ],
    transaction_categorizations: [
      { business_id: businessId, transaction_id: "checking-aug5", status: "needs_review", meta: {} },
      { business_id: businessId, transaction_id: "card-aug4", status: "needs_review", meta: {} },
    ],
    credit_card_payment_pairs: [],
  };
  Object.assign(rows, overrides);
  return {
    businessId,
    data: rows,
    db: {
      from(table) {
        if (!rows[table]) rows[table] = [];
        return new Query(rows, table);
      },
    },
  };
}

function validator(_businessId, qboAccountId, expectedType) {
  const types = { "qbo-bank": "Bank", "qbo-blue": "CreditCard", "qbo-other-card": "CreditCard" };
  const type = types[qboAccountId] || null;
  if (!type) return { ok: false, reason: "cc_payment_target_account_not_found" };
  if (type !== expectedType) {
    return { ok: false, reason: expectedType === "Bank" ? "cc_payment_target_not_bank" : "cc_payment_target_not_credit_card" };
  }
  return { ok: true, account: { id: qboAccountId, name: qboAccountId, type } };
}

test("confirms an Aug 5 checking payment to an Aug 4 credit-card payment", async () => {
  const { db, data, businessId } = makeDb();
  const result = await confirmCreditCardPaymentMatchForTransaction({
    db,
    businessId,
    transactionId: "checking-aug5",
    targetQboAccountId: "qbo-blue",
    validateQboAccountType: validator,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.matched, true, JSON.stringify(result));
  assert.equal(result.pair.checking_transaction_id, "checking-aug5");
  assert.equal(result.pair.credit_card_transaction_id, "card-aug4");
  assert.equal(result.pair.amount, 322.57);
  assert.equal(data.transaction_categorizations.find((row) => row.transaction_id === "checking-aug5").meta.cc_payment_pair_role, "checking");
  assert.equal(data.transaction_categorizations.find((row) => row.transaction_id === "card-aug4").meta.cc_payment_pair_role, "credit_card");
});

test("confirms the same pair when started from the credit-card side", async () => {
  const { db, businessId } = makeDb();
  const result = await confirmCreditCardPaymentMatchForTransaction({
    db,
    businessId,
    transactionId: "card-aug4",
    targetQboAccountId: "qbo-bank",
    validateQboAccountType: validator,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.pair.checking_transaction_id, "checking-aug5");
  assert.equal(result.pair.credit_card_transaction_id, "card-aug4");
});

test("matches across the full five-day window but not outside it", async () => {
  const within = makeDb({
    bank_transactions: makeDb().data.bank_transactions.map((row) =>
      row.id === "card-aug4" ? { ...row, date: "2026-08-10" } : row
    ),
  });
  const matched = await confirmCreditCardPaymentMatchForTransaction({
    db: within.db,
    businessId: within.businessId,
    transactionId: "checking-aug5",
    targetQboAccountId: "qbo-blue",
    validateQboAccountType: validator,
  });
  assert.equal(matched.matched, true, JSON.stringify(matched));

  const outside = makeDb({
    bank_transactions: makeDb().data.bank_transactions.map((row) =>
      row.id === "card-aug4" ? { ...row, date: "2026-08-11" } : row
    ),
  });
  const notMatched = await confirmCreditCardPaymentMatchForTransaction({
    db: outside.db,
    businessId: outside.businessId,
    transactionId: "checking-aug5",
    targetQboAccountId: "qbo-blue",
    validateQboAccountType: validator,
  });
  assert.equal(notMatched.ok, false);
  assert.equal(notMatched.matched, false);
});

test("rejects same-sign candidates and wrong selected account identity", async () => {
  const sameSign = makeDb({
    bank_transactions: makeDb().data.bank_transactions.map((row) =>
      row.id === "card-aug4" ? { ...row, signed_amount: -322.57, direction: "OUTFLOW" } : row
    ),
  });
  const sameSignResult = await confirmCreditCardPaymentMatchForTransaction({
    db: sameSign.db,
    businessId: sameSign.businessId,
    transactionId: "checking-aug5",
    targetQboAccountId: "qbo-blue",
    validateQboAccountType: validator,
  });
  assert.equal(sameSignResult.matched, false);

  const wrongAccount = await confirmCreditCardPaymentMatchForTransaction({
    db: makeDb().db,
    businessId: "biz-1",
    transactionId: "checking-aug5",
    targetQboAccountId: "qbo-other-card",
    validateQboAccountType: validator,
  });
  assert.equal(wrongAccount.matched, false);
});
