/* global process */
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

async function confirmCreditCardPaymentPairForTransaction(args) {
  servicePromise ||= import("../src/services/bookkeeping/creditCardPaymentPairService.js");
  const service = await servicePromise;
  return service.confirmCreditCardPaymentPairForTransaction(args);
}

async function undoCreditCardPaymentPairForTransaction(args) {
  servicePromise ||= import("../src/services/bookkeeping/creditCardPaymentPairService.js");
  const service = await servicePromise;
  return service.undoCreditCardPaymentPairForTransaction(args);
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
      const payloads = Array.isArray(this.payload) ? clone(this.payload) : [clone(this.payload)];
      const rows = this.db[this.table];
      const updated = payloads.map((payload) => {
        const idx = rows.findIndex((row) =>
          String(row.business_id) === String(payload.business_id) &&
          String(row.transaction_id) === String(payload.transaction_id)
        );
        if (idx >= 0) rows[idx] = { ...rows[idx], ...payload };
        else rows.push(payload);
        return idx >= 0 ? rows[idx] : payload;
      });
      return { data: this.single ? clone(updated[0] || null) : clone(updated), error: null };
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
        plaid_transaction_id: "plaid-checking-aug5",
        pending_transaction_id: null,
        amount: 322.57,
        signed_amount: -322.57,
        direction: "OUTFLOW",
        date: "2026-08-05",
        authorized_date: "2026-08-05",
        name: "ACH PMT AMEX EPAYMENT M335",
        is_archived: false,
        archived_at: null,
        archived_reason: null,
        pending: false,
        accounting_review_required: true,
      },
      {
        id: "card-aug4",
        business_id: businessId,
        plaid_account_id: "plaid-amex",
        plaid_transaction_id: "plaid-card-aug4",
        pending_transaction_id: null,
        amount: 322.5700000001,
        signed_amount: 322.5700000001,
        direction: "INFLOW",
        date: "2026-08-04",
        authorized_date: "2026-08-04",
        name: "MOBILE PAYMENT - THANK YOU",
        is_archived: false,
        archived_at: null,
        archived_reason: null,
        pending: false,
        accounting_review_required: true,
      },
    ],
    plaid_accounts: [
      { business_id: businessId, plaid_account_id: "plaid-checking", name: "Checking 8626", type: "depository", subtype: "checking" },
      { business_id: businessId, plaid_account_id: "plaid-amex", name: "Blue Cash Everyday", type: "credit", subtype: "credit card" },
    ],
    plaid_qbo_account_mappings: [
      { id: "map-checking", business_id: businessId, plaid_account_id: "plaid-checking", qbo_account_id: "qbo-bank", qbo_account_name: "Checking", qbo_account_type: "Bank" },
      { id: "map-amex", business_id: businessId, plaid_account_id: "plaid-amex", qbo_account_id: "qbo-blue", qbo_account_name: "Blue Cash Everyday", qbo_account_type: "CreditCard" },
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
  assert.equal(result.pair.status, "confirmed");
  const checkingCat = data.transaction_categorizations.find((row) => row.transaction_id === "checking-aug5");
  const cardCat = data.transaction_categorizations.find((row) => row.transaction_id === "card-aug4");
  assert.equal(checkingCat.status, "matched");
  assert.equal(cardCat.status, "matched");
  assert.equal(checkingCat.meta.cc_payment_pair_role, "checking");
  assert.equal(cardCat.meta.cc_payment_pair_role, "credit_card");
  assert.equal(checkingCat.final_qbo_account_id, null);
  assert.equal(cardCat.final_qbo_account_id, null);
  assert.equal(checkingCat.post_after, null);
  assert.equal(cardCat.post_after, null);
  assert.equal(checkingCat.meta.safe_to_auto_post, false);
  assert.equal(cardCat.meta.safe_to_auto_post, false);
  assert.equal(checkingCat.meta.match_type, "credit_card_payment_pair");
  assert.equal(cardCat.meta.match_type, "credit_card_payment_pair");
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

test("selected confirmation uses one atomic RPC without rerunning broad discovery", async () => {
  const calls = [];
  const db = {
    from() {
      throw new Error("selected fast path must not issue table queries");
    },
    async rpc(name, args) {
      calls.push({ name, args });
      return {
        data: {
          ok: true,
          matched: true,
          pair: { id: "pair-fast", status: "confirmed" },
          lifecycle_rows: [{ transaction_id: "checking-fast", status: "matched" }, { transaction_id: "card-fast", status: "matched" }],
          timings_ms: { database_transaction_precommit_ms: 12 },
        },
        error: null,
      };
    },
  };

  const result = await confirmCreditCardPaymentMatchForTransaction({
    db,
    businessId: "biz-1",
    transactionId: "checking-fast",
    targetTransactionId: "card-fast",
    targetQboAccountId: "qbo-blue",
    expectedCandidateVersion: "2026-09-22T12:00:00.000Z",
    idempotencyKey: "fast-idempotency",
    correlationId: "fast-correlation",
  });

  assert.equal(result.matched, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "confirm_selected_credit_card_payment_pair_atomic");
  assert.equal(calls[0].args.p_opposite_transaction_id, "card-fast");
  assert.equal(calls[0].args.p_expected_opposite_updated_at, "2026-09-22T12:00:00.000Z");
  assert.equal(calls[0].args.p_idempotency_key, "fast-idempotency");
  assert.equal(calls[0].args.p_correlation_id, "fast-correlation");
  assert.ok(result.timings_ms.database_rpc_round_trip_and_commit_ms >= 0);
});

test("maps a production status constraint failure to a safe schema-compatibility error", async () => {
  const { db, data, businessId } = makeDb({
    credit_card_payment_pairs: [{
      id: "pair-constraint",
      business_id: "biz-1",
      checking_transaction_id: "checking-aug5",
      credit_card_transaction_id: "card-aug4",
      status: "needs_review",
    }],
  });
  db.rpc = async () => ({
    data: null,
    error: {
      code: "23514",
      message: 'new row for relation "transaction_categorizations" violates check constraint "transaction_categorizations_status_check"',
    },
  });

  await assert.rejects(
    confirmCreditCardPaymentPairForTransaction({ db, businessId, transactionId: "checking-aug5" }),
    (error) => {
      assert.equal(error.code, "cc_payment_match_schema_update_required");
      assert.equal(error.status, 503);
      assert.equal(error.pgCode, "23514");
      assert.equal(error.constraint, "transaction_categorizations_status_check");
      assert.deepEqual(error.transactionIds, ["checking-aug5", "card-aug4"]);
      assert.deepEqual(error.attemptedTransition, { pair_status: "confirmed", categorization_status: "matched" });
      assert.doesNotMatch(error.message, /relation|constraint/i);
      return true;
    }
  );
  assert.equal(data.credit_card_payment_pairs[0].status, "needs_review");
  assert.equal(data.transaction_categorizations.every((row) => row.status === "needs_review"), true);
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

test("undoing a confirmed credit-card payment pair from either side restores both rows to Needs Match", async () => {
  const { db, data, businessId } = makeDb();
  const confirmed = await confirmCreditCardPaymentMatchForTransaction({
    db,
    businessId,
    transactionId: "card-aug4",
    targetQboAccountId: "qbo-bank",
    validateQboAccountType: validator,
  });
  assert.equal(confirmed.matched, true, JSON.stringify(confirmed));

  const undo = await undoCreditCardPaymentPairForTransaction({
    db,
    businessId,
    transactionId: "checking-aug5",
  });

  assert.equal(undo.ok, true, JSON.stringify(undo));
  assert.equal(undo.undone, true, JSON.stringify(undo));
  assert.deepEqual(new Set(undo.transaction_ids), new Set(["checking-aug5", "card-aug4"]));
  assert.equal(data.credit_card_payment_pairs[0].status, "voided");

  const checkingCat = data.transaction_categorizations.find((row) => row.transaction_id === "checking-aug5");
  const cardCat = data.transaction_categorizations.find((row) => row.transaction_id === "card-aug4");
  for (const cat of [checkingCat, cardCat]) {
    assert.equal(cat.status, "needs_review");
    assert.equal(cat.post_error, "cc_payment_pair_requires_confirmation");
    assert.equal(cat.meta.taxonomy_type, "cc_payment");
    assert.equal(cat.meta.cc_payment_pair_id, undefined);
    assert.equal(cat.meta.safe_to_auto_post, false);
  }
});

test("confirms the Sep 7 checking AMEX payment to the Sep 5 card-side payment", async () => {
  const base = makeDb();
  const { db, data, businessId } = makeDb({
    bank_transactions: [
      ...base.data.bank_transactions,
      {
        id: "checking-sep7-amex-40",
        business_id: base.businessId,
        plaid_account_id: "plaid-checking",
        plaid_transaction_id: "plaid-checking-sep7-amex-40",
        pending_transaction_id: null,
        amount: 40,
        signed_amount: -40,
        direction: "OUTFLOW",
        date: "2026-09-07",
        authorized_date: "2026-09-07",
        name: "ACH PMT AMEX EPAYMENT M7788",
        is_archived: false,
        archived_at: null,
        archived_reason: null,
        pending: false,
        accounting_review_required: true,
      },
      {
        id: "amex-sep5-mobile-payment-40",
        business_id: base.businessId,
        plaid_account_id: "plaid-amex",
        plaid_transaction_id: "plaid-amex-sep5-mobile-payment-40",
        pending_transaction_id: null,
        amount: 40,
        signed_amount: 40,
        direction: "INFLOW",
        date: "2026-09-05",
        authorized_date: "2026-09-05",
        name: "MOBILE PAYMENT - THANK YOU",
        is_archived: false,
        archived_at: null,
        archived_reason: null,
        pending: false,
        accounting_review_required: true,
      },
    ],
    transaction_categorizations: [
      ...base.data.transaction_categorizations,
      { business_id: base.businessId, transaction_id: "checking-sep7-amex-40", status: "needs_review", meta: {} },
      { business_id: base.businessId, transaction_id: "amex-sep5-mobile-payment-40", status: "needs_review", meta: {} },
    ],
  });

  const result = await confirmCreditCardPaymentMatchForTransaction({
    db,
    businessId,
    transactionId: "checking-sep7-amex-40",
    targetQboAccountId: "qbo-blue",
    validateQboAccountType: validator,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.pair.checking_transaction_id, "checking-sep7-amex-40");
  assert.equal(result.pair.credit_card_transaction_id, "amex-sep5-mobile-payment-40");
  assert.equal(data.credit_card_payment_pairs.length, 1);
  const checkingCat = data.transaction_categorizations.find((row) => row.transaction_id === "checking-sep7-amex-40");
  const cardCat = data.transaction_categorizations.find((row) => row.transaction_id === "amex-sep5-mobile-payment-40");
  assert.equal(checkingCat.status, "matched");
  assert.equal(cardCat.status, "matched");
  assert.equal(checkingCat.meta.safe_to_auto_post, false);
  assert.equal(cardCat.meta.safe_to_auto_post, false);
  assert.equal(checkingCat.meta.match_type, "credit_card_payment_pair");
  assert.equal(cardCat.meta.match_type, "credit_card_payment_pair");
});

test("hidden pending and posted versions collapse to one canonical card-side candidate", async () => {
  const base = makeDb();
  const { db, businessId } = makeDb({
    bank_transactions: [
      {
        ...base.data.bank_transactions[0],
        id: "checking-lineage-40",
        plaid_transaction_id: "plaid-checking-lineage-40",
        amount: 40,
        signed_amount: -40,
        date: "2026-09-07",
        name: "ACH PMT AMEX EPAYMENT M7788",
      },
      {
        ...base.data.bank_transactions[1],
        id: "card-lineage-pending-shadow",
        plaid_transaction_id: "pending-card-lineage-40",
        pending_transaction_id: null,
        amount: 40,
        signed_amount: 40,
        date: "2026-09-05",
        name: "MOBILE PAYMENT - THANK YOU",
        pending: false,
      },
      {
        ...base.data.bank_transactions[1],
        id: "card-lineage-posted",
        plaid_transaction_id: "posted-card-lineage-40",
        pending_transaction_id: "pending-card-lineage-40",
        amount: 40,
        signed_amount: 40,
        date: "2026-09-05",
        name: "MOBILE PAYMENT - THANK YOU",
        pending: false,
      },
    ],
    transaction_categorizations: [
      { business_id: base.businessId, transaction_id: "checking-lineage-40", status: "needs_review", meta: {} },
      { business_id: base.businessId, transaction_id: "card-lineage-pending-shadow", status: "needs_review", meta: {} },
      { business_id: base.businessId, transaction_id: "card-lineage-posted", status: "needs_review", meta: {} },
    ],
  });

  const result = await confirmCreditCardPaymentMatchForTransaction({
    db,
    businessId,
    transactionId: "checking-lineage-40",
    targetQboAccountId: "qbo-blue",
    validateQboAccountType: validator,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.pair.credit_card_transaction_id, "card-lineage-posted");
});

test("duplicate candidate rows with the same Plaid identity collapse to one candidate", async () => {
  const base = makeDb();
  const { db, businessId } = makeDb({
    bank_transactions: [
      {
        ...base.data.bank_transactions[0],
        id: "checking-duplicate-40",
        plaid_transaction_id: "plaid-checking-duplicate-40",
        amount: 40,
        signed_amount: -40,
        date: "2026-09-07",
        name: "ACH PMT AMEX EPAYMENT M7788",
      },
      {
        ...base.data.bank_transactions[1],
        id: "card-duplicate-a",
        plaid_transaction_id: "same-plaid-card-payment-40",
        amount: 40,
        signed_amount: 40,
        date: "2026-09-05",
      },
      {
        ...base.data.bank_transactions[1],
        id: "card-duplicate-b",
        plaid_transaction_id: "same-plaid-card-payment-40",
        amount: 40,
        signed_amount: 40,
        date: "2026-09-05",
      },
    ],
    transaction_categorizations: [
      { business_id: base.businessId, transaction_id: "checking-duplicate-40", status: "needs_review", meta: {} },
      { business_id: base.businessId, transaction_id: "card-duplicate-a", status: "needs_review", meta: {} },
      { business_id: base.businessId, transaction_id: "card-duplicate-b", status: "needs_review", meta: {} },
    ],
  });

  const result = await confirmCreditCardPaymentMatchForTransaction({
    db,
    businessId,
    transactionId: "checking-duplicate-40",
    targetQboAccountId: "qbo-blue",
    validateQboAccountType: validator,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.pair.credit_card_transaction_id, "card-duplicate-a");
});

test("already matched, removed, superseded, and pending rows are excluded from matching", async () => {
  const base = makeDb();
  const candidateTemplate = {
    ...base.data.bank_transactions[1],
    amount: 40,
    signed_amount: 40,
    date: "2026-09-05",
    name: "MOBILE PAYMENT - THANK YOU",
  };
  const { db, businessId } = makeDb({
    bank_transactions: [
      {
        ...base.data.bank_transactions[0],
        id: "checking-exclusions-40",
        plaid_transaction_id: "plaid-checking-exclusions-40",
        amount: 40,
        signed_amount: -40,
        date: "2026-09-07",
        name: "ACH PMT AMEX EPAYMENT M7788",
      },
      { ...candidateTemplate, id: "card-already-active", plaid_transaction_id: "plaid-card-already-active" },
      { ...candidateTemplate, id: "card-removed", plaid_transaction_id: "plaid-card-removed", is_archived: true, archived_reason: "removed" },
      { ...candidateTemplate, id: "card-superseded", plaid_transaction_id: "plaid-card-superseded", is_archived: true, archived_reason: "superseded_by_posted" },
      { ...candidateTemplate, id: "card-pending", plaid_transaction_id: "plaid-card-pending", pending: true },
      { ...candidateTemplate, id: "card-stale-matched-cat", plaid_transaction_id: "plaid-card-stale-matched-cat" },
    ],
    transaction_categorizations: [
      { business_id: base.businessId, transaction_id: "checking-exclusions-40", status: "needs_review", meta: {} },
      { business_id: base.businessId, transaction_id: "card-already-active", status: "needs_review", meta: {} },
      { business_id: base.businessId, transaction_id: "card-removed", status: "needs_review", meta: {} },
      { business_id: base.businessId, transaction_id: "card-superseded", status: "needs_review", meta: {} },
      { business_id: base.businessId, transaction_id: "card-pending", status: "needs_review", meta: {} },
      { business_id: base.businessId, transaction_id: "card-stale-matched-cat", status: "matched", meta: {} },
    ],
    credit_card_payment_pairs: [
      {
        id: "pair-active",
        business_id: base.businessId,
        checking_transaction_id: "other-checking",
        credit_card_transaction_id: "card-already-active",
        status: "confirmed",
      },
    ],
  });

  const result = await confirmCreditCardPaymentMatchForTransaction({
    db,
    businessId,
    transactionId: "checking-exclusions-40",
    targetQboAccountId: "qbo-blue",
    validateQboAccountType: validator,
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.matched, false, JSON.stringify(result));
  assert.equal(result.code, "no_safe_pair");
});

test("two genuinely distinct settled candidates produce structured picker candidates", async () => {
  const base = makeDb();
  const { db, businessId } = makeDb({
    bank_transactions: [
      {
        ...base.data.bank_transactions[0],
        id: "checking-ambiguous-40",
        plaid_transaction_id: "plaid-checking-ambiguous-40",
        amount: 40,
        signed_amount: -40,
        date: "2026-09-07",
        name: "ACH PMT AMEX EPAYMENT M7788",
      },
      {
        ...base.data.bank_transactions[1],
        id: "card-ambiguous-a",
        plaid_transaction_id: "plaid-card-ambiguous-a",
        amount: 40,
        signed_amount: 40,
        date: "2026-09-05",
      },
      {
        ...base.data.bank_transactions[1],
        id: "card-ambiguous-b",
        plaid_transaction_id: "plaid-card-ambiguous-b",
        amount: 40,
        signed_amount: 40,
        date: "2026-09-06",
      },
    ],
    transaction_categorizations: [
      { business_id: base.businessId, transaction_id: "checking-ambiguous-40", status: "needs_review", meta: {} },
      { business_id: base.businessId, transaction_id: "card-ambiguous-a", status: "needs_review", meta: {} },
      { business_id: base.businessId, transaction_id: "card-ambiguous-b", status: "needs_review", meta: {} },
    ],
  });

  const result = await confirmCreditCardPaymentMatchForTransaction({
    db,
    businessId,
    transactionId: "checking-ambiguous-40",
    targetQboAccountId: "qbo-blue",
    validateQboAccountType: validator,
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, "cc_payment_pair_ambiguous");
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map((candidate) => candidate.transaction_id), ["card-ambiguous-a", "card-ambiguous-b"]);
  for (const candidate of result.candidates) {
    assert.equal(candidate.amount_minor_units, 4000);
    assert.ok(candidate.plaid_transaction_id);
    assert.ok(candidate.canonical_lineage_key);
    assert.equal(candidate.qbo_account_mapping_id, "map-amex");
  }
});

test("selecting a specific candidate confirms both sides atomically", async () => {
  const base = makeDb();
  const { db, data, businessId } = makeDb({
    bank_transactions: [
      {
        ...base.data.bank_transactions[0],
        id: "checking-specific-40",
        plaid_transaction_id: "plaid-checking-specific-40",
        amount: 40,
        signed_amount: -40,
        date: "2026-09-07",
        name: "ACH PMT AMEX EPAYMENT M7788",
      },
      {
        ...base.data.bank_transactions[1],
        id: "card-specific-a",
        plaid_transaction_id: "plaid-card-specific-a",
        amount: 40,
        signed_amount: 40,
        date: "2026-09-05",
      },
      {
        ...base.data.bank_transactions[1],
        id: "card-specific-b",
        plaid_transaction_id: "plaid-card-specific-b",
        amount: 40,
        signed_amount: 40,
        date: "2026-09-06",
      },
    ],
    transaction_categorizations: [
      { business_id: base.businessId, transaction_id: "checking-specific-40", status: "needs_review", meta: {} },
      { business_id: base.businessId, transaction_id: "card-specific-a", status: "needs_review", meta: {} },
      { business_id: base.businessId, transaction_id: "card-specific-b", status: "needs_review", meta: {} },
    ],
  });

  const result = await confirmCreditCardPaymentMatchForTransaction({
    db,
    businessId,
    transactionId: "checking-specific-40",
    targetQboAccountId: "qbo-blue",
    targetTransactionId: "card-specific-b",
    validateQboAccountType: validator,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.pair.credit_card_transaction_id, "card-specific-b");
  assert.equal(data.transaction_categorizations.find((row) => row.transaction_id === "checking-specific-40").status, "matched");
  assert.equal(data.transaction_categorizations.find((row) => row.transaction_id === "card-specific-b").status, "matched");
  assert.equal(data.transaction_categorizations.find((row) => row.transaction_id === "card-specific-a").status, "needs_review");
});

test("repeating the same confirmation is idempotent", async () => {
  const { db, data, businessId } = makeDb();
  const first = await confirmCreditCardPaymentMatchForTransaction({
    db,
    businessId,
    transactionId: "checking-aug5",
    targetQboAccountId: "qbo-blue",
    validateQboAccountType: validator,
  });
  const second = await confirmCreditCardPaymentMatchForTransaction({
    db,
    businessId,
    transactionId: "checking-aug5",
    targetQboAccountId: "qbo-blue",
    validateQboAccountType: validator,
  });

  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.pair.id, first.pair.id);
  assert.equal(data.credit_card_payment_pairs.length, 1);
});

test("undo restores both sides and rematch reuses the voided request without duplicate candidates", async () => {
  const { db, data, businessId } = makeDb();
  const first = await confirmCreditCardPaymentMatchForTransaction({
    db,
    businessId,
    transactionId: "checking-aug5",
    targetQboAccountId: "qbo-blue",
    validateQboAccountType: validator,
  });
  assert.equal(first.ok, true, JSON.stringify(first));

  const undo = await undoCreditCardPaymentPairForTransaction({
    db,
    businessId,
    transactionId: "card-aug4",
  });
  assert.equal(undo.ok, true, JSON.stringify(undo));
  assert.equal(data.credit_card_payment_pairs[0].status, "voided");

  const rematch = await confirmCreditCardPaymentMatchForTransaction({
    db,
    businessId,
    transactionId: "checking-aug5",
    targetQboAccountId: "qbo-blue",
    validateQboAccountType: validator,
  });

  assert.equal(rematch.ok, true, JSON.stringify(rematch));
  assert.equal(rematch.pair.id, first.pair.id);
  assert.equal(rematch.reason, "voided_pair_reused");
  assert.equal(data.credit_card_payment_pairs.length, 1);
  assert.equal(data.credit_card_payment_pairs[0].status, "confirmed");
});
