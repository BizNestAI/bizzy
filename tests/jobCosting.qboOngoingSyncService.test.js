import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, test } from "node:test";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
process.env.QB_PROD_CLIENT_ID ||= "test-client-id";
process.env.QB_PROD_CLIENT_SECRET ||= "test-client-secret";
process.env.QB_PROD_REDIRECT_URI ||= "http://localhost/qbo/callback";

const {
  buildWebhookEventHash,
  parseQuickBooksWebhookPayload,
  processQboWebhookEvent,
  processQueuedQboWebhookEvents,
  runDailyQboJobCostingReconciliation,
  runQboCdcForBusiness,
  runQboJobCostingBackfill,
  storeQuickBooksWebhookEvents,
  verifyQuickBooksWebhookSignature,
} = await import("../src/services/jobCosting/qboOngoingSyncService.js");

function createFakeDb(seed = {}) {
  const tables = {
    business_profiles: [{ id: "business-1", user_id: "user-1", job_costing_revenue_basis: "invoiced" }],
    quickbooks_tokens: [{ id: "token-1", business_id: "business-1", realm_id: "realm-1", qbo_env: "sandbox", is_active: true, status: "active", created_at: "2026-07-24T00:00:00.000Z" }],
    business_billing: [{ business_id: "business-1", subscription_status_test: "active" }],
    qbo_webhook_events: [],
    qbo_cdc_cursors: [],
    qbo_job_costing_daily_sync_state: [],
    qbo_job_costing_backfill_runs: [],
    qbo_entity_sync_runs: [],
    customers: [],
    qbo_customers: [],
    customer_external_links: [],
    job_external_links: [],
    job_revenue_documents: [],
    job_payment_records: [],
    job_payment_allocations: [],
    job_candidates: [],
    jobs: [],
    qbo_projects_capabilities: [],
    qbo_projects: [],
    ...seed,
  };

  const matches = (row, state) => {
    for (const [key, value] of state.filters) if (row[key] !== value) return false;
    for (const [key, values] of state.inFilters) if (!values.includes(row[key])) return false;
    for (const [key, value] of state.gtFilters) if (!(String(row[key] || "") > String(value || ""))) return false;
    for (const [key, value] of state.notFilters) if (value === null && row[key] === null) return false;
    for (const clause of state.orClauses) {
      const ok = clause.split(",").some((part) => {
        const [key, op, value] = part.split(".");
        if (op === "is" && value === "null") return row[key] == null;
        if (op === "lte") return row[key] == null || String(row[key]) <= String(value);
        return false;
      });
      if (!ok) return false;
    }
    return true;
  };

  const conflictKeys = (table, payload, onConflict) => {
    if (onConflict) return String(onConflict).split(",").map((key) => key.trim());
    if (table === "qbo_webhook_events") return ["event_hash"];
    if (table === "qbo_cdc_cursors") return ["business_id", "realm_id", "qbo_env", "entity_type"];
    if (table === "qbo_job_costing_daily_sync_state") return ["business_id", "realm_id", "qbo_env"];
    if (table === "qbo_job_costing_backfill_runs" && payload?.id) return ["id"];
    if (payload?.id) return ["id"];
    return ["id"];
  };

  const db = {
    tables,
    from(table) {
      if (!tables[table]) tables[table] = [];
      const state = {
        filters: [],
        inFilters: [],
        gtFilters: [],
        notFilters: [],
        orClauses: [],
        orderKey: null,
        ascending: true,
        limitValue: null,
        countOnly: false,
      };
      const applyFilters = () => {
        let rows = tables[table].filter((row) => matches(row, state));
        if (state.orderKey) {
          rows = rows.sort((a, b) => {
            const left = String(a[state.orderKey] || "");
            const right = String(b[state.orderKey] || "");
            return state.ascending ? left.localeCompare(right) : right.localeCompare(left);
          });
        }
        if (state.limitValue !== null) rows = rows.slice(0, state.limitValue);
        return rows;
      };
      const chain = {
        select(_cols, opts = {}) {
          state.countOnly = opts?.count === "exact" && opts?.head;
          return chain;
        },
        eq(key, value) {
          state.filters.push([key, value]);
          return chain;
        },
        in(key, values) {
          state.inFilters.push([key, values]);
          return chain;
        },
        gt(key, value) {
          state.gtFilters.push([key, value]);
          return chain;
        },
        not(key, _op, value) {
          state.notFilters.push([key, value]);
          return chain;
        },
        or(clause) {
          state.orClauses.push(clause);
          return chain;
        },
        order(key, opts = {}) {
          state.orderKey = key;
          state.ascending = opts.ascending !== false;
          return chain;
        },
        limit(value) {
          state.limitValue = value;
          return chain;
        },
        maybeSingle() {
          return Promise.resolve({ data: applyFilters()[0] || null, error: null });
        },
        then(resolve) {
          const rows = applyFilters();
          return resolve(state.countOnly ? { data: null, count: rows.length, error: null } : { data: rows, error: null });
        },
        insert(payload) {
          if (table === "job_candidates" && tables[table].some((row) => ["business_id", "realm_id", "source_system", "source_entity_type", "source_entity_id"].every((key) => row[key] === payload[key]))) {
            return { select: () => ({ maybeSingle: async () => ({ data: null, error: { code: "23505" } }) }) };
          }
          const row = { confirmed_job_id: null, dismissal_reason: null, id: payload.id || `${table}-${tables[table].length + 1}`, ...structuredClone(payload) };
          tables[table].push(row);
          return { select: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) };
        },
        upsert(payload, opts = {}) {
          const rows = Array.isArray(payload) ? payload : [payload];
          let last = null;
          for (const row of rows) {
            const keys = conflictKeys(table, row, opts.onConflict);
            let existing = tables[table].find((candidate) => keys.every((key) => candidate[key] === row[key]));
            if (!existing) {
              existing = { id: row.id || `${table}-${tables[table].length + 1}` };
              tables[table].push(existing);
            }
            Object.assign(existing, row);
            last = existing;
          }
          return {
            select: () => ({ maybeSingle: () => Promise.resolve({ data: last, error: null }) }),
            then: (resolve) => resolve({ data: last, error: null }),
          };
        },
        update(payload) {
          const execute = () => {
            const rows = applyFilters();
            rows.forEach((row) => Object.assign(row, structuredClone(payload)));
            return rows;
          };
          const query = {
            is(key, value) { state.filters.push([key, value]); return query; },
            select() { return query; },
            maybeSingle() { return Promise.resolve({ data: execute()[0] || null, error: null }); },
            eq(key, value) {
              state.filters.push([key, value]);
              return query;
            },
            in(key, values) {
              state.inFilters.push([key, values]);
              return query;
            },
            then(resolve) {
              const rows = applyFilters();
              rows.forEach((row) => Object.assign(row, payload));
              resolve({ data: rows, error: null });
            },
          };
          return query;
        },
        delete() {
          const query = {
            eq(key, value) {
              state.filters.push([key, value]);
              return query;
            },
            then(resolve) {
              const keep = [];
              const deleted = [];
              for (const row of tables[table]) {
                if (matches(row, state)) deleted.push(row);
                else keep.push(row);
              }
              tables[table] = keep;
              resolve({ data: deleted, error: null });
            },
          };
          return query;
        },
      };
      return chain;
    },
  };
  return db;
}

