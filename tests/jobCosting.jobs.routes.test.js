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
  }

  select() {
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
    if (Number.isFinite(this.limitCount)) selected = selected.slice(0, this.limitCount);
    return { data: selected, error: null };
  }
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
    __id: 1,
    ...clone(initial),
  };
  return {
    store,
    from(table) {
      if (!store[table]) store[table] = [];
      return new SupabaseQuery(store, table);
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
  let originalConsoleError;

  beforeEach(() => {
    originalFrom = supabase.from;
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
    app = createApp();
  });

  afterEach(() => {
    supabase.from = originalFrom;
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
});
