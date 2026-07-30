import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Readable, Writable } from "node:stream";
import express from "express";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const routeModule = await import("../src/api/jobCosting/routes/jobCosting.changeOrders.routes.js");
const changeOrdersRouter = routeModule.default;
const { __setChangeOrderRouteTestDeps } = routeModule;

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_JOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
    this.operation = "insert";
    this.payload = Array.isArray(payload) ? payload : [payload];
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

    if (this.operation === "update") {
      const updated = [];
      for (const row of rows) {
        if (this.filters.every((filter) => filter(row))) {
          Object.assign(row, clone(this.payload));
          updated.push(clone(row));
        }
      }
      return { data: updated, error: null };
    }

    let selected = rows.filter((row) => this.filters.every((filter) => filter(row))).map(clone);
    if (Number.isFinite(this.limitCount)) selected = selected.slice(0, this.limitCount);
    return { data: selected, error: null };
  }
}

function createSupabaseMock(initial = {}) {
  const store = {
    jobs: [],
    job_change_orders: [],
    job_change_order_activity: [],
    potential_change_orders: [],
    business_profiles: [],
    __id: 1,
    ...clone(initial),
  };
  return {
    store,
    client: {
      from(table) {
        if (!store[table]) store[table] = [];
        return new SupabaseQuery(store, table);
      },
    },
  };
}