function webhookPayload({ entity = "Invoice", id = "inv-1", operation = "Update", lastUpdated = "2026-07-24T12:00:00.000Z" } = {}) {
  return {
    eventNotifications: [{
      realmId: "realm-1",
      dataChangeEvent: {
        entities: [{ name: entity, id, operation, lastUpdated }],
      },
    }],
  };
}

function qboInvoice(id = "inv-1") {
  return {
    Id: id,
    SyncToken: "0",
    DocNumber: "1001",
    TxnDate: "2026-07-20",
    DueDate: "2026-08-20",
    CustomerRef: { value: "cust-1", name: "Maya Johnson" },
    TotalAmt: 7200,
    Balance: 7200,
    Line: [{ Amount: 7200, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { Qty: 1, UnitPrice: 7200 } }],
    MetaData: { LastUpdatedTime: "2026-07-24T12:00:00.000Z" },
  };
}

function qboPayment(id = "pay-1") {
  return {
    Id: id,
    SyncToken: "0",
    TxnDate: "2026-07-24",
    CustomerRef: { value: "cust-1", name: "Maya Johnson" },
    TotalAmt: 500,
    UnappliedAmt: 0,
    Line: [{ Amount: 500, LinkedTxn: [{ TxnId: "inv-missing", TxnType: "Invoice" }] }],
    MetaData: { LastUpdatedTime: "2026-07-24T13:00:00.000Z" },
  };
}

function qboDeposit(id = "dep-1", paymentId = "pay-1") {
  return {
    Id: id,
    SyncToken: "0",
    TxnDate: "2026-07-25",
    TotalAmt: 500,
    Line: [{ Amount: 500, LinkedTxn: [{ TxnId: paymentId, TxnType: "Payment" }] }],
    MetaData: { LastUpdatedTime: "2026-07-25T13:00:00.000Z" },
  };
}

