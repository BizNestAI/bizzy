/* global process */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const {
  confirmIncomingDepositQboMatch,
  discoverIncomingDepositQboMatch,
  evaluateIncomingDepositPostingGuard,
} = await import("../src/services/bookkeeping/incomingDepositMatchService.js");
const {
  normalizeQboPaymentRecord,
  normalizeQboRevenueDocument,
} = await import("../src/services/jobCosting/qboJobCostingParsers.js");

const root = process.cwd();

test("normalizes QBO sales/payment fields needed for incoming deposit matching", () => {
  const now = new Date("2026-09-11T12:00:00Z");
  const invoice = normalizeQboRevenueDocument({
    Id: "1102",
    DocNumber: "1102",
    TxnDate: "2026-09-07",
    TotalAmt: 300,
    Balance: 0,
    CustomerRef: { value: "42", name: "Projection and Video LLC" },
    LinkedTxn: [{ TxnId: "pay-300", TxnType: "Payment" }],
    MetaData: { LastUpdatedTime: "2026-09-07T13:00:00Z" },
  }, "Invoice", { businessId: "b1", realmId: "r1", now });
  const payment = normalizeQboPaymentRecord({
    Id: "pay-300",
    TxnDate: "2026-09-07",
    TotalAmt: "300.00",
    UnappliedAmt: "0",
    CustomerRef: { value: "42", name: "Projection and Video LLC" },
    DepositToAccountRef: { value: "qbo-bank-1", name: "Checking" },
    PaymentRefNum: "73102173",
    PaymentMethodRef: { value: "pm-ach", name: "ACH" },
    Line: [{ Amount: 300, LinkedTxn: [{ TxnId: "1102", TxnType: "Invoice" }] }],
    MetaData: { LastUpdatedTime: "2026-09-07T14:00:00Z" },
  }, { businessId: "b1", realmId: "r1", now });

  assert.equal(invoice.amount_minor, 30000);
  assert.deepEqual(invoice.linked_payment_ids, ["pay-300"]);
  assert.equal(invoice.source_snapshot_at, now.toISOString());
  assert.equal(payment.amount_minor, 30000);
  assert.deepEqual(payment.customer_ref, { value: "42", name: "Projection and Video LLC" });
  assert.equal(payment.payment_ref_num, "73102173");
  assert.deepEqual(payment.linked_invoice_ids, ["1102"]);
  assert.equal(payment.deposit_ref.value, "qbo-bank-1");
});

test("blocks ordinary posting when one verified QBO Deposit candidate already exists", async () => {
  const db = fakeDb(baseMatchTables());

  const result = await discoverIncomingDepositQboMatch({
    db,
    businessId: "b1",
    bankTransactionId: "txn-300",
    persist: true,
    nowMs: Date.parse("2026-09-11T16:01:00Z"),
  });
  const guard = await evaluateIncomingDepositPostingGuard({
    db,
    businessId: "b1",
    bankTransactionId: "txn-300",
    nowMs: Date.parse("2026-09-11T16:01:00Z"),
  });

  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.confidence_tier, "tier_1");
  assert.equal(result.posting_eligibility, "blocked_confirmation_required");
  assert.equal(guard.allowed, false);
  assert.equal(db.tables.bank_qbo_matches.length, 1, "discovery is deduplicated by request key");
  assert.equal(db.tables.bank_qbo_matches[0].match_type, "qbo_deposit");
  assert.equal(db.tables.bank_qbo_match_items[0].qbo_entity_type, "Deposit");
  assert.equal(db.tables.transaction_categorizations[0].status, "needs_review");
  assert.equal(db.tables.transaction_categorizations[0].meta.safe_to_auto_post, false);
  assert.match(db.tables.transaction_categorizations[0].post_error, /possible_existing_qbo_match/);
  assert.equal(db.tables.transaction_categorizations[0].meta.incoming_deposit_candidates[0].qbo_entity_id, "dep-300");
});

