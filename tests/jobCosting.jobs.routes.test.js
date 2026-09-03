/* global process, Buffer */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Readable, Writable } from "node:stream";
import express from "express";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
process.env.BIZZY_AUTH_BYPASS = "true";

const [{ default: jobsRouter }, { supabase }] = await Promise.all([
  import("../src/api/Jobs/jobs.routes.js"),
  import("../src/services/supabaseAdmin.js"),
]);

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_JOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TXN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_TXN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class SupabaseQuery {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.operation = "select";
    this.filters = [];
    this.payload = null;
    this.limitCount = null;
    this.offsetCount = 0;
    this.countRequested = false;
  }

  select(_columns, options = {}) {
    this.countRequested = Boolean(options?.count);
    return this;
  }

  eq(field, value) {
    this.filters.push((row) => String(row[field]) === String(value));
    return this;
  }

  in(field, values) {
    const accepted = new Set((values || []).map(String));
    this.filters.push((row) => accepted.has(String(row[field])));
    return this;
  }

  is(field, value) {
    this.filters.push((row) => row[field] === value);
    return this;
  }

  order() {
    return this;
  }

  limit(count) {
    this.limitCount = Number(count);
    return this;
  }

  range(from, to) {
    this.offsetCount = Math.max(Number(from) || 0, 0);
    this.limitCount = Math.max((Number(to) || 0) - this.offsetCount + 1, 0);
    return this;
  }

  insert(payload) {
    this.operation = "insert";
    this.payload = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  update(payload) {
    this.operation = "update";
    this.payload = payload;
    return this;
  }

  upsert(payload) {
    this.operation = "upsert";
    this.payload = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  delete() {
    this.operation = "delete";
    return this;
  }

  async maybeSingle() {
    const result = await this._execute();
    return { data: result.data?.[0] || null, error: result.error };
  }

  async single() {
    const result = await this._execute();
    return { data: result.data?.[0] || null, error: result.error };
  }

  then(resolve, reject) {
    return this._execute().then(resolve, reject);
  }

  _matches(row) {
    return this.filters.every((filter) => filter(row));
  }

  _upsertKey(row) {
    if (this.table === "job_transaction_assignments") {
      return `${row.business_id}:${row.job_id}:${row.transaction_id}`;
    }
    return row.id || `${this.table}-${this.store.__id++}`;
  }

  async _execute() {
    if (this.store.__tableErrors?.[this.table]) {
      return { data: null, error: this.store.__tableErrors[this.table] };
    }
    const rows = this.store[this.table] || [];

    if (this.operation === "insert") {
      const inserted = this.payload.map((row) => {
        const next = {
          id: row.id || `${this.table}-${this.store.__id++}`,
          created_at: row.created_at || new Date().toISOString(),
          updated_at: row.updated_at || new Date().toISOString(),
          ...clone(row),
        };
        rows.push(next);
        return clone(next);
      });
      this.store[this.table] = rows;
      return { data: inserted, error: null };
    }

    if (this.operation === "upsert") {
      const upserted = this.payload.map((row) => {
        const key = this._upsertKey(row);
        const index = rows.findIndex((candidate) => this._upsertKey(candidate) === key);
        const next = {
          id: row.id || rows[index]?.id || `${this.table}-${this.store.__id++}`,
          created_at: rows[index]?.created_at || row.created_at || new Date().toISOString(),
          updated_at: row.updated_at || new Date().toISOString(),
          ...(index >= 0 ? rows[index] : {}),
          ...clone(row),
        };
        if (index >= 0) rows[index] = next;
        else rows.push(next);
        return clone(next);
      });
      this.store[this.table] = rows;
      return { data: upserted, error: null };
    }

    if (this.operation === "update") {
      const updated = [];
      for (const row of rows) {
        if (this._matches(row)) {
          Object.assign(row, clone(this.payload));
          updated.push(clone(row));
        }
      }
      return { data: updated, error: null };
    }

    if (this.operation === "delete") {
      const deleted = [];
      const kept = [];
      for (const row of rows) {
        if (this._matches(row)) deleted.push(clone(row));
        else kept.push(row);
      }
      this.store[this.table] = kept;
      return { data: deleted, error: null };
    }

    let selected = rows.filter((row) => this._matches(row)).map(clone);
    const total = selected.length;
    if (Number.isFinite(this.offsetCount) && this.offsetCount > 0) selected = selected.slice(this.offsetCount);
    if (Number.isFinite(this.limitCount)) selected = selected.slice(0, this.limitCount);
    return { data: selected, error: null, count: this.countRequested ? total : null };
  }
}

function makeRpcPostedRow({ id, businessId = BUSINESS_ID, date = "2026-08-01", qboId = null, assigned = false } = {}) {
  return {
    id,
    business_id: businessId,
    plaid_account_id: "plaid-account-1",
    date,
    name: `Vendor ${id}`,
    merchant_name: `Vendor ${id}`,
    amount: -25,
    pending: false,
    cat_status: qboId ? "posted" : "approved",
    qbo_txn_id: qboId,
    qbo_txn_type: qboId ? "Purchase" : null,
    final_qbo_account_id: "acct-cost",
    final_qbo_account_name: "Materials",
    posted_at: qboId ? "2026-09-02T12:00:00.000Z" : null,
    assigned,
  };
}

function createSupabaseMock(initial = {}) {
  const store = {
    jobs: [],
    bank_transactions: [],
    transaction_categorizations: [],
    job_transaction_assignments: [],
    assignment_history: [],
    job_assignment_suggestions: [],
    job_change_orders: [],
    job_revenue_evidence: [],
    job_revenue_documents: [],
    job_payment_allocations: [],
    business_profiles: [],
    job_candidates: [],
    qbo_projects_capabilities: [],
    __id: 1,
    ...clone(initial),
  };
  return {
    store,
    from(table) {
      if (!store[table]) store[table] = [];
      return new SupabaseQuery(store, table);
    },
    async rpc(name, args = {}) {
      if (name !== "get_bookkeeping_transactions_bounded") {
        return { data: null, error: { code: "42883", message: `Unknown RPC ${name}` } };
      }
      const businessId = args.p_business_id;
      const status = String(args.p_status_filter || "needs_review").toLowerCase();
      const limit = Math.max(Number(args.p_limit || 25), 0);
      const offset = Math.max(Number(args.p_offset || 0), 0);
      let rows = (store.bookkeeping_rpc_rows || []).filter((row) => String(row.business_id) === String(businessId));
      if (status === "posted") rows = rows.filter((row) => Boolean(row.qbo_txn_id) || String(row.cat_status || "").toLowerCase() === "posted");
      rows = rows
        .slice()
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || String(b.id).localeCompare(String(a.id)));
      const total = rows.length;
      return {
        data: rows.slice(offset, offset + limit).map((row) => ({ ...clone(row), total_count: total })),
        error: null,
      };
    },
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/job-costing", jobsRouter);
  return app;
}

async function request(app, path, { method = "GET", body, businessId = BUSINESS_ID } = {}) {
  const chunks = [];
  const requestBody = body ? JSON.stringify(body) : "";
  const req = new Readable({
    read() {
      if (requestBody) this.push(requestBody);
      this.push(null);
    },
  });
  req.method = method;
  req.url = path;
  req.headers = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(requestBody),
    "x-business-id": businessId,
  };

  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = value;
  };
  res.getHeader = (name) => res.headers[String(name).toLowerCase()];
  res.removeHeader = (name) => {
    delete res.headers[String(name).toLowerCase()];
  };
  res.write = (chunk) => {
    if (chunk) chunks.push(Buffer.from(chunk));
    return true;
  };
  res.end = (chunk) => {
    if (chunk) chunks.push(Buffer.from(chunk));
    res.emit("finish");
  };

  await new Promise((resolve, reject) => {
    res.on("finish", resolve);
    res.on("error", reject);
    app.handle(req, res, reject);
  });

  const text = Buffer.concat(chunks).toString("utf8");
  return { status: res.statusCode, body: text ? JSON.parse(text) : null };
}