describe("QBO ongoing job costing sync", () => {
  test("verifies official HMAC-SHA256 webhook signatures", () => {
    const body = Buffer.from(JSON.stringify(webhookPayload()));
    const token = "webhook-token";
    const signature = crypto.createHmac("sha256", token).update(body).digest("base64");
    assert.equal(verifyQuickBooksWebhookSignature({ rawBody: body, signature, verifierToken: token }), true);
    assert.equal(verifyQuickBooksWebhookSignature({ rawBody: body, signature: "bad", verifierToken: token }), false);
  });

  test("parses webhook entity changes with realm isolation", () => {
    const events = parseQuickBooksWebhookPayload(webhookPayload({ entity: "Payment", id: "pay-1" }));
    assert.equal(events.length, 1);
    assert.equal(events[0].realm_id, "realm-1");
    assert.equal(events[0].entity_type, "Payment");
    assert.equal(events[0].operation, "update");
  });

  test("stores duplicate webhook events idempotently", async () => {
    const db = createFakeDb();
    const payload = webhookPayload();
    const first = await storeQuickBooksWebhookEvents({ payload, db });
    const second = await storeQuickBooksWebhookEvents({ payload, db });
    assert.equal(first.queued, 1);
    assert.equal(second.duplicates, 1);
    assert.equal(db.tables.qbo_webhook_events.length, 1);
  });

  test("marks older webhook events as out-of-order when a newer event already exists", async () => {
    const db = createFakeDb();
    await storeQuickBooksWebhookEvents({ payload: webhookPayload({ lastUpdated: "2026-07-24T13:00:00.000Z" }), db });
    const older = await storeQuickBooksWebhookEvents({ payload: webhookPayload({ lastUpdated: "2026-07-24T12:00:00.000Z" }), db });
    assert.equal(older.events[0].out_of_order, true);
    assert.equal(older.events[0].processing_status, "skipped");
  });

  test("imports an invoice event into canonical revenue documents", async () => {
    const db = createFakeDb();
    const stored = await storeQuickBooksWebhookEvents({ payload: webhookPayload(), db });
    const event = db.tables.qbo_webhook_events.find((row) => row.id === stored.events[0].id);
    await processQboWebhookEvent({
      eventRow: event,
      db,
      qboTransport: { fetchEntity: async () => qboInvoice("inv-1") },
      now: new Date("2026-07-24T14:00:00.000Z"),
    });
    assert.equal(db.tables.job_revenue_documents.length, 1);
    assert.equal(db.tables.job_revenue_documents[0].source_document_type, "invoice");
    assert.equal(db.tables.qbo_webhook_events[0].processing_status, "succeeded");
  });

  test("persists payment events before invoices without adding invoiced revenue", async () => {
    const db = createFakeDb();
    const stored = await storeQuickBooksWebhookEvents({ payload: webhookPayload({ entity: "Payment", id: "pay-1" }), db });
    await processQboWebhookEvent({
      eventRow: db.tables.qbo_webhook_events.find((row) => row.id === stored.events[0].id),
      db,
      qboTransport: { fetchEntity: async () => qboPayment("pay-1") },
      now: new Date("2026-07-24T14:00:00.000Z"),
    });
    assert.equal(db.tables.job_payment_records.length, 1);
    assert.equal(db.tables.job_revenue_documents.length, 0);
  });

  test("imports QBO deposits as settlement evidence without duplicating revenue", async () => {
    const db = createFakeDb({
      jobs: [{ id: "job-1", business_id: "business-1", job_name: "Deck" }],
      job_revenue_documents: [{
        id: "doc-1",
        business_id: "business-1",
        realm_id: "realm-1",
        source_system: "quickbooks",
        source_document_type: "invoice",
        external_document_id: "inv-1",
        job_id: "job-1",
        total_amount: 500,
        status: "open",
      }],
      job_payment_records: [{
        id: "payment-row-1",
        business_id: "business-1",
        realm_id: "realm-1",
        source_system: "quickbooks",
        external_payment_id: "pay-1",
      }],
      job_payment_allocations: [{
        id: "alloc-1",
        business_id: "business-1",
        payment_record_id: "payment-row-1",
        revenue_document_id: "doc-1",
        applied_amount: 500,
      }],
    });

    const result = await runQboJobCostingBackfill({
      businessId: "business-1",
      db,
      batchSize: 1000,
      qboTransport: {
        realmId: "realm-1",
        tokenRow: { realm_id: "realm-1" },
        fetchBackfillPage: async ({ entity, startPosition }) => (entity === "Deposit" && startPosition === 1 ? [qboDeposit("dep-1", "pay-1")] : []),
      },
      projectsTransport: { realmId: "realm-1", tokenRow: { realm_id: "realm-1", scope: "com.intuit.quickbooks.accounting" } },
      now: new Date("2026-07-25T14:00:00.000Z"),
    });

    assert.equal(result.ok, true);
    assert.equal(db.tables.job_revenue_evidence.length, 1);
    assert.equal(db.tables.job_revenue_evidence[0].match_type, "deposit_evidence");
    assert.equal(db.tables.job_revenue_evidence[0].status, "confirmed");
    assert.equal(db.tables.job_revenue_documents.length, 1);
    assert.equal(db.tables.job_revenue_documents[0].total_amount, 500);
  });

  test("CDC recovers a missed invoice event", async () => {
    const db = createFakeDb();
    const result = await runQboCdcForBusiness({
      businessId: "business-1",
      db,
      qboTransport: {
        realmId: "realm-1",
        tokenRow: { realm_id: "realm-1" },
        fetchCdc: async () => ({ Invoice: [qboInvoice("inv-cdc")] }),
      },
      now: new Date("2026-07-24T15:00:00.000Z"),
    });
    assert.equal(result.ok, true);
    assert.equal(db.tables.job_revenue_documents[0].external_document_id, "inv-cdc");
    assert.equal(db.tables.qbo_cdc_cursors.length, 7);
  });

  test("CDC advances successful cursor only after entity changes commit", async () => {
    const db = createFakeDb();
    await runQboCdcForBusiness({
      businessId: "business-1",
      db,
      entities: ["Invoice"],
      qboTransport: {
        realmId: "realm-1",
        tokenRow: { realm_id: "realm-1" },
        fetchCdc: async ({ changedSince }) => {
          assert.equal(changedSince, "2026-07-24T14:50:00.000Z");
          return { Invoice: [qboInvoice("inv-cursor")] };
        },
      },
      overlapMinutes: 10,
      now: new Date("2026-07-24T15:00:00.000Z"),
    });

    const cursor = db.tables.qbo_cdc_cursors[0];
    assert.equal(cursor.entity_type, "Invoice");
    assert.equal(cursor.status, "succeeded");
    assert.equal(cursor.last_successful_cursor, "2026-07-24T15:00:00.000Z");
    assert.equal(cursor.processed_count, 1);
  });

  test("partial CDC failure does not advance the failed entity cursor", async () => {
    const db = createFakeDb({
      qbo_cdc_cursors: [{
        id: "cursor-invoice",
        business_id: "business-1",
        realm_id: "realm-1",
        qbo_env: "sandbox",
        entity_type: "Invoice",
        last_successful_cursor: "2026-07-24T10:00:00.000Z",
        last_successful_changed_since: "2026-07-24T10:00:00.000Z",
        overlap_minutes: 10,
      }],
    });
    const result = await runQboCdcForBusiness({
      businessId: "business-1",
      db,
      entities: ["Invoice"],
      qboTransport: {
        realmId: "realm-1",
        tokenRow: { realm_id: "realm-1" },
        fetchCdc: async () => {
          throw new Error("cdc outage");
        },
      },
      now: new Date("2026-07-24T15:00:00.000Z"),
    });

    assert.equal(result.ok, false);
    assert.equal(db.tables.qbo_cdc_cursors[0].status, "failed");
    assert.equal(db.tables.qbo_cdc_cursors[0].last_successful_cursor, "2026-07-24T10:00:00.000Z");
    assert.equal(db.tables.qbo_cdc_cursors[0].retry_count, 1);
  });

  test("CDC overlap catches late updates and keeps separate entity cursors", async () => {
    const db = createFakeDb({
      qbo_cdc_cursors: [
        {
          id: "cursor-invoice",
          business_id: "business-1",
          realm_id: "realm-1",
          qbo_env: "sandbox",
          entity_type: "Invoice",
          last_successful_cursor: "2026-07-24T12:00:00.000Z",
          last_successful_changed_since: "2026-07-24T12:00:00.000Z",
          overlap_minutes: 15,
        },
        {
          id: "cursor-payment",
          business_id: "business-1",
          realm_id: "realm-1",
          qbo_env: "sandbox",
          entity_type: "Payment",
          last_successful_cursor: "2026-07-24T09:00:00.000Z",
          last_successful_changed_since: "2026-07-24T09:00:00.000Z",
          overlap_minutes: 5,
        },
      ],
    });
    const requested = {};
    await runQboCdcForBusiness({
      businessId: "business-1",
      db,
      entities: ["Invoice", "Payment"],
      qboTransport: {
        realmId: "realm-1",
        tokenRow: { realm_id: "realm-1" },
        fetchCdc: async ({ entities, changedSince }) => {
          requested[entities[0]] = changedSince;
          return entities[0] === "Invoice"
            ? { Invoice: [qboInvoice("inv-late")] }
            : { Payment: [qboPayment("pay-late")] };
        },
      },
      now: new Date("2026-07-24T15:00:00.000Z"),
    });

    assert.equal(requested.Invoice, "2026-07-24T11:45:00.000Z");
    assert.equal(requested.Payment, "2026-07-24T08:55:00.000Z");
    assert.equal(db.tables.qbo_cdc_cursors.find((row) => row.entity_type === "Invoice").processed_count, 1);
    assert.equal(db.tables.qbo_cdc_cursors.find((row) => row.entity_type === "Payment").processed_count, 1);
  });

  test("delete webhook voids/removes canonical invoice state", async () => {
    const db = createFakeDb({
      job_revenue_documents: [{
        id: "doc-1",
        business_id: "business-1",
        realm_id: "realm-1",
        source_system: "quickbooks",
        source_document_type: "invoice",
        external_document_id: "inv-1",
        status: "open",
      }],
    });
    const eventRow = {
      id: "event-delete",
      business_id: "business-1",
      realm_id: "realm-1",
      qbo_env: "production",
      entity_type: "Invoice",
      entity_id: "inv-1",
      operation: "delete",
      attempts: 0,
      processing_status: "queued",
    };
    db.tables.qbo_webhook_events.push(eventRow);
    await processQboWebhookEvent({ eventRow, db, now: new Date("2026-07-24T16:00:00.000Z") });
    assert.equal(db.tables.job_revenue_documents[0].status, "deleted");
  });

  test("queued event processor retries failures and later succeeds", async () => {
    const db = createFakeDb();
    const stored = await storeQuickBooksWebhookEvents({ payload: webhookPayload(), db, now: new Date("2026-07-24T16:00:00.000Z") });
    let shouldFail = true;
    const first = await processQueuedQboWebhookEvents({
      db,
      qboTransport: {
        fetchEntity: async () => {
          if (shouldFail) throw new Error("temporary outage");
          return qboInvoice("inv-retry");
        },
      },
      now: new Date("2026-07-24T16:00:00.000Z"),
    });
    assert.equal(first.failed, 1);
    const event = db.tables.qbo_webhook_events.find((row) => row.id === stored.events[0].id);
    event.next_attempt_at = "2026-07-24T16:00:00.000Z";
    shouldFail = false;
    const second = await processQueuedQboWebhookEvents({
      db,
      qboTransport: { fetchEntity: async () => qboInvoice("inv-retry") },
      now: new Date("2026-07-24T17:00:00.000Z"),
    });
    assert.equal(second.succeeded, 1);
    assert.equal(db.tables.job_revenue_documents[0].external_document_id, "inv-retry");
  });

  test("daily reconciliation and backfill are idempotent and do not require Projects availability", async () => {
    const db = createFakeDb();
    const qboTransport = {
      realmId: "realm-1",
      tokenRow: { realm_id: "realm-1" },
      fetchAll: ({ entity }) => (entity === "Invoice" ? [qboInvoice("inv-daily")] : []),
    };
    const daily = await runDailyQboJobCostingReconciliation({
      businessId: "business-1",
      db,
      qboTransport,
      projectsTransport: { realmId: "realm-1", tokenRow: { realm_id: "realm-1", scope: "com.intuit.quickbooks.accounting" } },
      now: new Date("2026-07-24T18:00:00.000Z"),
    });
    const backfill = await runQboJobCostingBackfill({
      businessId: "business-1",
      db,
      startDate: "2025-01-01",
      endDate: "2026-07-24",
      qboTransport,
      projectsTransport: { realmId: "realm-1", tokenRow: { realm_id: "realm-1", scope: "com.intuit.quickbooks.accounting" } },
      now: new Date("2026-07-24T19:00:00.000Z"),
    });

    assert.equal(daily.ok, true);
    assert.equal(backfill.ok, true);
    assert.equal(db.tables.qbo_job_costing_daily_sync_state[0].last_status, "succeeded");
    assert.equal(db.tables.qbo_job_costing_backfill_runs[0].status, "succeeded");
    assert.equal(db.tables.job_revenue_documents.length, 1);
    assert.equal(buildWebhookEventHash(parseQuickBooksWebhookPayload(webhookPayload())[0]).length, 64);
  });

  test("daily reconciliation recovers records after a CDC gap", async () => {
    const db = createFakeDb({
      qbo_cdc_cursors: [{
        id: "cursor-invoice",
        business_id: "business-1",
        realm_id: "realm-1",
        qbo_env: "sandbox",
        entity_type: "Invoice",
        last_successful_cursor: "2026-07-20T00:00:00.000Z",
        status: "failed",
        failure: "cdc outage",
      }],
    });

    const daily = await runDailyQboJobCostingReconciliation({
      businessId: "business-1",
      db,
      qboTransport: {
        realmId: "realm-1",
        tokenRow: { realm_id: "realm-1" },
        fetchAll: ({ entity }) => (entity === "Invoice" ? [qboInvoice("inv-gap")] : []),
      },
      projectsTransport: { realmId: "realm-1", tokenRow: { realm_id: "realm-1", scope: "com.intuit.quickbooks.accounting" } },
      now: new Date("2026-07-24T19:30:00.000Z"),
    });

    assert.equal(daily.ok, true);
    assert.equal(db.tables.job_revenue_documents[0].external_document_id, "inv-gap");
    assert.equal(db.tables.qbo_job_costing_daily_sync_state[0].last_status, "succeeded");
    assert.equal(db.tables.qbo_cdc_cursors[0].status, "failed");
  });

  test("resumable backfill restarts after page failure without duplicate records", async () => {
    const db = createFakeDb();
    let failSecondPage = true;
    const fetchedPages = [];
    const qboTransport = {
      realmId: "realm-1",
      tokenRow: { realm_id: "realm-1" },
      fetchBackfillPage: async ({ entity, startPosition }) => {
        fetchedPages.push(`${entity}:${startPosition}`);
        if (entity !== "Invoice") return [];
        if (startPosition === 1) return [qboInvoice("inv-page-1")];
        if (startPosition === 2 && failSecondPage) throw new Error("page outage");
        if (startPosition === 2) return [qboInvoice("inv-page-2")];
        return [];
      },
    };

    await assert.rejects(
      runQboJobCostingBackfill({
        businessId: "business-1",
        db,
        startDate: "2025-01-01",
        endDate: "2026-07-24",
        batchSize: 1,
        qboTransport,
        projectsTransport: { realmId: "realm-1", tokenRow: { realm_id: "realm-1", scope: "com.intuit.quickbooks.accounting" } },
        now: new Date("2026-07-24T20:00:00.000Z"),
      }),
      /page outage/
    );

    assert.equal(db.tables.qbo_job_costing_backfill_runs[0].status, "failed");
    assert.equal(db.tables.qbo_job_costing_backfill_runs[0].current_entity, "Invoice");
    assert.equal(db.tables.qbo_job_costing_backfill_runs[0].current_start_position, 2);
    assert.equal(db.tables.job_revenue_documents.length, 1);

    failSecondPage = false;
    const resumed = await runQboJobCostingBackfill({
      businessId: "business-1",
      db,
      startDate: "2025-01-01",
      endDate: "2026-07-24",
      batchSize: 1,
      qboTransport,
      projectsTransport: { realmId: "realm-1", tokenRow: { realm_id: "realm-1", scope: "com.intuit.quickbooks.accounting" } },
      now: new Date("2026-07-24T21:00:00.000Z"),
    });

    assert.equal(resumed.ok, true);
    assert.equal(db.tables.qbo_job_costing_backfill_runs[0].status, "succeeded");
    assert.deepEqual(
      db.tables.job_revenue_documents.map((row) => row.external_document_id).sort(),
      ["inv-page-1", "inv-page-2"]
    );
    assert.equal(db.tables.job_revenue_documents.filter((row) => row.external_document_id === "inv-page-1").length, 1);
    assert.ok(fetchedPages.includes("Invoice:2"));
  });

  test("CDC cursors are isolated per realm", async () => {
    const db = createFakeDb({
      business_profiles: [
        { id: "business-1", user_id: "user-1", job_costing_revenue_basis: "invoiced" },
        { id: "business-2", user_id: "user-2", job_costing_revenue_basis: "invoiced" },
      ],
      quickbooks_tokens: [
        { id: "token-1", business_id: "business-1", realm_id: "realm-1", qbo_env: "sandbox", created_at: "2026-07-24T00:00:00.000Z" },
        { id: "token-2", business_id: "business-2", realm_id: "realm-2", qbo_env: "sandbox", created_at: "2026-07-24T00:00:00.000Z" },
      ],
    });
    await runQboCdcForBusiness({
      businessId: "business-1",
      db,
      entities: ["Invoice"],
      qboTransport: {
        realmId: "realm-1",
        tokenRow: { realm_id: "realm-1" },
        fetchCdc: async () => ({ Invoice: [qboInvoice("inv-realm-1")] }),
      },
      now: new Date("2026-07-24T22:00:00.000Z"),
    });
    await runQboCdcForBusiness({
      businessId: "business-2",
      db,
      entities: ["Invoice"],
      qboTransport: {
        realmId: "realm-2",
        tokenRow: { realm_id: "realm-2" },
        fetchCdc: async () => ({ Invoice: [qboInvoice("inv-realm-2")] }),
      },
      now: new Date("2026-07-24T23:00:00.000Z"),
    });

    assert.equal(db.tables.qbo_cdc_cursors.length, 2);
    assert.equal(db.tables.qbo_cdc_cursors.find((row) => row.realm_id === "realm-1").last_successful_cursor, "2026-07-24T22:00:00.000Z");
    assert.equal(db.tables.qbo_cdc_cursors.find((row) => row.realm_id === "realm-2").last_successful_cursor, "2026-07-24T23:00:00.000Z");
    assert.equal(db.tables.job_revenue_documents.find((row) => row.external_document_id === "inv-realm-1").realm_id, "realm-1");
    assert.equal(db.tables.job_revenue_documents.find((row) => row.external_document_id === "inv-realm-2").realm_id, "realm-2");
  });
});

