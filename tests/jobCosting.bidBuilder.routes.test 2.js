import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Readable, Writable } from "node:stream";
import { Buffer } from "node:buffer";
import express from "express";

globalThis.process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
globalThis.process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const routeModule = await import("../src/api/jobCosting/routes/jobCosting.bidBuilder.routes.js");
const bidBuilderRouter = routeModule.default;
const { __setBidBuilderRouteTestDeps } = routeModule;

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const BID_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
    this.selectColumns = "*";
  }

  select(columns = "*") {
    this.selectColumns = columns || "*";
    return this;
  }

  eq(field, value) {
    this.filters.push((row) => String(row[field]) === String(value));
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

  _schemaErrorIfNeeded() {
    const schema = this.store.__schemas?.[this.table];
    if (!schema || this.selectColumns === "*") return null;
    const requested = String(this.selectColumns).split(",").map((column) => column.trim()).filter(Boolean);
    const missing = requested.find((column) => !schema.includes(column));
    if (!missing) return null;
    return {
      code: "42703",
      message: `column ${missing} of relation ${this.table} does not exist`,
    };
  }

  async _execute() {
    const schemaError = this.operation === "select" ? this._schemaErrorIfNeeded() : null;
    if (schemaError) return { data: null, error: schemaError };

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

    if (this.operation === "delete") {
      const deleted = [];
      const kept = [];
      for (const row of rows) {
        if (this.filters.every((filter) => filter(row))) deleted.push(clone(row));
        else kept.push(row);
      }
      this.store[this.table] = kept;
      return { data: deleted, error: null };
    }

    let selected = rows.filter((row) => this.filters.every((filter) => filter(row))).map(clone);
    if (Number.isFinite(this.limitCount)) selected = selected.slice(0, this.limitCount);
    return { data: selected, error: null };
  }
}

function createSupabaseMock(initial = {}) {
  const store = {
    bid_estimates: [],
    bid_estimate_line_items: [],
    bid_outcomes: [],
    bid_attachments: [],
    jobs: [],
    __id: 1,
    __uploads: [],
    __removed: [],
    __schemas: {
      jobs: ["id", "business_id", "job_name", "customer_name", "trade_type", "status", "target_margin_percent", "estimated_revenue", "estimated_cost", "source", "created_at", "updated_at"],
    },
    ...clone(initial),
  };
  const storage = {
    from(bucket) {
      return {
        async upload(path, data, options) {
          store.__uploads.push({ bucket, path, bytes: data?.length || 0, options });
          return { data: { path }, error: null };
        },
        async createSignedUrl(path, expiresIn) {
          return { data: { signedUrl: `https://storage.test/object/sign/${bucket}/${path}?exp=${expiresIn}` }, error: null };
        },
        async remove(paths) {
          store.__removed.push({ bucket, paths });
          return { data: paths, error: null };
        },
      };
    },
  };
  return {
    store,
    client: {
      storage,
      from(table) {
        if (!store[table]) store[table] = [];
        return new SupabaseQuery(store, table);
      },
    },
  };
}

function testGeneratedEstimate(businessId = BUSINESS_ID) {
  return {
    estimate: {
      business_id: businessId,
      bid_title: "Porch rebuild",
      customer_name: "Avery Smith",
      prospect_name: null,
      scope_description: "Rebuild front porch",
      status: "draft",
      estimated_labor_cost: 1000,
      estimated_material_cost: 1400,
      estimated_subcontractor_cost: 300,
      estimated_permit_cost: 100,
      estimated_other_cost: 200,
      estimated_total_cost: 3000,
      recommended_price: 5000,
      projected_gross_margin: 2000,
      projected_margin_percent: 40,
      deposit_amount: 1500,
      payment_schedule: [{ label: "Deposit", percent: 30, amount: 1500 }],
      risk_flags: [],
      historical_basis: { similar_record_count: 2 },
      proposal_text: "Based on the described scope, Bizzi recommends a project price of $5,000.",
    },
    line_items: [
      { category: "labor", name: "Estimated labor", quantity: 1, unit_cost: 1000, total_cost: 1000 },
      { category: "materials", name: "Estimated materials", quantity: 1, unit_cost: 1400, total_cost: 1400 },
    ],
  };
}

function createApp(mockSupabase) {
  __setBidBuilderRouteTestDeps({
    supabaseClient: mockSupabase.client,
    authMiddleware: (req, _res, next) => {
      req.user = { id: "user-1" };
      next();
    },
    generateBidEstimate: async ({ businessId }) => testGeneratedEstimate(businessId),
  });
  const app = express();
  app.use(express.json());
  app.use("/api/job-costing", bidBuilderRouter);
  return app;
}