test("stale or failed QBO cache blocks income posting without fabricating a match", async () => {
  const stale = baseMatchTables();
  stale.qbo_entity_sync_runs[0].finished_at = "2026-09-10T00:00:00Z";
  const db = fakeDb(stale);

  const result = await discoverIncomingDepositQboMatch({
    db,
    businessId: "b1",
    bankTransactionId: "txn-300",
    persist: true,
    nowMs: Date.parse("2026-09-11T16:01:00Z"),
  });

  assert.equal(result.status, "match_check_unavailable");
  assert.equal(result.posting_eligibility, "blocked_match_check_unavailable");
  assert.equal(result.candidates.length, 0);
  assert.equal(db.tables.transaction_categorizations[0].post_error, "match_check_unavailable");
});

test("inferred account mappings cannot produce Tier 1 and remain blocked with visible candidate evidence", async () => {
  const tables = baseMatchTables();
  tables.plaid_qbo_account_mappings[0].source = "auto";
  tables.plaid_qbo_account_mappings[0].confidence = "high";
  const db = fakeDb(tables);

  const result = await discoverIncomingDepositQboMatch({
    db,
    businessId: "b1",
    bankTransactionId: "txn-300",
    persist: true,
    nowMs: Date.parse("2026-09-11T16:01:00Z"),
  });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.confidence_tier, "tier_3");
  assert.equal(result.posting_eligibility, "blocked_unverified_bank_account_mapping");
  assert.ok(result.reason_codes.includes("bank_account_could_not_be_fully_verified"));
  assert.equal(result.candidates[0].qbo_entity_id, "dep-300");
});

test("confirmation is local-only, idempotent, and rejects stale QBO candidate versions", async () => {
  const db = fakeDb(baseMatchTables());
  const discovered = await discoverIncomingDepositQboMatch({
    db,
    businessId: "b1",
    bankTransactionId: "txn-300",
    persist: true,
    nowMs: Date.parse("2026-09-11T16:01:00Z"),
  });
  const matchId = discovered.match.id;

  const confirmed = await confirmIncomingDepositQboMatch({
    db,
    businessId: "b1",
    bankTransactionId: "txn-300",
    matchId,
    actor: "user-1",
    actorRole: "user",
    idempotencyKey: "idem-1",
    expectedBankUpdatedAt: "2026-09-07T18:00:00Z",
  });
  const again = await confirmIncomingDepositQboMatch({
    db,
    businessId: "b1",
    bankTransactionId: "txn-300",
    matchId,
    actor: "user-1",
    actorRole: "user",
    idempotencyKey: "idem-1",
  });

  assert.equal(confirmed.status, "confirmed");
  assert.equal(again.idempotent, true);
  assert.equal(db.tables.transaction_categorizations[0].status, "matched_existing_qbo");
  assert.equal(db.tables.transaction_categorizations[0].meta.qbo_write_performed, false);
  assert.equal(db.tables.bank_qbo_match_items[0].active_confirmed, true);
  assert.equal(db.tables.bank_qbo_match_history.some((row) => row.action === "confirmed" && row.actor === "user-1"), true);
  assert.ok(db.calls.every((call) => !["quickbooks_tokens", "qbo_posted_transactions"].includes(call.table || "")));

  await assert.rejects(
    () => confirmIncomingDepositQboMatch({ db, businessId: "b1", bankTransactionId: "txn-300", matchId, idempotencyKey: "different" }),
    /idempotency_key_mismatch/
  );

  const staleDb = fakeDb(baseMatchTables());
  const staleDiscovered = await discoverIncomingDepositQboMatch({
    db: staleDb,
    businessId: "b1",
    bankTransactionId: "txn-300",
    persist: true,
    nowMs: Date.parse("2026-09-11T16:01:00Z"),
  });
  staleDb.tables.job_revenue_evidence[0].sync_token = "1";
  await assert.rejects(
    () => confirmIncomingDepositQboMatch({ db: staleDb, businessId: "b1", bankTransactionId: "txn-300", matchId: staleDiscovered.match.id }),
    /qbo_match_candidate_stale/
  );
});