test("empty CDC records compact successful runs and advances checkpoints without candidate or relink writes", async () => {
  const historical = { id: "historical", source_snapshot: { jobCandidates: { candidates: [{ id: "old" }] } } };
  const db = createFakeDb({ qbo_entity_sync_runs: [historical] });
  const writes = [];
  const from = db.from.bind(db);
  db.from = (table) => {
    const query = from(table);
    for (const method of ["insert", "upsert", "update"]) {
      const original = query[method];
      if (original) query[method] = function (...args) { writes.push({ table, method }); return original.apply(this, args); };
    }
    return query;
  };
  const now = new Date("2026-11-11T16:29:00Z");
  const result = await runQboCdcForBusiness({ businessId: "business-1", db, entities: ["Invoice", "Payment"], qboTransport: { realmId: "realm-1", tokenRow: { realm_id: "realm-1" }, fetchCdc: async () => ({ Invoice: [], Payment: [] }) }, now });
  assert.equal(result.ok, true);
  assert.equal(result.jobCandidates.skipped, true);
  assert.equal(writes.filter(({ table }) => ["job_candidates", "job_revenue_documents"].includes(table)).length, 0);
  assert.equal(db.tables.qbo_cdc_cursors.length, 2);
  assert.ok(db.tables.qbo_cdc_cursors.every((row) => row.last_successful_cursor === now.toISOString()));
  assert.equal(db.tables.qbo_entity_sync_runs.length, 3);
  assert.deepEqual(db.tables.qbo_entity_sync_runs.find((row) => row.id === "historical"), historical);
  for (const run of db.tables.qbo_entity_sync_runs.filter((row) => row.id !== "historical")) {
    assert.equal(run.status, "succeeded");
    assert.equal(run.source_snapshot.schema_version, 1);
    assert.ok(JSON.stringify(run.source_snapshot).length < 16384);
  }
});