describe("job costing jobs routes", () => {
  let app;
  let mockSupabase;
  let originalFrom;
  let originalRpc;
  let originalConsoleError;

  beforeEach(() => {
    originalFrom = supabase.from;
    originalRpc = supabase.rpc;
    originalConsoleError = console.error;
    console.error = () => {};
    mockSupabase = createSupabaseMock({
      jobs: [
        { id: JOB_ID, business_id: BUSINESS_ID, job_name: "Kitchen Remodel", status: "active" },
        { id: "same-business-job-2", business_id: BUSINESS_ID, job_name: "Bathroom Remodel", status: "active" },
        { id: OTHER_JOB_ID, business_id: OTHER_BUSINESS_ID, job_name: "Other Business Job", status: "active" },
      ],
      bank_transactions: [
        { id: TXN_ID, business_id: BUSINESS_ID, amount: -1000, direction: "OUTFLOW", is_archived: false, name: "Home Depot" },
        { id: OTHER_TXN_ID, business_id: OTHER_BUSINESS_ID, amount: -500, direction: "OUTFLOW", is_archived: false, name: "Other Vendor" },
      ],
      transaction_categorizations: [
        {
          transaction_id: TXN_ID,
          business_id: BUSINESS_ID,
          status: "posted",
          qbo_txn_id: "qbo-1",
          final_qbo_account_id: "acct-1",
          final_qbo_account_name: "Materials COGS",
          qbo_account_type: "Cost of Goods Sold",
        },
        {
          transaction_id: OTHER_TXN_ID,
          business_id: OTHER_BUSINESS_ID,
          status: "posted",
          qbo_txn_id: "qbo-other",
          final_qbo_account_name: "Materials COGS",
        },
      ],
    });
    supabase.from = mockSupabase.from.bind(mockSupabase);
    supabase.rpc = mockSupabase.rpc.bind(mockSupabase);
    app = createApp();
  });

  afterEach(() => {
    supabase.from = originalFrom;
    supabase.rpc = originalRpc;
    console.error = originalConsoleError;
  });

  test("only posted Books transactions can be assigned to jobs", async () => {
    mockSupabase.store.transaction_categorizations[0].status = "needs_review";
    mockSupabase.store.transaction_categorizations[0].qbo_txn_id = null;

    const response = await request(app, "/api/job-costing/assignments", {
      method: "POST",
      body: { job_id: JOB_ID, transaction_id: TXN_ID },
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, "transaction_not_posted");
    assert.equal(mockSupabase.store.job_transaction_assignments.length, 0);
  });

  test("rejects assignment to a job outside the current business", async () => {
    const response = await request(app, "/api/job-costing/assignments", {
      method: "POST",
      body: { job_id: OTHER_JOB_ID, transaction_id: TXN_ID },
    });

    assert.equal(response.status, 404);
    assert.equal(response.body.error, "job_not_found");
    assert.equal(mockSupabase.store.job_transaction_assignments.length, 0);
  });

  test("prevents allocation totals above 100 percent when appending splits", async () => {
    mockSupabase.store.job_transaction_assignments.push({
      id: "existing-assignment",
      business_id: BUSINESS_ID,
      job_id: "same-business-job-2",
      transaction_id: TXN_ID,
      allocated_amount: 600,
      allocation_percent: 60,
      source: "manual_drag_drop",
    });

    const response = await request(app, "/api/job-costing/assignments", {
      method: "POST",
      body: {
        job_id: JOB_ID,
        transaction_id: TXN_ID,
        allocation_percent: 50,
        replace_existing: false,
      },
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, "transaction_fully_allocated");
    assert.equal(mockSupabase.store.job_transaction_assignments.length, 1);
  });

  test("approves only suggestions scoped to the current business", async () => {
    mockSupabase.store.job_assignment_suggestions.push({
      id: "other-suggestion",
      business_id: OTHER_BUSINESS_ID,
      transaction_id: OTHER_TXN_ID,
      suggested_job_id: OTHER_JOB_ID,
      confidence_score: 90,
      confidence_label: "high",
      reasoning: { summary: "Other business suggestion" },
      status: "pending",
    });

    const response = await request(app, "/api/job-costing/suggestions/other-suggestion/approve", {
      method: "POST",
    });

    assert.equal(response.status, 404);
    assert.equal(response.body.error, "suggestion_not_found");
    assert.equal(mockSupabase.store.job_transaction_assignments.length, 0);
  });

  test("assignment impact preview classifies invoice, payment, deposit, credit memo, unmatched inflow, and expense", async () => {
    const cases = [
      ["Invoice", "invoice", { revenue_delta: 1000, outstanding_receivable_delta: 1000 }],
      ["Payment", "qbo_payment", { collected_cash_delta: 1000, outstanding_receivable_delta: -1000 }],
      ["Deposit", "bank_deposit_evidence", { revenue_delta: 0 }],
      ["SalesReceipt", "sales_receipt", { revenue_delta: 1000, collected_cash_delta: 1000 }],
      ["CreditMemo", "credit_memo", { revenue_delta: -1000 }],
      ["", "unmatched_inflow", { requires_user_choice: true }],
    ];

    for (const [qboType, role, expected] of cases) {
      mockSupabase.store.bank_transactions[0].amount = 1000;
      mockSupabase.store.bank_transactions[0].direction = "INFLOW";
      mockSupabase.store.transaction_categorizations[0].qbo_txn_type = qboType;
      mockSupabase.store.transaction_categorizations[0].qbo_account_type = "Income";
      mockSupabase.store.transaction_categorizations[0].final_qbo_account_name = "Sales Income";
      const response = await request(app, "/api/job-costing/assignment-impact-preview", {
        method: "POST",
        body: { job_id: JOB_ID, transaction_id: TXN_ID },
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.impact.financial_role, role);
      for (const [field, value] of Object.entries(expected)) {
        assert.equal(response.body.impact[field], value);
      }
    }

    mockSupabase.store.bank_transactions[0].amount = -1000;
    mockSupabase.store.bank_transactions[0].direction = "OUTFLOW";
    mockSupabase.store.transaction_categorizations[0].qbo_txn_type = "";
    mockSupabase.store.transaction_categorizations[0].qbo_account_type = "Cost of Goods Sold";
    mockSupabase.store.transaction_categorizations[0].final_qbo_account_name = "Materials COGS";
    const expense = await request(app, "/api/job-costing/assignment-impact-preview", {
      method: "POST",
      body: { job_id: JOB_ID, transaction_id: TXN_ID },
    });

    assert.equal(expense.status, 200);
    assert.equal(expense.body.impact.financial_role, "expense");
    assert.equal(expense.body.impact.cost_delta, 1000);
    assert.equal(expense.body.impact.safe_to_assign_without_confirmation, true);
  });

  test("ambiguous assignment cannot bypass impact preview confirmation", async () => {
    mockSupabase.store.bank_transactions[0].amount = 1500;
    mockSupabase.store.bank_transactions[0].direction = "INFLOW";
    mockSupabase.store.transaction_categorizations[0].qbo_txn_type = "";
    mockSupabase.store.transaction_categorizations[0].qbo_account_type = "Income";
    mockSupabase.store.transaction_categorizations[0].final_qbo_account_name = "Sales Income";

    const blocked = await request(app, "/api/job-costing/assignments", {
      method: "POST",
      body: { job_id: JOB_ID, transaction_id: TXN_ID },
    });

    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "assignment_impact_preview_required");
    assert.equal(blocked.body.impact.financial_role, "unmatched_inflow");
    assert.equal(mockSupabase.store.job_transaction_assignments.length, 0);

    const confirmed = await request(app, "/api/job-costing/assignments", {
      method: "POST",
      body: { job_id: JOB_ID, transaction_id: TXN_ID, impact_preview_confirmed: true },
    });

    assert.equal(confirmed.status, 200);
    assert.equal(mockSupabase.store.job_transaction_assignments.length, 1);
  });

  test("job summary does not fabricate revenue from positive assigned transactions without canonical summary", async () => {
    mockSupabase.store.bank_transactions[0].amount = 2400;
    mockSupabase.store.bank_transactions[0].direction = "INFLOW";
    mockSupabase.store.transaction_categorizations[0].qbo_account_type = "Income";
    mockSupabase.store.transaction_categorizations[0].final_qbo_account_name = "Sales Income";
    mockSupabase.store.job_transaction_assignments.push({
      id: "assigned-inflow",
      business_id: BUSINESS_ID,
      job_id: JOB_ID,
      transaction_id: TXN_ID,
      allocated_amount: 2400,
      allocation_percent: 100,
      source: "manual_drag_drop",
    });

    const response = await request(app, "/api/job-costing/jobs/summary", { method: "GET" });

    assert.equal(response.status, 200);
    const job = response.body.jobs.find((row) => row.id === JOB_ID);
    assert.equal(job.legacy_assigned_revenue, 2400);
    assert.equal(job.revenue_source_status, "summary_refreshing");
    assert.equal(job.job_costing_revenue, 0);
    assert.equal(job.revenue, 0);
  });

  test("candidate approval preview returns backend-derived impact", async () => {
    mockSupabase.store.job_candidates.push({
      id: "candidate-1",
      business_id: BUSINESS_ID,
      suggested_job_name: "Kitchen Refresh",
      customer_name: "Avery Smith",
      source_system: "quickbooks",
      source_entity_type: "invoice",
      source_entity_id: "inv-1",
      invoice_estimate_amount: 8500,
    });

    const response = await request(app, "/api/job-costing/job-candidates/candidate-1/approval-preview", {
      method: "POST",
      body: { mode: "create_new" },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.preview.job_to_create.job_name, "Kitchen Refresh");
    assert.equal(response.body.preview.documents_to_attach.length, 1);
    assert.equal(response.body.preview.invoiced_revenue_change, 8500);
    assert.equal(response.body.preview.collected_cash_change, 0);
    assert.equal(response.body.preview.receivable_change, 8500);
    assert.equal(response.body.preview.duplicate_prevention.result, "source_document_identity_checked");
  });

  test("candidate approval creates revenue document evidence for immediate live-job margin", async () => {
    mockSupabase.store.job_candidates.push({
      id: "candidate-revenue-1",
      business_id: BUSINESS_ID,
      candidate_status: "pending",
      suggested_job_name: "Projection and Video LLC",
      customer_name: "Projection and Video LLC",
      source_system: "quickbooks",
      source_entity_type: "Invoice",
      source_entity_id: "1099",
      document_number: "1099",
      invoice_date: "2026-08-18",
      invoice_estimate_amount: 1500,
      service_address: { line1: "123 Main St", city: "Charlotte", country_subdivision_code: "NC", postal_code: "28202" },
    });

    const approveResponse = await request(app, "/api/job-costing/job-candidates/candidate-revenue-1/approve-new", {
      method: "POST",
      body: { user_id: "user-1", approval_preview_confirmed: true, job: { job_costing_revenue_basis: "invoiced" } },
    });

    assert.equal(approveResponse.status, 200);
    assert.equal(mockSupabase.store.job_revenue_documents.length, 1);
    assert.equal(mockSupabase.store.job_revenue_documents[0].job_id, approveResponse.body.job.id);
    assert.equal(mockSupabase.store.job_revenue_documents[0].source_document_type, "invoice");
    assert.equal(mockSupabase.store.job_revenue_documents[0].external_document_id, "1099");
    assert.equal(mockSupabase.store.job_revenue_documents[0].total_amount, 1500);

    const summaryResponse = await request(app, "/api/job-costing/jobs/summary", { method: "GET" });
    const job = summaryResponse.body.jobs.find((row) => row.id === approveResponse.body.job.id);
    assert.equal(job.revenue_source_status, "canonical");
    assert.equal(job.job_costing_revenue, 1500);
    assert.equal(job.margin_percent, 100);
  });

  test("candidate-created job can be moved back to Suggested Jobs when unassigned", async () => {
    mockSupabase.store.jobs = [
      { id: "candidate-job-1", business_id: BUSINESS_ID, job_name: "Projection and Video LLC", creation_method: "job_candidate", status: "active" },
    ];
    mockSupabase.store.job_candidates = [
      {
        id: "candidate-revert-1",
        business_id: BUSINESS_ID,
        candidate_status: "approved_new",
        confirmed_job_id: "candidate-job-1",
        suggested_job_name: "Projection and Video LLC",
        confidence_score: 62,
      },
    ];
    mockSupabase.store.job_revenue_documents = [
      { id: "doc-1", business_id: BUSINESS_ID, job_id: "candidate-job-1", source_system: "quickbooks", source_document_type: "invoice", external_document_id: "1099", total_amount: 1500 },
    ];

    const response = await request(app, "/api/job-costing/jobs/candidate-job-1/revert-to-candidate", {
      method: "POST",
      body: {},
    });

    assert.equal(response.status, 200);
    assert.equal(mockSupabase.store.jobs.some((job) => job.id === "candidate-job-1"), false);
    assert.equal(mockSupabase.store.job_candidates[0].candidate_status, "pending");
    assert.equal(mockSupabase.store.job_candidates[0].confirmed_job_id, null);
    assert.equal(mockSupabase.store.job_revenue_documents[0].job_id, null);
    assert.equal(response.body.candidates[0].candidate_status, "pending");
  });

  test("candidate-linked job can move back to Suggested Jobs even when creation_method is absent", async () => {
    mockSupabase.store.jobs = [
      { id: "candidate-job-without-method", business_id: BUSINESS_ID, job_name: "Projection and Video LLC", status: "active" },
    ];
    mockSupabase.store.job_candidates = [
      {
        id: "candidate-revert-linked",
        business_id: BUSINESS_ID,
        candidate_status: "approved_new",
        confirmed_job_id: "candidate-job-without-method",
        suggested_job_name: "Projection and Video LLC",
      },
    ];
    mockSupabase.store.job_revenue_documents = [
      { id: "doc-linked", business_id: BUSINESS_ID, job_id: "candidate-job-without-method", source_document_type: "invoice", external_document_id: "1099", total_amount: 1500 },
    ];

    const response = await request(app, "/api/job-costing/jobs/candidate-job-without-method/revert-to-candidate", {
      method: "POST",
      body: {},
    });

    assert.equal(response.status, 200);
    assert.equal(mockSupabase.store.jobs.some((job) => job.id === "candidate-job-without-method"), false);
    assert.equal(mockSupabase.store.job_candidates[0].candidate_status, "pending");
    assert.equal(mockSupabase.store.job_candidates[0].confirmed_job_id, null);
    assert.equal(mockSupabase.store.job_revenue_documents[0].job_id, null);
  });

  test("manual job without a candidate link cannot move back to Suggested Jobs", async () => {
    mockSupabase.store.jobs = [
      { id: "manual-job-1", business_id: BUSINESS_ID, job_name: "Manual Job", creation_method: "manual", status: "active" },
    ];
    mockSupabase.store.job_candidates = [];

    const response = await request(app, "/api/job-costing/jobs/manual-job-1/revert-to-candidate", {
      method: "POST",
      body: {},
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, "job_revert_not_supported");
    assert.equal(mockSupabase.store.jobs.some((job) => job.id === "manual-job-1"), true);
  });

  test("candidate-created job cannot move back to Suggested Jobs while assignments exist", async () => {
    mockSupabase.store.jobs = [
      { id: "candidate-job-2", business_id: BUSINESS_ID, job_name: "Projection and Video LLC", creation_method: "job_candidate", status: "active" },
    ];
    mockSupabase.store.job_candidates = [
      { id: "candidate-revert-2", business_id: BUSINESS_ID, candidate_status: "approved_new", confirmed_job_id: "candidate-job-2" },
    ];
    mockSupabase.store.job_transaction_assignments = [
      { id: "assignment-1", business_id: BUSINESS_ID, job_id: "candidate-job-2", transaction_id: TXN_ID },
    ];

    const response = await request(app, "/api/job-costing/jobs/candidate-job-2/revert-to-candidate", {
      method: "POST",
      body: {},
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error, "job_has_assignments");
    assert.equal(mockSupabase.store.jobs.some((job) => job.id === "candidate-job-2"), true);
    assert.equal(mockSupabase.store.job_candidates[0].candidate_status, "approved_new");
  });

  test("manual job can be soft deleted when it has no assignments", async () => {
    mockSupabase.store.jobs = [
      { id: "manual-delete-1", business_id: BUSINESS_ID, job_name: "Manual Job", creation_method: "manual", source_type: "manual", status: "active" },
    ];

    const response = await request(app, "/api/job-costing/jobs/manual-delete-1/manual", {
      method: "DELETE",
      body: {},
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.deleted_job_id, "manual-delete-1");
    assert.equal(mockSupabase.store.jobs[0].status, "archived");
    assert.ok(mockSupabase.store.jobs[0].archived_at);
    assert.equal(response.body.jobs.some((job) => job.id === "manual-delete-1"), false);
  });

  test("manual job deletion is idempotent when the authorized manual job is already archived", async () => {
    const archivedAt = "2026-09-03T21:13:20.761Z";
    mockSupabase.store.jobs = [
      {
        id: "manual-delete-archived",
        business_id: BUSINESS_ID,
        job_name: "Manual Job",
        creation_method: "manual",
        source_type: "manual",
        status: "archived",
        archived_at: archivedAt,
      },
    ];

    const response = await request(app, "/api/job-costing/jobs/manual-delete-archived/manual", {
      method: "DELETE",
      body: {},
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.already_deleted, true);
    assert.equal(response.body.deleted_job_id, "manual-delete-archived");
    assert.equal(response.body.job_id, "manual-delete-archived");
    assert.equal(response.body.released_assignment_count, 0);
    assert.equal(mockSupabase.store.jobs[0].archived_at, archivedAt);
    assert.equal(mockSupabase.store.job_transaction_assignments.length, 0);
    assert.equal(response.body.jobs.some((job) => job.id === "manual-delete-archived"), false);
  });

  test("manual job deletion releases assigned transactions back to the posted feed", async () => {
    mockSupabase.store.jobs = [
      { id: "manual-delete-blocked", business_id: BUSINESS_ID, job_name: "Manual Job", creation_method: "manual", source_type: "manual", status: "active" },
    ];
    mockSupabase.store.job_transaction_assignments = [
      { id: "assignment-manual", business_id: BUSINESS_ID, job_id: "manual-delete-blocked", transaction_id: TXN_ID },
    ];
    mockSupabase.store.bookkeeping_rpc_rows = [
      makeRpcPostedRow({ id: TXN_ID, qboId: "qbo-1", assigned: true }),
    ];

    const response = await request(app, "/api/job-costing/jobs/manual-delete-blocked/manual", {
      method: "DELETE",
      body: {},
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.released_assignment_count, 1);
    assert.equal(mockSupabase.store.job_transaction_assignments.length, 0);
    assert.equal(mockSupabase.store.jobs[0].status, "archived");
    assert.equal(response.body.transactions.some((txn) => txn.id === TXN_ID), true);
  });

  test("manual job deletion resolves stale external identifiers to the local job id", async () => {
    mockSupabase.store.jobs = [
      {
        id: "manual-delete-local-id",
        external_id: "external-delete-id",
        business_id: BUSINESS_ID,
        job_name: "Manual Job",
        creation_method: "manual",
        source_type: "manual",
        status: "active",
      },
    ];
    mockSupabase.store.job_transaction_assignments = [
      { id: "assignment-manual-external", business_id: BUSINESS_ID, job_id: "manual-delete-local-id", transaction_id: TXN_ID },
    ];

    const response = await request(app, "/api/job-costing/jobs/external-delete-id/manual", {
      method: "DELETE",
      body: {},
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.deleted_job_id, "manual-delete-local-id");
    assert.equal(mockSupabase.store.job_transaction_assignments.length, 0);
    assert.equal(mockSupabase.store.jobs[0].status, "archived");
  });

  test("non-manual jobs cannot be deleted through the manual delete route", async () => {
    mockSupabase.store.jobs = [
      { id: "qbo-job-1", business_id: BUSINESS_ID, job_name: "QBO Job", creation_method: "qbo_project", source_type: "quickbooks", status: "active" },
    ];

    const response = await request(app, "/api/job-costing/jobs/qbo-job-1/manual", {
      method: "DELETE",
      body: {},
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, "job_delete_not_supported");
    assert.equal(mockSupabase.store.jobs[0].status, "active");
    assert.equal(mockSupabase.store.jobs[0].archived_at, undefined);
  });

  test("jobs summary excludes archived jobs from active and completed counts", async () => {
    mockSupabase.store.jobs = [
      { id: "active-job", business_id: BUSINESS_ID, job_name: "Active", status: "active", source_type: "manual", creation_method: "manual" },
      { id: "completed-job", business_id: BUSINESS_ID, job_name: "Completed", status: "completed", source_type: "manual", creation_method: "manual" },
      { id: "archived-at-job", business_id: BUSINESS_ID, job_name: "Archived At", status: "active", archived_at: "2026-09-03T12:00:00.000Z", source_type: "manual", creation_method: "manual" },
      { id: "archived-status-job", business_id: BUSINESS_ID, job_name: "Archived Status", status: " ARCHIVED ", source_type: "manual", creation_method: "manual" },
    ];

    const response = await request(app, "/api/job-costing/jobs/summary", { method: "GET" });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.jobs.map((job) => job.id).sort(), ["active-job", "completed-job"]);
    assert.equal(response.body.jobs.filter((job) => String(job.status || "").toLowerCase() !== "completed").length, 1);
    assert.equal(response.body.jobs.filter((job) => String(job.status || "").toLowerCase() === "completed").length, 1);
    assert.equal(response.body.jobs.some((job) => String(job.status || "").trim().toLowerCase() === "archived"), false);
  });

  test("job costing loads every posted Books page and does not depend on Change Order tables", async () => {
    mockSupabase.store.jobs = [
      { id: JOB_ID, business_id: BUSINESS_ID, job_name: "Kitchen Remodel", status: "active", source_type: "bizzi" },
      { id: "archived-job", business_id: BUSINESS_ID, job_name: "Archived", status: "archived", archived_at: "2026-09-03T12:00:00.000Z" },
    ];
    mockSupabase.store.__tableErrors = {
      job_change_orders: { code: "42703", message: "column job_change_orders.title does not exist" },
    };
    mockSupabase.store.bookkeeping_rpc_rows = Array.from({ length: 204 }, (_, index) => makeRpcPostedRow({
      id: `posted-${String(index + 1).padStart(3, "0")}`,
      qboId: `qbo-${index + 1}`,
      date: `2026-08-${String((index % 28) + 1).padStart(2, "0")}`,
    }));
    mockSupabase.store.bookkeeping_rpc_rows.push(makeRpcPostedRow({
      id: "not-posted",
      qboId: null,
      date: "2026-08-31",
    }));

    const response = await request(app, "/api/job-costing/job-costing", { method: "GET" });

    assert.equal(response.status, 200);
    assert.equal(response.body.transactions.length, 204);
    assert.equal(new Set(response.body.transactions.map((row) => row.id)).size, 204);
    assert.equal(response.body.transactions.some((row) => row.id === "not-posted"), false);
    assert.equal(response.body.pagination.total_posted_transactions, 204);
    assert.equal(response.body.pagination.loaded_posted_transactions, 204);
    assert.equal(response.body.jobs.length, 1);
    assert.equal(response.body.jobs[0].id, JOB_ID);
    assert.equal(response.body.jobs[0].job_id, JOB_ID);
    assert.equal(response.body.jobs[0].local_job_id, JOB_ID);
    assert.equal(response.body.jobs[0].is_manual_job, true);
    assert.equal(response.body.jobs[0].can_delete_manual_job, true);
    assert.equal(response.body.jobs[0].revenue_source_status, "manual_no_revenue_source");
    assert.equal(response.body.jobs[0].change_order_count, 0);
  });

  test("job candidates endpoint returns the real bounded total for suggested jobs", async () => {
    mockSupabase.store.job_candidates = Array.from({ length: 102 }, (_, index) => ({
      id: `candidate-${index + 1}`,
      business_id: BUSINESS_ID,
      candidate_status: "pending",
      suggested_job_name: `Invoice job ${index + 1}`,
      source_entity_type: "invoice",
      confidence_score: 80,
      updated_at: `2026-09-02T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
    }));

    const response = await request(app, "/api/job-costing/job-candidates?limit=250", { method: "GET" });

    assert.equal(response.status, 200);
    assert.equal(response.body.candidates.length, 102);
    assert.equal(response.body.total_count, 102);
    assert.equal(response.body.loaded_count, 102);
  });

  test("Projects capability page-load route reads stored state without a QBO capability check", async () => {
    mockSupabase.store.qbo_projects_capabilities = [
      {
        id: "capability-1",
        business_id: BUSINESS_ID,
        realm_id: "realm-1",
        qbo_env: "production",
        status: "scope_not_authorized",
        project_scope_present: false,
        projects_enabled_preference: false,
        source_of_truth: "manual_link_only",
        auto_import_enabled: false,
        checked_at: "2026-09-02T12:00:00.000Z",
      },
      {
        id: "capability-other",
        business_id: OTHER_BUSINESS_ID,
        realm_id: "realm-other",
        qbo_env: "production",
        status: "available_and_enabled",
        checked_at: "2026-09-02T12:00:00.000Z",
      },
    ];

    const response = await request(app, "/api/job-costing/qbo/projects/capability", { method: "GET" });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.capability.status, "scope_not_authorized");
    assert.equal(response.body.capability.business_id, BUSINESS_ID);
    assert.equal(response.body.capability.auto_import_enabled, false);
  });
});
