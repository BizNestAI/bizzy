import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getTaxEligibilityReason, isTaxClassificationCandidate } from "../src/services/tax/taxTransactionEligibility.js";
import { normalizePostedTransactionForTax } from "../src/services/tax/taxTransactionNormalizer.js";
import {
  listPostedTransactionsForTax,
  listUnclassifiedPostedTransactions,
} from "../src/services/tax/taxPostedTransaction.repository.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";

test("eligibility accepts authoritative posted sources and rejects non-posted states", () => {
  const bank = bankTxn({ id: "t1" });
  assert.equal(isTaxClassificationCandidate({ bankTransaction: bank, categorization: cat({ status: "posted", qbo_txn_id: "qbo-1" }), businessId: BUSINESS_ID }), true);
  assert.equal(isTaxClassificationCandidate({ bankTransaction: bank, qboPostedTransaction: qbo({ status: "posted", qbo_txn_id: "qbo-1" }), businessId: BUSINESS_ID }), true);
  assert.equal(getTaxEligibilityReason({ bankTransaction: bank, categorization: cat({ status: "approved", qbo_txn_id: null }), businessId: BUSINESS_ID }), "approved_not_posted");
  assert.equal(getTaxEligibilityReason({ bankTransaction: bankTxn({ pending: true }), categorization: cat({ status: "posted", qbo_txn_id: "qbo-1" }), businessId: BUSINESS_ID }), "pending_transaction");
  assert.equal(getTaxEligibilityReason({ bankTransaction: bankTxn({ is_archived: true }), categorization: cat({ status: "posted", qbo_txn_id: "qbo-1" }), businessId: BUSINESS_ID }), "archived_transaction");
  assert.equal(getTaxEligibilityReason({ bankTransaction: bank, categorization: cat({ status: "ignored", qbo_txn_id: "qbo-1" }), businessId: BUSINESS_ID }), "ignored_transaction");
  assert.equal(getTaxEligibilityReason({ bankTransaction: bank, qboPostedTransaction: qbo({ status: "voided", qbo_txn_id: "qbo-1" }), businessId: BUSINESS_ID }), "voided_qbo_transaction");
  assert.equal(getTaxEligibilityReason({ bankTransaction: bank, qboPostedTransaction: qbo({ status: "failed", qbo_txn_id: "qbo-1" }), businessId: BUSINESS_ID }), "failed_post");
});

test("posted mismatch is flagged and internal transfer remains eligible with taxonomy hint", () => {
  const bank = bankTxn({ transaction_type: "transfer", direction: "OUTFLOW" });
  const categorization = cat({ status: "posted", qbo_txn_id: "cat-qbo", qbo_txn_type: "Expense", meta: { taxonomy_type: "transfer", suggestion_source: "rule_engine" } });
  const qboRow = qbo({ status: "posted", qbo_txn_id: "posted-qbo", qbo_txn_type: "JournalEntry" });
  const normalized = normalizePostedTransactionForTax({ bankTransaction: bank, categorization, qboPostedTransaction: qboRow });
  assert.equal(isTaxClassificationCandidate({ bankTransaction: bank, categorization, qboPostedTransaction: qboRow, businessId: BUSINESS_ID }), true);
  assert.equal(normalized.taxonomyType, "transfer");
  assert.equal(normalized.suggestionSource, "rule_engine");
  assert.equal(normalized.sourceWarnings.includes("qbo_id_mismatch"), true);
});