test("changed multi-entity CDC generates candidates once and explicit rebuild preserves reviewed state", async () => {
  const { generateJobCandidatesForBusiness } = await import("../src/services/jobCosting/jobIdentityResolver.js");
  const db = createFakeDb();
  const from = db.from.bind(db);
  let candidateReads = 0, candidateWrites = 0;
  db.from = (table) => {
    const query = from(table);
    if (table === "job_candidates") {
      const select = query.select, upsert = query.upsert;
      query.select = function (...args) { candidateReads += 1; return select.apply(this, args); };
      query.upsert = function (...args) { candidateWrites += 1; return upsert.apply(this, args); };
    }
    return query;
  };
  await runQboCdcForBusiness({ businessId: "business-1", db, entities: ["Invoice", "Payment"], qboTransport: { realmId: "realm-1", tokenRow: { realm_id: "realm-1" }, fetchCdc: async () => ({ Invoice: [qboInvoice()], Payment: [qboPayment()] }) }, now: new Date("2026-11-11T16:29:00Z") });
  // The one bulk candidate scan belongs to the batch, not each entity import.
  assert.equal(candidateReads, 1);
  assert.ok(db.tables.job_candidates.length > 0);
  candidateWrites = 0;
  await generateJobCandidatesForBusiness({ businessId: "business-1", realmId: "realm-1", db, now: new Date("2026-11-11T17:29:00Z") });
  assert.equal(candidateWrites, 0, "unchanged explicit rebuild does not upsert");
  db.tables.job_candidates[0].candidate_status = "dismissed";
  const reviewed = JSON.stringify(db.tables.job_candidates[0]);
  await generateJobCandidatesForBusiness({ businessId: "business-1", realmId: "realm-1", db });
  assert.equal(JSON.stringify(db.tables.job_candidates[0]), reviewed);
  assert.equal(candidateWrites, 0);
});