function createApp(mockSupabase, detector = async () => ({ created: [] })) {
  __setChangeOrderRouteTestDeps({
    supabaseClient: mockSupabase.client,
    authMiddleware: (req, _res, next) => {
      req.user = { id: "user-1", business_id: req.get("x-business-id") || BUSINESS_ID };
      next();
    },
    recommendPrice: async ({ estimatedCost, targetMarginPercent }) => {
      const margin = Number.isFinite(Number(targetMarginPercent)) && Number(targetMarginPercent) > 0
        ? Number(targetMarginPercent)
        : 35;
      const recommended = Number(estimatedCost || 0) > 0 ? Math.round((Number(estimatedCost) / (1 - margin / 100)) * 100) / 100 : 0;
      return {
        estimated_cost: Number(estimatedCost || 0),
        target_margin_percent: margin,
        recommended_price: recommended,
        gross_margin_amount: recommended - Number(estimatedCost || 0),
        markup_percent: 0,
        basis: targetMarginPercent ? "explicit_target" : "fallback",
        explanation: "Test pricing.",
      };
    },
    buildDraft: ({ job, changeOrder }) => ({
      draft_client_message: `Draft for ${job.job_name}: ${changeOrder.description}`,
      draft_scope_summary: `Additional work requested: ${changeOrder.description}`,
      internal_summary: "Internal test summary.",
    }),
    detectPotential: detector,
  });
  const app = express();
  app.use(express.json());
  app.use("/api/job-costing", changeOrdersRouter);
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

describe("job costing change order routes", () => {
  let mockSupabase;
  let app;
  let originalConsoleError;

  beforeEach(() => {
    originalConsoleError = console.error;
    console.error = () => {};
    mockSupabase = createSupabaseMock({
      jobs: [
        { id: JOB_ID, business_id: BUSINESS_ID, job_name: "Kitchen Remodel", customer_name: "Avery Smith", trade_type: "Remodel" },
        { id: OTHER_JOB_ID, business_id: OTHER_BUSINESS_ID, job_name: "Other Job", customer_name: "Other Customer" },
      ],
    });
    app = createApp(mockSupabase);
  });

  afterEach(() => {
    console.error = originalConsoleError;
    __setChangeOrderRouteTestDeps();
  });

  test("creates a change order, auto-prices when proposed price is blank, and writes activity", async () => {
    const response = await request(app, `/api/job-costing/jobs/${JOB_ID}/change-orders`, {
      method: "POST",
      body: {
        title: "Extra tile",
        description: "Add backsplash tile",
        estimated_cost: 2600,
      },
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.change_order.status, "proposed");
    assert.equal(response.body.change_order.proposed_price, 4000);
    assert.equal(response.body.change_order.recommendation_reason.basis, "fallback");
    assert.equal(response.body.change_order.draft_client_message, "Draft for Kitchen Remodel: Add backsplash tile");
    assert.equal(mockSupabase.store.job_change_order_activity.length, 1);
    assert.equal(mockSupabase.store.job_change_order_activity[0].activity_type, "created");
  });

  test("rejects creating a change order for a job outside the business", async () => {
    const response = await request(app, `/api/job-costing/jobs/${OTHER_JOB_ID}/change-orders`, {
      method: "POST",
      body: {
        title: "Bad scope",
        description: "Wrong business",
        estimated_cost: 100,
      },
    });

    assert.equal(response.status, 404);
    assert.equal(response.body.error, "job_not_found");
    assert.equal(mockSupabase.store.job_change_orders.length, 0);
  });

  test("scopes change order list, update, and cancel by business_id", async () => {
    mockSupabase.store.job_change_orders.push(
      {
        id: "own-order",
        business_id: BUSINESS_ID,
        job_id: JOB_ID,
        title: "Own order",
        description: "Visible",
        status: "proposed",
        estimated_cost: 100,
        proposed_price: 200,
      },
      {
        id: "other-order",
        business_id: OTHER_BUSINESS_ID,
        job_id: OTHER_JOB_ID,
        title: "Other order",
        description: "Hidden",
        status: "proposed",
        estimated_cost: 300,
        proposed_price: 600,
      }
    );

    const list = await request(app, "/api/job-costing/change-orders");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.change_orders.map((row) => row.id), ["own-order"]);

    const update = await request(app, "/api/job-costing/change-orders/other-order", {
      method: "PATCH",
      body: { title: "Cross-business edit" },
    });
    assert.equal(update.status, 404);
    assert.equal(update.body.error, "change_order_not_found");
    assert.equal(mockSupabase.store.job_change_orders.find((row) => row.id === "other-order").title, "Other order");

    const cancel = await request(app, "/api/job-costing/change-orders/other-order", {
      method: "DELETE",
    });
    assert.equal(cancel.status, 404);
    assert.equal(mockSupabase.store.job_change_orders.find((row) => row.id === "other-order").status, "proposed");
  });

  test("scopes potential change order list, dismiss, and convert by business_id", async () => {
    mockSupabase.store.potential_change_orders.push(
      {
        id: "own-potential",
        business_id: BUSINESS_ID,
        job_id: JOB_ID,
        trigger_type: "material_cost_spike",
        confidence_score: 82,
        title: "Own potential",
        explanation: "Visible",
        estimated_extra_cost: 100,
        suggested_price: 154,
        status: "pending",
      },
      {
        id: "other-potential",
        business_id: OTHER_BUSINESS_ID,
        job_id: OTHER_JOB_ID,
        trigger_type: "material_cost_spike",
        confidence_score: 90,
        title: "Other potential",
        explanation: "Hidden",
        estimated_extra_cost: 200,
        suggested_price: 308,
        status: "pending",
      }
    );

    const list = await request(app, "/api/job-costing/potential-change-orders");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.potential_change_orders.map((row) => row.id), ["own-potential"]);

    const dismiss = await request(app, "/api/job-costing/potential-change-orders/other-potential/dismiss", {
      method: "POST",
    });
    assert.equal(dismiss.status, 404);
    assert.equal(mockSupabase.store.potential_change_orders.find((row) => row.id === "other-potential").status, "pending");

    const convert = await request(app, "/api/job-costing/potential-change-orders/other-potential/convert", {
      method: "POST",
    });
    assert.equal(convert.status, 404);
    assert.equal(mockSupabase.store.job_change_orders.some((row) => row.source === "potential_detector"), false);
  });

  test("validates lifecycle transitions and writes history for approve, bill, pay, and cancel", async () => {
    const created = await request(app, `/api/job-costing/jobs/${JOB_ID}/change-orders`, {
      method: "POST",
      body: {
        title: "Extra framing",
        description: "Frame new opening",
        estimated_cost: 500,
        proposed_price: 1000,
      },
    });
    const id = created.body.change_order.id;

    const invalid = await request(app, `/api/job-costing/change-orders/${id}`, {
      method: "PATCH",
      body: { status: "paid" },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "invalid_status_transition");

    const approved = await request(app, `/api/job-costing/change-orders/${id}`, {
      method: "PATCH",
      body: { status: "client_approved", approved_price: 1000 },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.change_order.status, "client_approved");

    const billed = await request(app, `/api/job-costing/change-orders/${id}`, {
      method: "PATCH",
      body: { status: "billed", billed_amount: 1000 },
    });
    assert.equal(billed.status, 200);
    assert.equal(billed.body.change_order.status, "billed");

    const paid = await request(app, `/api/job-costing/change-orders/${id}`, {
      method: "PATCH",
      body: { status: "paid", paid_amount: 1000 },
    });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.change_order.status, "paid");

    const cancellable = await request(app, `/api/job-costing/jobs/${JOB_ID}/change-orders`, {
      method: "POST",
      body: {
        title: "Cancelled work",
        description: "Do not proceed",
        estimated_cost: 100,
      },
    });
    const cancelled = await request(app, `/api/job-costing/change-orders/${cancellable.body.change_order.id}`, {
      method: "DELETE",
      body: {},
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.change_order.status, "cancelled");

    const statusHistory = mockSupabase.store.job_change_order_activity.filter((row) => row.activity_type === "status_changed");
    assert.equal(statusHistory.length, 4);
  });

  test("preserves edited draft messages during pricing and description updates", async () => {
    const created = await request(app, `/api/job-costing/jobs/${JOB_ID}/change-orders`, {
      method: "POST",
      body: {
        title: "Extra demo",
        description: "Demo plaster",
        estimated_cost: 100,
      },
    });
    const id = created.body.change_order.id;

    const edited = await request(app, `/api/job-costing/change-orders/${id}`, {
      method: "PATCH",
      body: { draft_client_message: "Custom client wording" },
    });
    assert.equal(edited.body.change_order.draft_client_message_edited, true);

    const repriced = await request(app, `/api/job-costing/change-orders/${id}`, {
      method: "PATCH",
      body: { estimated_cost: 200, description: "Demo plaster and lathe" },
    });
    assert.equal(repriced.body.change_order.draft_client_message, "Custom client wording");
    assert.equal(repriced.body.change_order.draft_client_message_edited, true);
  });

  test("runs potential change order detection on demand", async () => {
    const detectorApp = createApp(mockSupabase, async () => ({
      created: [{
        id: "potential-1",
        business_id: BUSINESS_ID,
        job_id: JOB_ID,
        trigger_type: "material_cost_spike",
        confidence_score: 80,
        title: "Material spike",
        explanation: "Materials are high.",
        estimated_extra_cost: 500,
        suggested_price: 769.23,
        status: "pending",
      }],
    }));

    const response = await request(detectorApp, "/api/job-costing/potential-change-orders/detect", {
      method: "POST",
      body: {},
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.created_count, 1);
    assert.equal(response.body.potential_change_orders[0].job_name, "Kitchen Remodel");
  });
});