test("normalization prefers final QBO account, preserves signed amount, and hides raw payloads", () => {
  const normalized = normalizePostedTransactionForTax({
    bankTransaction: bankTxn({ signed_amount: -42.5, amount: 42.5, direction: "OUTFLOW", raw: { plaid: "secret" } }),
    categorization: cat({
      suggested_qbo_account_id: "suggested",
      suggested_qbo_account_name: "Suggested",
      final_qbo_account_id: "final",
      final_qbo_account_name: "Final",
      status: "posted",
      qbo_txn_id: "qbo-1",
    }),
    qboPostedTransaction: qbo({ payload: { qbo: "payload" }, response: { qbo: "response" } }),
  });
  assert.equal(normalized.qboAccountId, "final");
  assert.equal(normalized.qboAccountName, "Final");
  assert.equal(normalized.signedAmount, -42.5);
  assert.equal(normalized.absoluteAmount, 42.5);
  assert.equal(normalized.direction, "OUTFLOW");
  assert.equal(normalized.rawRefs.hasBankRaw, true);
  assert.equal(normalized.rawRefs.hasQboPayload, true);
  assert.equal(normalized.raw, undefined);
  assert.equal(normalized.payload, undefined);
  assert.equal(normalized.sourceTruth.categorizationPosted, true);
});