async function seededCandidateDb() {
  const db = createFakeDb();
  await runQboCdcForBusiness({ businessId: "business-1", db, entities: ["Invoice"], qboTransport: { realmId: "realm-1", tokenRow: { realm_id: "realm-1" }, fetchCdc: async () => ({ Invoice: [qboInvoice()] }) }, now: new Date("2026-11-11T16:29:00Z") });
  return db;
}

test("candidate CAS preserves concurrent dismissals, reviews and pending manual edits", async () => {
  const { generateJobCandidatesForBusiness } = await import("../src/services/jobCosting/jobIdentityResolver.js");
  for (const status of ["dismissed", "approved_new", "pending"]) {
    const db = await seededCandidateDb();
    db.tables.job_revenue_documents[0].total_amount = 999;
    const from = db.from.bind(db);
    let attempted = false;
    db.from = (table) => {
      const query = from(table);
      if (table === "job_candidates") {
        const update = query.update;
        query.update = function (...args) {
          const conditional = update.apply(this, args), single = conditional.maybeSingle;
          conditional.maybeSingle = function () {
            attempted = true;
            Object.assign(db.tables.job_candidates[0], { candidate_status: status, suggested_job_name: "Human edit", updated_at: "2026-11-11T17:00:00Z" });
            return single.call(this);
          };
          return conditional;
        };
      }
      return query;
    };
    const result = await generateJobCandidatesForBusiness({ businessId: "business-1", realmId: "realm-1", db });
    assert.equal(attempted, true);
    assert.equal(result.createdOrUpdated, 0);
    assert.equal(db.tables.job_candidates[0].candidate_status, status);
    assert.equal(db.tables.job_candidates[0].suggested_job_name, "Human edit");
  }
});