test("migration declares launch constraints, business-scoped FKs, and tenant RLS", () => {
  const sql = readFileSync(join(root, "supabase/migrations/20261009_incoming_deposit_qbo_matches.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS bank_qbo_matches/i);
  assert.match(sql, /CHECK \(status IN \([\s\S]*'matched_existing_qbo'/i);
  assert.match(sql, /bank_qbo_matches_one_active_confirmed_bank_txn/i);
  assert.match(sql, /bank_qbo_match_items_one_active_one_to_one_target/i);
  assert.match(sql, /active_confirmed = true/i);
  assert.match(sql, /FOREIGN KEY \(business_id, bank_transaction_id\)[\s\S]*REFERENCES public\.bank_transactions \(business_id, id\)/i);
  assert.match(sql, /FOREIGN KEY \(business_id, match_id\)[\s\S]*REFERENCES bank_qbo_matches \(business_id, id\)/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /tax_user_owns_business\(business_id\)/i);
  assert.match(sql, /request_idempotency_key/i);
});

test("routes are mounted, authenticated, business-authorized, and rate-limited", () => {
  const rootRoute = readFileSync(join(root, "src/api/bookkeeping/bookkeeping.routes.js"), "utf8");
  const route = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.incomingDepositMatches.routes.js"), "utf8");
  assert.match(rootRoute, /incomingDepositMatchesRoutes/);
  assert.match(route, /router\.get\("\/incoming-deposit-matches\/:transactionId", requireAuth/);
  assert.match(route, /router\.post\("\/incoming-deposit-matches\/:transactionId\/:matchId\/confirm", requireAuth, incomingDepositMatchWriteRateLimit/);
  assert.match(route, /router\.post\("\/incoming-deposit-matches\/:transactionId\/:matchId\/reject", requireAuth, incomingDepositMatchWriteRateLimit/);
  assert.match(route, /router\.post\("\/incoming-deposit-matches\/:transactionId\/:matchId\/undo", requireAuth, incomingDepositMatchWriteRateLimit/);
  assert.match(route, /assertTaxBusinessAccess\(\{ req, businessId, supabase \}\)/);
  assert.match(route, /Idempotency-Key/);
  assert.match(route, /expected_bank_updated_at/);
});

test("posting and frontend paths use incoming deposit guard states", () => {
  const cron = readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8");
  const approvals = readFileSync(join(root, "src/services/bookkeeping/bookkeepingApprovalService.js"), "utf8");
  const feed = readFileSync(join(root, "src/components/Accounting/BookkeepingFeed.jsx"), "utf8");
  const page = readFileSync(join(root, "src/pages/accounting/BookkeepingCleanup.jsx"), "utf8");
  const client = readFileSync(join(root, "src/services/bookkeeping/bookkeepingClient.js"), "utf8");

  assert.match(cron, /qboTxnType === "Deposit"[\s\S]*evaluateIncomingDepositPostingGuard/);
  assert.match(cron, /actorRole: "auto_post_selection"/);
  assert.match(approvals, /evaluateIncomingDepositPostingGuard/);
  assert.match(client, /inspectIncomingDepositMatch/);
  assert.match(client, /confirmIncomingDepositMatch/);
  assert.match(client, /rejectIncomingDepositMatch/);
  assert.match(client, /undoIncomingDepositMatch/);
  assert.match(feed, /Possible existing QuickBooks match/);
  assert.match(feed, /Match existing QuickBooks payment/);
  assert.match(feed, /This is not the same payment/);
  assert.match(feed, /Match check unavailable/);
  assert.match(feed, /Undo match/);
  assert.match(page, /hasIncomingDepositMatchWorkflow/);
  assert.match(page, /onConfirmIncomingDepositMatch/);
  assert.match(page, /onUndoIncomingDepositMatch/);
});

function baseMatchTables() {
  return {
    bank_transactions: [{
      id: "txn-300",
      business_id: "b1",
      plaid_transaction_id: "plaid-1",
      plaid_account_id: "plaid-checking",
      date: "2026-09-07",
      amount: 300,
      signed_amount: 300,
      direction: "INFLOW",
      iso_currency_code: "USD",
      pending: false,
      is_archived: false,
      name: "DEPOSIT INTUIT 73102173 OPTIMIST BOOKKEEPING ACH CREDIT",
      updated_at: "2026-09-07T18:00:00Z",
    }],
    plaid_qbo_account_mappings: [{
      id: "map-1",
      business_id: "b1",
      plaid_account_id: "plaid-checking",
      qbo_account_id: "qbo-bank-1",
      qbo_account_name: "Checking",
      qbo_account_type: "Bank",
      source: "manual",
      confidence: "verified",
    }],
    qbo_entity_sync_runs: [{
      id: "sync-1",
      business_id: "b1",
      status: "succeeded",
      started_at: "2026-09-11T15:55:00Z",
      finished_at: "2026-09-11T16:00:00Z",
      created_at: "2026-09-11T15:55:00Z",
    }],
    job_revenue_evidence: [{
      id: "ev-1",
      business_id: "b1",
      qbo_txn_id: "dep-300",
      qbo_txn_type: "Deposit",
      qbo_txn_date: "2026-09-07",
      amount_minor: 30000,
      currency: "USD",
      deposit_account_ref: { value: "qbo-bank-1", name: "Checking" },
      status: "confirmed",
      linked_payment_ids: ["pay-300"],
      sync_token: "0",
      source_snapshot_at: "2026-09-11T16:00:00Z",
      source_snapshot: { revenue_document_id: "doc-1102" },
    }],
    job_payment_records: [],
    job_revenue_documents: [],
    bank_qbo_matches: [],
    bank_qbo_match_items: [],
    bank_qbo_match_history: [],
    transaction_categorizations: [{
      business_id: "b1",
      transaction_id: "txn-300",
      status: "needs_review",
      meta: {},
    }],
  };
}

function fakeDb(initial = {}) {
  const tables = Object.fromEntries(Object.entries(initial).map(([key, rows]) => [key, rows.map((row) => ({ ...row }))]));
  return {
    tables,
    calls: [],
    from(table) {
      if (!tables[table]) tables[table] = [];
      return new FakeQuery(tables, table, this.calls);
    },
  };
}

class FakeQuery {
  constructor(tables, table, calls) {
    this.tables = tables;
    this.table = table;
    this.calls = calls;
    this.filters = [];
    this.orderSpec = null;
    this.limitCount = null;
    this.operation = "select";
    this.payload = null;
    this.single = false;
  }

  select() { this.calls.push({ op: "select", table: this.table }); return this; }
  eq(field, value) { this.calls.push({ op: "eq", table: this.table, field }); this.filters.push((row) => String(row[field]) === String(value)); return this; }
  in(field, values) { this.calls.push({ op: "in", table: this.table, field }); const set = new Set((values || []).map(String)); this.filters.push((row) => set.has(String(row[field]))); return this; }
  gte(field, value) { this.filters.push((row) => String(row[field] || "") >= String(value || "")); return this; }
  lte(field, value) { this.filters.push((row) => String(row[field] || "") <= String(value || "")); return this; }
  is(field, value) { this.filters.push((row) => (value === null ? row[field] == null : row[field] === value)); return this; }
  order(field, options = {}) { this.orderSpec = { field, ascending: options.ascending !== false }; return this; }
  limit(count) { this.limitCount = count; return this; }
  maybeSingle() { this.single = true; return this; }
  insert(payload) { this.calls.push({ op: "insert", table: this.table }); this.operation = "insert"; this.payload = Array.isArray(payload) ? payload : [payload]; return this; }
  update(payload) { this.calls.push({ op: "update", table: this.table }); this.operation = "update"; this.payload = payload || {}; return this; }

  then(resolve) {
    let rows = this.tables[this.table];
    if (this.operation === "insert") {
      const inserted = this.payload.map((row, index) => ({ id: row.id || `${this.table}-${rows.length + index + 1}`, ...row }));
      rows.push(...inserted);
      return resolve({ data: this.single ? inserted[0] : inserted, error: null });
    }
    const matched = rows.filter((row) => this.filters.every((fn) => fn(row)));
    if (this.operation === "update") {
      matched.forEach((row) => Object.assign(row, this.payload));
      return resolve({ data: this.single ? matched[0] || null : matched, error: null });
    }
    let data = [...matched];
    if (this.orderSpec) {
      const { field, ascending } = this.orderSpec;
      data.sort((a, b) => ascending ? String(a[field] || "").localeCompare(String(b[field] || "")) : String(b[field] || "").localeCompare(String(a[field] || "")));
    }
    if (this.limitCount !== null) data = data.slice(0, this.limitCount);
    return resolve({ data: this.single ? data[0] || null : data, error: null });
  }
}