test("repository enforces business and year isolation with deterministic ordering", async () => {
  const supabase = makeSupabase({
    bank_transactions: [
      bankTxn({ id: "wrong-business", business_id: OTHER_BUSINESS_ID, date: "2026-07-01" }),
      bankTxn({ id: "wrong-year", date: "2027-01-01" }),
      bankTxn({ id: "older", date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" }),
      bankTxn({ id: "newer", date: "2026-06-01", created_at: "2026-06-01T00:00:00Z" }),
    ],
    transaction_categorizations: [
      cat({ transaction_id: "wrong-business", business_id: OTHER_BUSINESS_ID, status: "posted", qbo_txn_id: "qbo-x" }),
      cat({ transaction_id: "wrong-year", status: "posted", qbo_txn_id: "qbo-y" }),
      cat({ transaction_id: "older", status: "posted", qbo_txn_id: "qbo-o" }),
      cat({ transaction_id: "newer", status: "posted", qbo_txn_id: "qbo-n" }),
    ],
  });
  const result = await listPostedTransactionsForTax({ supabase, businessId: BUSINESS_ID, taxYear: 2026, limit: 10 });
  assert.deepEqual(result.rows.map((row) => row.transactionId), ["newer", "older"]);
});

test("repository paginates over more than 1000 posted rows", async () => {
  const bankRows = Array.from({ length: 1005 }, (_, i) => bankTxn({ id: `t-${String(i).padStart(4, "0")}`, date: "2026-01-01" }));
  const catRows = bankRows.map((row) => cat({ transaction_id: row.id, status: "posted", qbo_txn_id: `qbo-${row.id}` }));
  const result = await listPostedTransactionsForTax({
    supabase: makeSupabase({ bank_transactions: bankRows, transaction_categorizations: catRows }),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    limit: 10,
    offset: 1000,
  });
  assert.equal(result.rows.length, 5);
  assert.equal(result.pagination.total, 1005);
});

test("unclassified query only suppresses classifications for same tax year", async () => {
  const supabase = makeSupabase({
    bank_transactions: [bankTxn({ id: "same-year" }), bankTxn({ id: "other-year-classified" })],
    transaction_categorizations: [
      cat({ transaction_id: "same-year", status: "posted", qbo_txn_id: "qbo-1" }),
      cat({ transaction_id: "other-year-classified", status: "posted", qbo_txn_id: "qbo-2" }),
    ],
    transaction_tax_classifications: [
      { business_id: BUSINESS_ID, transaction_id: "same-year", tax_year: 2026 },
      { business_id: BUSINESS_ID, transaction_id: "other-year-classified", tax_year: 2025 },
    ],
  });
  const result = await listUnclassifiedPostedTransactions({ supabase, businessId: BUSINESS_ID, taxYear: 2026, limit: 10 });
  assert.deepEqual(result.rows.map((row) => row.transactionId), ["other-year-classified"]);
});

test("tax transactions API is mounted behind auth and validates business access/pagination", () => {
  const server = readFileSync(resolve(__dirname, "../src/server.js"), "utf8");
  const routes = readFileSync(resolve(__dirname, "../src/api/tax/taxTransactions.routes.js"), "utf8");
  assert.match(server, /app\.use\("\/api\/tax", requireAuth, taxRouter\)/);
  assert.match(routes, /assertTaxBusinessAccess/);
  assert.match(routes, /validatePagination/);
  assert.match(routes, /optionalTaxYear/);
});

function bankTxn(overrides = {}) {
  return {
    id: "t1",
    business_id: BUSINESS_ID,
    plaid_account_id: "acct-1",
    plaid_transaction_id: "plaid-1",
    pending: false,
    date: "2026-03-15",
    authorized_date: "2026-03-14",
    name: "Vendor charge",
    merchant_name: "Vendor",
    merchant_entity_id: "merchant-1",
    payment_channel: "online",
    transaction_type: "place",
    check_number: null,
    amount: 100,
    signed_amount: -100,
    direction: "OUTFLOW",
    category_primary: "GENERAL_MERCHANDISE",
    category_detailed: "GENERAL_MERCHANDISE_OTHER",
    personal_finance_category: null,
    counterparty_name: "Vendor LLC",
    qbo_entity_type: null,
    qbo_entity_id: null,
    is_archived: false,
    archived_at: null,
    duplicate_fingerprint: null,
    raw: null,
    location: null,
    counterparties: null,
    created_at: "2026-03-15T00:00:00Z",
    ...overrides,
  };
}

function cat(overrides = {}) {
  return {
    id: "cat-1",
    business_id: BUSINESS_ID,
    transaction_id: "t1",
    status: "posted",
    suggested_qbo_account_id: "suggested",
    suggested_qbo_account_name: "Suggested Account",
    confidence: 0.8,
    reason: "matched",
    final_qbo_account_id: null,
    final_qbo_account_name: null,
    decided_by: "user-1",
    decided_at: "2026-03-16T00:00:00Z",
    meta: {},
    post_after: null,
    qbo_txn_id: "qbo-1",
    qbo_txn_type: "Expense",
    posted_at: "2026-03-16T00:00:00Z",
    post_error: null,
    reconciled_at: null,
    txn_date: "2026-03-15",
    txn_name: "Vendor charge",
    signed_amount: -100,
    is_archived: false,
    ...overrides,
  };
}

function qbo(overrides = {}) {
  return {
    id: "qbo-row-1",
    business_id: BUSINESS_ID,
    transaction_id: "t1",
    qbo_env: "sandbox",
    realm_id: "realm",
    qbo_txn_type: "Expense",
    qbo_txn_id: "qbo-1",
    qbo_sync_token: "0",
    status: "posted",
    posted_at: "2026-03-16T00:00:00Z",
    error: null,
    payload: null,
    response: null,
    ...overrides,
  };
}

function makeSupabase(tables) {
  return {
    from(table) {
      return new Query(table, tables[table] || []);
    },
  };
}

class Query {
  constructor(_table, rows) {
    this.rows = [...rows];
    this.rangeStart = null;
    this.rangeEnd = null;
  }
  select() { return this; }
  eq(field, value) {
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }
  gte(field, value) {
    this.rows = this.rows.filter((row) => String(row[field] || "") >= String(value));
    return this;
  }
  lte(field, value) {
    this.rows = this.rows.filter((row) => String(row[field] || "") <= String(value));
    return this;
  }
  in(field, values) {
    const set = new Set(values.map(String));
    this.rows = this.rows.filter((row) => set.has(String(row[field])));
    return this;
  }
  order(field, { ascending = true } = {}) {
    this.rows = this.rows.sort((a, b) => {
      const av = String(a[field] || "");
      const bv = String(b[field] || "");
      return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    return this;
  }
  range(start, end) {
    const next = new Query("range", this.rows);
    next.rangeStart = start;
    next.rangeEnd = end;
    return next;
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  then(resolve) {
    const rows = this.rangeStart == null ? this.rows : this.rows.slice(this.rangeStart, this.rangeEnd + 1);
    return Promise.resolve({ data: rows, error: null }).then(resolve);
  }
}