test("candidate lookup covers more than the server return limit and inserts never overwrite concurrent rows", async () => {
  const { generateJobCandidatesForBusiness } = await import("../src/services/jobCosting/jobIdentityResolver.js");
  const db = await seededCandidateDb();
  const target = db.tables.job_candidates[0];
  target.id = "z-target";
  target.candidate_status = "dismissed";
  db.tables.job_candidates.unshift(...Array.from({ length: 1200 }, (_, i) => ({ ...target, id: `a-${String(i).padStart(5, "0")}`, source_entity_id: `other-${i}` })));
  const protectedValue = JSON.stringify(target);
  const result = await generateJobCandidatesForBusiness({ businessId: "business-1", realmId: "realm-1", db });
  assert.equal(result.createdOrUpdated, 0);
  assert.equal(JSON.stringify(target), protectedValue);
  target.candidate_status = "pending";
  db.tables.job_revenue_documents[0].total_amount = 999;
  const beyondLimit = await generateJobCandidatesForBusiness({ businessId: "business-1", realmId: "realm-1", db });
  assert.equal(beyondLimit.createdOrUpdated, 1);
  assert.equal(target.invoice_estimate_amount, 999);

  db.tables.job_candidates = [];
  const from = db.from.bind(db);
  db.from = (table) => {
    const query = from(table);
    if (table === "job_candidates") {
      const insert = query.insert;
      query.insert = function (payload) {
        db.tables.job_candidates.push({ ...payload, id: "concurrent", candidate_status: "dismissed" });
        return insert.call(this, payload);
      };
    }
    return query;
  };
  const raced = await generateJobCandidatesForBusiness({ businessId: "business-1", realmId: "realm-1", db });
  assert.equal(raced.createdOrUpdated, 0);
  assert.equal(db.tables.job_candidates.length, 1);
  assert.equal(db.tables.job_candidates[0].candidate_status, "dismissed");
});