async function request(app, path, { method = "GET", body, businessId = BUSINESS_ID, files, includeBusinessHeader = true } = {}) {
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
  };
  if (includeBusinessHeader && businessId) req.headers["x-business-id"] = businessId;
  req.files = files;

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

describe("job costing bid builder routes", () => {
  let mockSupabase;
  let app;
  let originalConsoleError;
  let originalConsoleWarn;

  beforeEach(() => {
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;
    console.error = () => {};
    console.warn = () => {};
    mockSupabase = createSupabaseMock();
    app = createApp(mockSupabase);
  });

  afterEach(() => {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    __setBidBuilderRouteTestDeps();
  });

  test("rejects requests without business_id", async () => {
    const response = await request(app, "/api/job-costing/bids", { includeBusinessHeader: false });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "business_id_required");
  });

  test("validates scope_description when generating a bid", async () => {
    const response = await request(app, "/api/job-costing/bids/generate", {
      method: "POST",
      body: { bid_title: "Missing scope" },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "scope_description_required");
  });

  test("generates and lists bids only within the current business", async () => {
    const created = await request(app, "/api/job-costing/bids/generate", {
      method: "POST",
      body: { bid_title: "Porch rebuild", scope_description: "Rebuild front porch" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.bid.business_id, BUSINESS_ID);
    assert.equal(mockSupabase.store.bid_estimate_line_items.length, 2);

    mockSupabase.store.bid_estimates.push({
      id: "other-bid",
      business_id: OTHER_BUSINESS_ID,
      bid_title: "Other business bid",
      status: "draft",
    });

    const list = await request(app, "/api/job-costing/bids");
    assert.equal(list.status, 200);
    assert.equal(list.body.bids.length, 1);
    assert.equal(list.body.bids[0].business_id, BUSINESS_ID);
  });

  test("rejects cross-business bid detail, update, outcome, conversion, and attachment access", async () => {
    mockSupabase.store.bid_estimates.push({
      id: BID_ID,
      business_id: OTHER_BUSINESS_ID,
      bid_title: "Other business bid",
      scope_description: "Private scope",
      status: "draft",
    });
    mockSupabase.store.bid_estimate_line_items.push({
      id: "other-line",
      business_id: OTHER_BUSINESS_ID,
      bid_estimate_id: BID_ID,
      category: "labor",
      name: "Labor",
      total_cost: 100,
    });
    mockSupabase.store.bid_attachments.push({
      id: "other-attachment",
      business_id: OTHER_BUSINESS_ID,
      bid_estimate_id: BID_ID,
      file_url: "other/path.jpg",
    });

    const detail = await request(app, `/api/job-costing/bids/${BID_ID}`);
    assert.equal(detail.status, 404);
    assert.equal(detail.body.error, "bid_not_found");

    const update = await request(app, `/api/job-costing/bids/${BID_ID}`, {
      method: "PATCH",
      body: { bid_title: "Leaked update" },
    });
    assert.equal(update.status, 404);
    assert.equal(mockSupabase.store.bid_estimates[0].bid_title, "Other business bid");

    const outcome = await request(app, `/api/job-costing/bids/${BID_ID}/outcome`, {
      method: "POST",
      body: { outcome: "won", won_amount: 1000 },
    });
    assert.equal(outcome.status, 404);
    assert.equal(mockSupabase.store.bid_outcomes.length, 0);

    const convert = await request(app, `/api/job-costing/bids/${BID_ID}/convert-to-job`, { method: "POST" });
    assert.equal(convert.status, 404);
    assert.equal(mockSupabase.store.jobs.length, 0);

    const attachmentList = await request(app, `/api/job-costing/bids/${BID_ID}/attachments`);
    assert.equal(attachmentList.status, 404);

    const attachmentDelete = await request(app, "/api/job-costing/bid-attachments/other-attachment", {
      method: "DELETE",
    });
    assert.equal(attachmentDelete.status, 404);
    assert.equal(mockSupabase.store.bid_attachments.length, 1);
  });

  test("patches line items and recalculates pricing", async () => {
    mockSupabase.store.bid_estimates.push({
      id: BID_ID,
      business_id: BUSINESS_ID,
      bid_title: "Porch rebuild",
      desired_margin_percent: 40,
      estimated_total_cost: 1000,
      recommended_price: 1666.67,
      status: "draft",
    });
    mockSupabase.store.bid_estimate_line_items.push({
      id: "line-1",
      business_id: BUSINESS_ID,
      bid_estimate_id: BID_ID,
      category: "labor",
      name: "Labor",
      quantity: 1,
      unit_cost: 1000,
      total_cost: 1000,
    });

    const response = await request(app, `/api/job-costing/bids/${BID_ID}`, {
      method: "PATCH",
      body: {
        recalculate: true,
        line_items: [{ id: "line-1", category: "labor", name: "Labor", quantity: 2, unit_cost: 1000 }],
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.bid.estimated_total_cost, 2000);
    assert.equal(response.body.bid.recommended_price, 3333.33);
    assert.equal(response.body.bid.line_items[0].total_cost, 2000);
  });

  test("stores won/lost outcomes and updates bid status", async () => {
    mockSupabase.store.bid_estimates.push({ id: BID_ID, business_id: BUSINESS_ID, bid_title: "Porch rebuild", status: "draft" });

    const response = await request(app, `/api/job-costing/bids/${BID_ID}/outcome`, {
      method: "POST",
      body: { outcome: "won", won_amount: 5200 },
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.outcome.outcome, "won");
    assert.equal(response.body.bid.status, "won");
    assert.equal(mockSupabase.store.bid_outcomes[0].won_amount, 5200);
  });

  test("converts to a job with inspected columns and returns existing conversion idempotently", async () => {
    mockSupabase.store.bid_estimates.push({
      id: BID_ID,
      business_id: BUSINESS_ID,
      bid_title: "Porch rebuild",
      customer_name: "Avery Smith",
      trade_type: "Carpentry",
      desired_margin_percent: 35,
      estimated_total_cost: 3000,
      recommended_price: 4615.38,
      status: "won",
    });

    const created = await request(app, `/api/job-costing/bids/${BID_ID}/convert-to-job`, { method: "POST" });
    assert.equal(created.status, 201);
    assert.equal(created.body.job.job_name, "Porch rebuild");
    assert.equal(created.body.job.title, undefined);
    assert.equal(created.body.removed_job_columns.includes("name"), true);
    assert.equal(created.body.bid.status, "converted");

    const again = await request(app, `/api/job-costing/bids/${BID_ID}/convert-to-job`, { method: "POST" });
    assert.equal(again.status, 200);
    assert.equal(again.body.already_converted, true);
    assert.equal(again.body.job.id, created.body.job.id);
    assert.equal(mockSupabase.store.jobs.length, 1);
  });

  test("creates metadata and uploaded file attachments, then deletes storage by exact path", async () => {
    mockSupabase.store.bid_estimates.push({ id: BID_ID, business_id: BUSINESS_ID, bid_title: "Porch rebuild", status: "draft" });

    const metadata = await request(app, `/api/job-costing/bids/${BID_ID}/attachments`, {
      method: "POST",
      body: {
        file_url: "https://cdn.test/photo.jpg",
        storage_bucket: "external-bucket",
        storage_path: "external/path/photo.jpg",
        file_name: "photo.jpg",
        mime_type: "image/jpeg",
        notes: "Front elevation",
      },
    });
    assert.equal(metadata.status, 201);
    assert.equal(metadata.body.attachment.storage_path, "external/path/photo.jpg");
    assert.equal(metadata.body.attachment.signed_url, undefined);

    const uploaded = await request(app, `/api/job-costing/bids/${BID_ID}/attachments`, {
      method: "POST",
      body: { notes: "Uploaded from site" },
      files: {
        file: {
          name: "Site Photo.jpg",
          mimetype: "image/jpeg",
          data: Buffer.from("image-bytes"),
        },
      },
    });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.body.attachment.storage_bucket, "bid-attachments");
    assert.equal(uploaded.body.attachment.storage_path.includes(`${BUSINESS_ID}/${BID_ID}/`), true);
    assert.equal(uploaded.body.attachment.file_url, null);
    assert.match(uploaded.body.attachment.signed_url, /^https:\/\/storage\.test\/object\/sign\/bid-attachments\//);
    assert.doesNotMatch(uploaded.body.attachment.signed_url, /\/object\/public\//);
    assert.equal(mockSupabase.store.__uploads.length, 1);

    const list = await request(app, `/api/job-costing/bids/${BID_ID}/attachments`);
    assert.equal(list.status, 200);
    assert.equal(list.body.attachments.length, 2);

    const deleted = await request(app, `/api/job-costing/bid-attachments/${uploaded.body.attachment.id}`, {
      method: "DELETE",
    });
    assert.equal(deleted.status, 200);
    assert.equal(mockSupabase.store.__removed[0].bucket, "bid-attachments");
    assert.deepEqual(mockSupabase.store.__removed[0].paths, [uploaded.body.attachment.storage_path]);
  });
});