test("failed CDC candidate generation retains checkpoint and recovers on the next empty sweep", async () => {
  const db = createFakeDb();
  const from = db.from.bind(db);
  let fail = true, candidateScans = 0;
  db.from = (table) => {
    if (table === "job_candidates" && fail) throw new Error("fixture candidate failure");
    const query = from(table);
    if (table === "job_candidates") {
      const select = query.select;
      query.select = function (...args) { candidateScans += 1; return select.apply(this, args); };
    }
    return query;
  };
  const transport = { realmId: "realm-1", tokenRow: { realm_id: "realm-1" }, fetchCdc: async () => ({ Invoice: [qboInvoice()] }) };
  const first = await runQboCdcForBusiness({ businessId: "business-1", db, entities: ["Invoice"], qboTransport: transport, now: new Date("2026-11-11T16:29:00Z") });
  assert.equal(first.ok, false);
  assert.equal(db.tables.qbo_entity_sync_runs[0].status, "failed");
  assert.equal(db.tables.qbo_cdc_cursors[0].last_successful_cursor, null);
  assert.equal(db.tables.qbo_cdc_cursors[0].last_error, "candidate_generation_pending");
  assert.equal(db.tables.qbo_entity_sync_runs[0].errors_count, 1);
  const interrupted = await runQboCdcForBusiness({ businessId: "business-1", db, entities: ["Invoice"],
    qboTransport: { ...transport, fetchCdc: async () => { throw new Error("fixture interrupted recovery"); } },
    now: new Date("2026-11-11T17:00:00Z") });
  assert.equal(interrupted.ok, false);
  assert.equal(db.tables.qbo_cdc_cursors[0].last_error, "candidate_generation_pending");
  assert.equal(db.tables.qbo_cdc_cursors[0].last_successful_cursor, null);
  fail = false; candidateScans = 0;
  transport.fetchCdc = async () => ({ Invoice: [] });
  const second = await runQboCdcForBusiness({ businessId: "business-1", db, entities: ["Invoice"], qboTransport: transport, now: new Date("2026-11-11T17:29:00Z") });
  assert.equal(second.ok, true);
  assert.equal(candidateScans, 1);
  assert.equal(db.tables.job_candidates.length, 1);
  assert.equal(db.tables.qbo_cdc_cursors[0].last_successful_cursor, "2026-11-11T17:29:00.000Z");
  assert.equal(db.tables.qbo_entity_sync_runs[1].status, "succeeded");
  candidateScans = 0;
  await runQboCdcForBusiness({ businessId: "business-1", db, entities: ["Invoice"], qboTransport: transport, now: new Date("2026-11-11T18:29:00Z") });
  assert.equal(candidateScans, 0);
  assert.equal(db.tables.job_candidates.length, 1);
  assert.equal(db.tables.job_revenue_documents.length, 1);
});

test("main and targeted sync writers always insert and finalize versioned compact snapshots", async () => {
  const { refreshProcessorFeeQboEvidence } = await import("../src/services/bookkeeping/processorFeeQboRefreshService.js");
  const db = createFakeDb({ bank_transactions: [{ id: "bank-1", business_id: "business-1", date: "2026-11-11", amount: 10 }] });
  const from = db.from.bind(db), snapshots = [];
  db.from = (table) => {
    const query = from(table);
    if (table === "qbo_entity_sync_runs") for (const method of ["insert", "update"]) {
      const original = query[method];
      query[method] = function (payload) { snapshots.push(payload.source_snapshot); return original.call(this, payload); };
    }
    return query;
  };
  const options = { businessId: "business-1", bankTransactionId: "bank-1", db, authRunner: async (_id, run) => run("fixture", { realmId: "realm-1" }), fetchImpl: async () => ({ ok: true, json: async () => ({ QueryResponse: { Purchase: [] } }) }) };
  const refreshed = await refreshProcessorFeeQboEvidence(options);
  assert.equal(refreshed.entity_counts.Purchase.complete, true);
  await assert.rejects(() => refreshProcessorFeeQboEvidence({ ...options, fetchImpl: async () => { throw new Error("fixture transport failure"); } }));
  await runQboCdcForBusiness({ businessId: "business-1", db, entities: ["Invoice"], qboTransport: { realmId: "realm-1", tokenRow: { realm_id: "realm-1" }, fetchCdc: async () => ({ Invoice: [] }) }, now: new Date("2026-11-11T16:29:00Z") });
  assert.equal(snapshots.length, 6);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.schema_version, 1);
    assert.ok(JSON.stringify(snapshot).length < 16384);
    assert.equal(snapshot.jobCandidates, undefined);
  }
});

test("pending manual edits and legacy candidates without automation provenance fail closed", async () => {
  const { generateJobCandidatesForBusiness } = await import("../src/services/jobCosting/jobIdentityResolver.js");
  for (const legacy of [false, true]) {
    const db = await seededCandidateDb();
    if (legacy) delete db.tables.job_candidates[0].source_snapshot.automated_candidate;
    else db.tables.job_candidates[0].suggested_job_name = "Earlier human edit";
    db.tables.job_revenue_documents[0].total_amount = 999;
    const before = JSON.stringify(db.tables.job_candidates[0]);
    const result = await generateJobCandidatesForBusiness({ businessId: "business-1", realmId: "realm-1", db });
    assert.equal(result.createdOrUpdated, 0);
    assert.equal(JSON.stringify(db.tables.job_candidates[0]), before);
  }
});

test("a pending automated candidate with an intact baseline can be refreshed once by CAS", async () => {
  const { generateJobCandidatesForBusiness } = await import("../src/services/jobCosting/jobIdentityResolver.js");
  const db = await seededCandidateDb();
  db.tables.job_revenue_documents[0].total_amount = 999;
  const first = await generateJobCandidatesForBusiness({ businessId: "business-1", realmId: "realm-1", db });
  assert.equal(first.createdOrUpdated, 1);
  assert.equal(db.tables.job_candidates[0].invoice_estimate_amount, 999);
  const second = await generateJobCandidatesForBusiness({ businessId: "business-1", realmId: "realm-1", db });
  assert.equal(second.createdOrUpdated, 0);
});
