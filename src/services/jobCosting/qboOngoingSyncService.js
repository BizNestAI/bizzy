import crypto from "crypto";
import fetch from "node-fetch";
import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { getLatestQuickBooksTokenRow, withQuickBooksAuth } from "../quickbooksTokenService.js";
import { qbApiBase, qboEnvName } from "../../utils/qboEnv.js";
import { runQboJobCostingSync } from "./qboJobCostingSyncService.js";
import { generateJobCandidatesForBusiness } from "./jobIdentityResolver.js";
import { runQboProjectsSync } from "./qboProjectsService.js";

export const QBO_JOB_COSTING_WEBHOOK_ENTITIES = [
  "Customer",
  "Invoice",
  "Payment",
  "Estimate",
  "SalesReceipt",
  "CreditMemo",
  "Bill",
  "VendorCredit",
  "JournalEntry",
];

const REST_IMPORT_ENTITIES = new Set(["Customer", "Invoice", "Payment", "Estimate", "SalesReceipt", "CreditMemo", "Deposit"]);
const DELETE_OPERATIONS = new Set(["delete", "void"]);
const MINOR_VERSION = "75";
const BACKFILL_PAGE_SIZE = 1000;

function isMissingSchemaError(error) {
  return ["42P01", "42703", "PGRST204", "PGRST205"].includes(error?.code) || /does not exist|schema cache|column/i.test(error?.message || "");
}

function asIso(value, fallback = null) {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function normalizeOperation(operation) {
  const value = String(operation || "unknown").toLowerCase();
  if (value.includes("delete")) return "delete";
  if (value.includes("void")) return "void";
  if (value.includes("merge")) return "merge";
  if (value.includes("create")) return "create";
  if (value.includes("update")) return "update";
  return "unknown";
}

function escapeQboLiteral(value) {
  return String(value || "").replace(/'/g, "''");
}

function timingSafeEqualStrings(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function verifyQuickBooksWebhookSignature({ rawBody, signature, verifierToken }) {
  if (!verifierToken || !signature || rawBody === undefined || rawBody === null) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const expected = crypto.createHmac("sha256", verifierToken).update(body).digest("base64");
  return timingSafeEqualStrings(expected, signature);
}

export function parseQuickBooksWebhookPayload(payload) {
  const notifications = Array.isArray(payload?.eventNotifications) ? payload.eventNotifications : [];
  const events = [];

  for (const notification of notifications) {
    const realmId = String(notification?.realmId || notification?.realmID || "").trim();
    const notificationTime = notification?.eventTime || notification?.dataChangeEvent?.eventTime || null;
    const entities = Array.isArray(notification?.dataChangeEvent?.entities)
      ? notification.dataChangeEvent.entities
      : [];

    for (const entity of entities) {
      const entityType = String(entity?.name || entity?.entityType || "").trim();
      const entityId = String(entity?.id || entity?.entityId || "").trim();
      if (!realmId || !entityType || !entityId) continue;
      const eventTimestamp = asIso(entity?.lastUpdated || entity?.lastUpdatedTime || notificationTime, new Date().toISOString());
      events.push({
        realm_id: realmId,
        qbo_env: qboEnvName,
        entity_type: entityType,
        entity_id: entityId,
        operation: normalizeOperation(entity?.operation),
        event_timestamp: eventTimestamp,
        last_updated_at: asIso(entity?.lastUpdated || entity?.lastUpdatedTime, eventTimestamp),
        raw_entity: entity,
      });
    }
  }

  return events;
}

export function buildWebhookEventHash(event) {
  return crypto
    .createHash("sha256")
    .update([
      event.realm_id,
      event.qbo_env || qboEnvName,
      event.entity_type,
      event.entity_id,
      event.operation,
      event.event_timestamp || "",
    ].join("|"))
    .digest("hex");
}

export async function findBusinessIdForRealm({ realmId, db = defaultSupabase } = {}) {
  if (!realmId) return null;
  const { data, error } = await db
    .from("quickbooks_tokens")
    .select("business_id")
    .eq("realm_id", String(realmId))
    .eq("qbo_env", qboEnvName)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error && !isMissingSchemaError(error)) throw error;
  if (data?.business_id) return data.business_id;

  const fallback = await db
    .from("quickbooks_tokens")
    .select("business_id")
    .eq("realm_id", String(realmId))
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fallback.error && !isMissingSchemaError(fallback.error)) throw fallback.error;
  return fallback.data?.business_id || null;
}

async function findExistingWebhookEvent({ db, eventHash }) {
  const { data, error } = await db
    .from("qbo_webhook_events")
    .select("id, processing_status")
    .eq("event_hash", eventHash)
    .maybeSingle();
  if (error && !isMissingSchemaError(error)) throw error;
  return data || null;
}

async function findNewerWebhookEvent({ db, event }) {
  if (!event.event_timestamp) return null;
  const { data, error } = await db
    .from("qbo_webhook_events")
    .select("id, event_timestamp")
    .eq("realm_id", event.realm_id)
    .eq("qbo_env", event.qbo_env || qboEnvName)
    .eq("entity_type", event.entity_type)
    .eq("entity_id", event.entity_id)
    .gt("event_timestamp", event.event_timestamp)
    .order("event_timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error && !isMissingSchemaError(error)) throw error;
  return data || null;
}

export async function storeQuickBooksWebhookEvents({
  payload,
  intuitSignature = null,
  intuitTid = null,
  db = defaultSupabase,
  now = new Date(),
} = {}) {
  const parsedEvents = parseQuickBooksWebhookPayload(payload);
  const storedEvents = [];
  let duplicates = 0;

  for (const event of parsedEvents) {
    const eventHash = buildWebhookEventHash(event);
    const existing = await findExistingWebhookEvent({ db, eventHash });
    if (existing?.id) {
      duplicates += 1;
      storedEvents.push({ ...event, id: existing.id, duplicate: true, processing_status: existing.processing_status });
      continue;
    }

    const businessId = await findBusinessIdForRealm({ realmId: event.realm_id, db });
    const newerEvent = await findNewerWebhookEvent({ db, event });
    const payloadRow = {
      business_id: businessId,
      realm_id: event.realm_id,
      qbo_env: event.qbo_env || qboEnvName,
      event_hash: eventHash,
      intuit_tid: intuitTid,
      event_timestamp: event.event_timestamp,
      event_received_at: now.toISOString(),
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      operation: event.operation,
      last_updated_at: event.last_updated_at,
      processing_status: newerEvent ? "skipped" : "queued",
      superseded_by_event_id: newerEvent?.id || null,
      out_of_order: Boolean(newerEvent),
      raw_payload: {
        signature_present: Boolean(intuitSignature),
        notification: payload,
        entity: event.raw_entity || {},
      },
    };

    const { data, error } = await db
      .from("qbo_webhook_events")
      .insert(payloadRow)
      .select("*")
      .maybeSingle();
    if (error && !isMissingSchemaError(error)) throw error;
    storedEvents.push(data || { ...payloadRow, id: null });
  }

  return {
    ok: true,
    accepted: parsedEvents.length,
    queued: storedEvents.filter((event) => event.processing_status === "queued").length,
    duplicates,
    events: storedEvents,
  };
}

async function qboGetEntityById({ realmId, accessToken, entityType, entityId, fetchImpl = fetch }) {
  const query = `select * from ${entityType} where Id = '${escapeQboLiteral(entityId)}'`;
  const params = new URLSearchParams({ query, minorversion: MINOR_VERSION });
  const url = `${qbApiBase}/v3/company/${realmId}/query?${params.toString()}`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const error = new Error(`QuickBooks ${entityType} fetch failed ${response.status}: ${await response.text()}`);
    error.status = response.status;
    throw error;
  }
  const json = await response.json();
  return json?.QueryResponse?.[entityType]?.[0] || null;
}

async function fetchLatestQboEntity({ businessId, realmId, entityType, entityId, qboTransport = null, fetchImpl = fetch }) {
  if (qboTransport?.fetchEntity) {
    return qboTransport.fetchEntity({ businessId, realmId, entityType, entityId });
  }
  if (qboTransport?.entities?.[entityType]?.[entityId]) {
    return qboTransport.entities[entityType][entityId];
  }
  return withQuickBooksAuth(businessId, (accessToken) =>
    qboGetEntityById({ realmId, accessToken, entityType, entityId, fetchImpl })
  );
}

async function importSingleEntity({ businessId, realmId, entityType, entity, db, now }) {
  if (!REST_IMPORT_ENTITIES.has(entityType)) {
    return { ok: true, skipped: true, reason: "entity_observed_only" };
  }
  return runQboJobCostingSync({
    businessId,
    mode: "webhook",
    db,
    now,
    qboTransport: {
      realmId,
      fetchAll: ({ entity: requestedEntity }) => (requestedEntity === entityType ? [entity] : []),
    },
  });
}

async function markCanonicalEntityDeletedOrVoided({ db, businessId, realmId, entityType, entityId, operation, now }) {
  const status = operation === "void" ? "voided" : "deleted";
  if (["Invoice", "Estimate", "SalesReceipt", "CreditMemo"].includes(entityType)) {
    const documentType = {
      Invoice: "invoice",
      Estimate: "estimate",
      SalesReceipt: "sales_receipt",
      CreditMemo: "credit_memo",
    }[entityType];
    const { error } = await db
      .from("job_revenue_documents")
      .update({
        status,
        sync_status: status,
        source_updated_at: now.toISOString(),
        last_synced_at: now.toISOString(),
      })
      .eq("business_id", businessId)
      .eq("realm_id", realmId)
      .eq("source_system", "quickbooks")
      .eq("source_document_type", documentType)
      .eq("external_document_id", String(entityId));
    if (error && !isMissingSchemaError(error)) throw error;
    return { ok: true, status, table: "job_revenue_documents" };
  }
  if (entityType === "Payment") {
    const { error } = await db
      .from("job_payment_records")
      .update({
        status,
        sync_status: status,
        source_updated_at: now.toISOString(),
        last_synced_at: now.toISOString(),
      })
      .eq("business_id", businessId)
      .eq("realm_id", realmId)
      .eq("source_system", "quickbooks")
      .eq("external_payment_id", String(entityId));
    if (error && !isMissingSchemaError(error)) throw error;
    return { ok: true, status, table: "job_payment_records" };
  }
  if (entityType === "Customer") {
    const { error } = await db
      .from("qbo_customers")
      .update({
        active: false,
        status: "inactive",
        source_updated_at: now.toISOString(),
        last_synced_at: now.toISOString(),
      })
      .eq("business_id", businessId)
      .eq("realm_id", realmId)
      .eq("qbo_customer_id", String(entityId));
    if (error && !isMissingSchemaError(error)) throw error;
    return { ok: true, status: "inactive", table: "qbo_customers" };
  }
  return { ok: true, skipped: true, reason: "delete_observed_only" };
}

async function updateWebhookEvent({ db, eventId, payload }) {
  const { error } = await db
    .from("qbo_webhook_events")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", eventId);
  if (error && !isMissingSchemaError(error)) throw error;
}

async function loadWebhookEvent({ db, eventId }) {
  const { data, error } = await db
    .from("qbo_webhook_events")
    .select("*")
    .eq("id", eventId)
    .maybeSingle();
  if (error && !isMissingSchemaError(error)) throw error;
  return data || null;
}

export async function processQboWebhookEvent({
  eventId = null,
  eventRow = null,
  db = defaultSupabase,
  fetchImpl = fetch,
  qboTransport = null,
  now = new Date(),
} = {}) {
  const event = eventRow || await loadWebhookEvent({ db, eventId });
  if (!event?.id) throw new Error("qbo_webhook_event_not_found");
  if (event.processing_status === "succeeded" || event.processing_status === "skipped") {
    return { ok: true, skipped: true, status: event.processing_status };
  }

  await updateWebhookEvent({
    db,
    eventId: event.id,
    payload: {
      processing_status: "processing",
      attempts: Number(event.attempts || 0) + 1,
      error_message: null,
    },
  });

  try {
    const businessId = event.business_id || await findBusinessIdForRealm({ realmId: event.realm_id, db });
    if (!businessId) {
      const result = { ok: false, skipped: true, reason: "realm_not_connected" };
      await updateWebhookEvent({
        db,
        eventId: event.id,
        payload: {
          processing_status: "skipped",
          processed_at: now.toISOString(),
          sync_result: result,
        },
      });
      return result;
    }

    let result;
    if (DELETE_OPERATIONS.has(event.operation)) {
      result = await markCanonicalEntityDeletedOrVoided({
        db,
        businessId,
        realmId: event.realm_id,
        entityType: event.entity_type,
        entityId: event.entity_id,
        operation: event.operation,
        now,
      });
    } else if (REST_IMPORT_ENTITIES.has(event.entity_type)) {
      const entity = await fetchLatestQboEntity({
        businessId,
        realmId: event.realm_id,
        entityType: event.entity_type,
        entityId: event.entity_id,
        qboTransport,
        fetchImpl,
      });
      if (!entity) {
        result = await markCanonicalEntityDeletedOrVoided({
          db,
          businessId,
          realmId: event.realm_id,
          entityType: event.entity_type,
          entityId: event.entity_id,
          operation: "delete",
          now,
        });
      } else {
        result = await importSingleEntity({
          businessId,
          realmId: event.realm_id,
          entityType: event.entity_type,
          entity,
          db,
          now,
        });
      }
    } else {
      result = { ok: true, skipped: true, reason: "entity_observed_only", entityType: event.entity_type };
    }

    if (businessId) {
      try {
        result.jobCandidates = await generateJobCandidatesForBusiness({ businessId, db, now });
      } catch (error) {
        result.jobCandidateError = error.message;
      }
    }

    await updateWebhookEvent({
      db,
      eventId: event.id,
      payload: {
        business_id: businessId,
        processing_status: "succeeded",
        processed_at: now.toISOString(),
        sync_result: result,
      },
    });
    return { ok: true, eventId: event.id, result };
  } catch (error) {
    const attempts = Number(event.attempts || 0) + 1;
    const nextAttempt = new Date(now.getTime() + Math.min(60, attempts * 5) * 60 * 1000);
    await updateWebhookEvent({
      db,
      eventId: event.id,
      payload: {
        processing_status: "failed",
        attempts,
        next_attempt_at: nextAttempt.toISOString(),
        error_message: error.message,
        sync_result: { ok: false, error: error.message },
      },
    });
    throw error;
  }
}

export async function processQueuedQboWebhookEvents({
  db = defaultSupabase,
  limit = 25,
  now = new Date(),
  fetchImpl = fetch,
  qboTransport = null,
} = {}) {
  const { data, error } = await db
    .from("qbo_webhook_events")
    .select("*")
    .in("processing_status", ["queued", "failed"])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}`)
    .order("event_timestamp", { ascending: true })
    .limit(limit);
  if (error && !isMissingSchemaError(error)) throw error;

  const results = [];
  for (const event of data || []) {
    try {
      results.push(await processQboWebhookEvent({ eventRow: event, db, now, fetchImpl, qboTransport }));
    } catch (error) {
      results.push({ ok: false, eventId: event.id, error: error.message });
    }
  }
  return {
    ok: true,
    processed: results.length,
    succeeded: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

function extractCdcEntities(cdcPayload) {
  const rowsByEntity = {};
  const responses = cdcPayload?.CDCResponse || cdcPayload?.cdcResponse || [];
  for (const response of responses) {
    const queryResponses = Array.isArray(response?.QueryResponse) ? response.QueryResponse : [];
    for (const queryResponse of queryResponses) {
      for (const [key, value] of Object.entries(queryResponse || {})) {
        if (Array.isArray(value)) rowsByEntity[key] = value;
      }
    }
  }
  return rowsByEntity;
}

async function fetchCdc({ realmId, accessToken, entities, changedSince, fetchImpl = fetch }) {
  const params = new URLSearchParams({
    entities: entities.join(","),
    changedSince,
    minorversion: MINOR_VERSION,
  });
  const url = `${qbApiBase}/v3/company/${realmId}/cdc?${params.toString()}`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const error = new Error(`QuickBooks CDC failed ${response.status}: ${await response.text()}`);
    error.status = response.status;
    throw error;
  }
  return extractCdcEntities(await response.json());
}

async function fetchBackfillPage({ realmId, accessToken, entity, startPosition = 1, maxResults = BACKFILL_PAGE_SIZE, since = null, fetchImpl = fetch }) {
  const where = since ? ` where MetaData.LastUpdatedTime > '${escapeQboLiteral(since)}'` : "";
  const query = `select * from ${entity}${where} STARTPOSITION ${Number(startPosition || 1)} MAXRESULTS ${Number(maxResults || BACKFILL_PAGE_SIZE)}`;
  const params = new URLSearchParams({ query, minorversion: MINOR_VERSION });
  const url = `${qbApiBase}/v3/company/${realmId}/query?${params.toString()}`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const error = new Error(`QuickBooks ${entity} backfill query failed ${response.status}: ${await response.text()}`);
    error.status = response.status;
    throw error;
  }
  const json = await response.json();
  return json?.QueryResponse?.[entity] || [];
}

function subtractOverlap(isoValue, overlapMinutes, now) {
  const base = isoValue ? new Date(isoValue) : now;
  const safeBase = Number.isNaN(base.getTime()) ? now : base;
  return new Date(safeBase.getTime() - Math.max(0, Number(overlapMinutes || 0)) * 60 * 1000).toISOString();
}

async function loadCdcCursor({ db, businessId, realmId, entityType }) {
  const { data, error } = await db
    .from("qbo_cdc_cursors")
    .select("*")
    .eq("business_id", businessId)
    .eq("realm_id", realmId)
    .eq("qbo_env", qboEnvName)
    .eq("entity_type", entityType)
    .maybeSingle();
  if (error && !isMissingSchemaError(error)) throw error;
  return data || null;
}

async function upsertCdcCursor({
  db,
  businessId,
  realmId,
  entityType,
  requestedChangedSince,
  successfulCursor = null,
  processed = 0,
  failures = 0,
  runId = null,
  now,
  status = "succeeded",
  failure = null,
  retryCount = 0,
  overlapMinutes = 10,
}) {
  const payload = {
    business_id: businessId,
    realm_id: realmId,
    qbo_env: qboEnvName,
    entity_type: entityType,
    last_successful_changed_since: successfulCursor,
    last_successful_cursor: successfulCursor,
    last_requested_changed_since: requestedChangedSince,
    overlap_minutes: overlapMinutes,
    overlap_duration_minutes: overlapMinutes,
    last_attempted_at: now.toISOString(),
    status,
    last_run_id: runId,
    entities_queried: [entityType],
    items_processed: processed,
    processed_count: processed,
    failures,
    failure: failure ? String(failure.message || failure) : null,
    retry_count: retryCount,
    retries: retryCount,
    last_error: failure ? String(failure.message || failure) : failures ? "Some CDC items failed to reconcile." : null,
    updated_at: now.toISOString(),
  };
  if (status === "succeeded") payload.last_completed_at = now.toISOString();
  const { error } = await db
    .from("qbo_cdc_cursors")
    .upsert(payload, { onConflict: "business_id,realm_id,qbo_env,entity_type" });
  if (error && !isMissingSchemaError(error)) throw error;
}

export async function runQboCdcForBusiness({
  businessId,
  db = defaultSupabase,
  entities = REST_IMPORT_ENTITIES,
  overlapMinutes = 10,
  now = new Date(),
  fetchImpl = fetch,
  qboTransport = null,
} = {}) {
  if (!businessId) throw new Error("businessId is required");
  const tokenRow = qboTransport?.tokenRow || await getLatestQuickBooksTokenRow(businessId);
  const realmId = qboTransport?.realmId || tokenRow?.realm_id;
  if (!realmId) throw new Error("quickbooks_realm_id_missing");
  const entityList = Array.from(entities);
  const entityResults = {};
  const failures = [];

  for (const entityType of entityList) {
    const existingCursor = await loadCdcCursor({ db, businessId, realmId, entityType });
    const entityOverlap = Number(existingCursor?.overlap_minutes ?? existingCursor?.overlap_duration_minutes ?? overlapMinutes);
    const successfulCursor = existingCursor?.last_successful_cursor || existingCursor?.last_successful_changed_since || null;
    const changedSince = subtractOverlap(successfulCursor, entityOverlap, now);
    const retryCount = Number(existingCursor?.retry_count ?? existingCursor?.retries ?? 0);

    try {
      await upsertCdcCursor({
        db,
        businessId,
        realmId,
        entityType,
        requestedChangedSince: changedSince,
        successfulCursor,
        processed: Number(existingCursor?.processed_count ?? existingCursor?.items_processed ?? 0),
        status: "running",
        retryCount,
        overlapMinutes: entityOverlap,
        now,
      });

      const rowsByEntity = qboTransport?.fetchCdc
        ? await qboTransport.fetchCdc({ businessId, realmId, entities: [entityType], changedSince })
        : await withQuickBooksAuth(businessId, (accessToken) =>
          fetchCdc({ realmId, accessToken, entities: [entityType], changedSince, fetchImpl })
        );
      const rows = rowsByEntity?.[entityType] || [];
      const sync = await runQboJobCostingSync({
        businessId,
        mode: "cdc",
        since: changedSince,
        db,
        now,
        qboTransport: {
          realmId,
          fetchAll: ({ entity }) => (entity === entityType ? rows : []),
        },
      });
      const entityFailures = (sync.reconciliationFailures || []).filter((item) => item.entity === entityType).length;
      if (entityFailures > 0) {
        const error = new Error(`${entityType} CDC had ${entityFailures} failed records.`);
        await upsertCdcCursor({
          db,
          businessId,
          realmId,
          entityType,
          requestedChangedSince: changedSince,
          successfulCursor,
          processed: rows.length,
          failures: entityFailures,
          status: "failed",
          failure: error,
          retryCount: retryCount + 1,
          overlapMinutes: entityOverlap,
          now,
        });
        failures.push({ entity: entityType, error: error.message });
        entityResults[entityType] = { ok: false, changedSince, processed: rows.length, failures: entityFailures, sync };
        continue;
      }

      await upsertCdcCursor({
        db,
        businessId,
        realmId,
        entityType,
        requestedChangedSince: changedSince,
        successfulCursor: now.toISOString(),
        processed: rows.length,
        failures: 0,
        status: "succeeded",
        retryCount: 0,
        overlapMinutes: entityOverlap,
        now,
      });
      entityResults[entityType] = { ok: true, changedSince, successfulCursor: now.toISOString(), processed: rows.length, sync };
    } catch (error) {
      await upsertCdcCursor({
        db,
        businessId,
        realmId,
        entityType,
        requestedChangedSince: changedSince,
        successfulCursor,
        processed: 0,
        failures: 1,
        status: "failed",
        failure: error,
        retryCount: retryCount + 1,
        overlapMinutes: entityOverlap,
        now,
      });
      failures.push({ entity: entityType, error: error.message });
      entityResults[entityType] = { ok: false, changedSince, error: error.message };
    }
  }

  return { ok: failures.length === 0, businessId, realmId, entities: entityResults, failures };
}

async function upsertDailyState({ db, businessId, realmId, status, runId = null, error = null, now }) {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const { error: dbError } = await db
    .from("qbo_job_costing_daily_sync_state")
    .upsert({
      business_id: businessId,
      realm_id: realmId,
      qbo_env: qboEnvName,
      last_daily_sync_at: now.toISOString(),
      last_status: status,
      last_run_id: runId,
      next_run_after: tomorrow.toISOString(),
      last_error: error ? String(error.message || error) : null,
      updated_at: now.toISOString(),
    }, { onConflict: "business_id,realm_id,qbo_env" });
  if (dbError && !isMissingSchemaError(dbError)) throw dbError;
}

export async function runDailyQboJobCostingReconciliation({
  businessId,
  db = defaultSupabase,
  now = new Date(),
  qboTransport = null,
  projectsTransport = null,
} = {}) {
  if (!businessId) throw new Error("businessId is required");
  const tokenRow = qboTransport?.tokenRow || await getLatestQuickBooksTokenRow(businessId);
  const realmId = qboTransport?.realmId || tokenRow?.realm_id;
  if (!realmId) throw new Error("quickbooks_realm_id_missing");

  try {
    const sync = await runQboJobCostingSync({
      businessId,
      mode: "daily_reconciliation",
      db,
      now,
      qboTransport,
    });
    let projects = { ok: true, skipped: true, reason: "projects_transport_unavailable" };
    try {
      projects = await runQboProjectsSync({
        businessId,
        autoImport: true,
        db,
        projectsTransport,
        now,
      });
    } catch (error) {
      projects = { ok: false, skipped: true, error: error.message };
    }
    await upsertDailyState({ db, businessId, realmId, status: "succeeded", now });
    return { ok: true, businessId, realmId, sync, projects };
  } catch (error) {
    await upsertDailyState({ db, businessId, realmId, status: "failed", error, now });
    throw error;
  }
}

async function createOrResumeBackfillRun({ db, businessId, realmId, startDate, endDate, batchSize, now }) {
  const { data: existing, error: existingError } = await db
    .from("qbo_job_costing_backfill_runs")
    .select("*")
    .eq("business_id", businessId)
    .eq("realm_id", realmId)
    .in("status", ["queued", "running", "failed", "paused"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError && !isMissingSchemaError(existingError)) throw existingError;
  if (existing?.id) return existing;

  const { data, error } = await db
    .from("qbo_job_costing_backfill_runs")
    .insert({
      business_id: businessId,
      realm_id: realmId,
      qbo_env: qboEnvName,
      start_date: startDate,
      end_date: endDate,
      batch_size: batchSize,
      status: "queued",
      current_entity: null,
      current_start_position: 1,
      completed_entities: [],
      last_committed_page: {},
      fetched_count: 0,
      committed_count: 0,
      failed_record_count: 0,
      retry_count: 0,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .select("*")
    .maybeSingle();
  if (error && !isMissingSchemaError(error)) throw error;
  return data || null;
}

function backfillProgressFromRun(run = {}) {
  const progress = run.progress && typeof run.progress === "object" ? run.progress : {};
  const counts = run.counts && typeof run.counts === "object" ? run.counts : {};
  return {
    currentEntity: run.current_entity || progress.current_entity || null,
    currentStartPosition: Number(run.current_start_position ?? progress.current_start_position ?? 1) || 1,
    completedEntities: Array.isArray(run.completed_entities) ? run.completed_entities : Array.isArray(progress.completed_entities) ? progress.completed_entities : [],
    lastCommittedPage: run.last_committed_page && typeof run.last_committed_page === "object" ? run.last_committed_page : progress.last_committed_page || {},
    fetchedCount: Number(run.fetched_count ?? counts.fetched ?? 0) || 0,
    committedCount: Number(run.committed_count ?? counts.committed ?? 0) || 0,
    failedRecordCount: Number(run.failed_record_count ?? counts.failed ?? 0) || 0,
    retryCount: Number(run.retry_count ?? counts.retries ?? 0) || 0,
  };
}

async function updateBackfillRun({ db, runId, patch }) {
  if (!runId) return;
  const { error } = await db
    .from("qbo_job_costing_backfill_runs")
    .update(patch)
    .eq("id", runId);
  if (error && !isMissingSchemaError(error)) throw error;
}

async function fetchBackfillEntityPage({ businessId, realmId, entity, startPosition, batchSize, startDate, qboTransport, fetchImpl }) {
  if (qboTransport?.fetchBackfillPage) {
    return qboTransport.fetchBackfillPage({ businessId, realmId, entity, startPosition, maxResults: batchSize, startDate });
  }
  if (qboTransport?.fetchPage) {
    return qboTransport.fetchPage({ businessId, realmId, entity, startPosition, maxResults: batchSize, startDate });
  }
  if (qboTransport?.fetchAll) {
    const all = await qboTransport.fetchAll({ entity, since: startDate, mode: "backfill" });
    return (all || []).slice(startPosition - 1, startPosition - 1 + batchSize);
  }
  return withQuickBooksAuth(businessId, (accessToken) =>
    fetchBackfillPage({ realmId, accessToken, entity, startPosition, maxResults: batchSize, since: startDate, fetchImpl })
  );
}

function mergeEntityCounts(target = {}, source = {}) {
  for (const [entity, counts] of Object.entries(source || {})) {
    if (!target[entity]) target[entity] = {};
    for (const [key, value] of Object.entries(counts || {})) {
      target[entity][key] = Number(target[entity][key] || 0) + Number(value || 0);
    }
  }
  return target;
}

export async function runQboJobCostingBackfill({
  businessId,
  startDate = null,
  endDate = null,
  batchSize = 1000,
  db = defaultSupabase,
  now = new Date(),
  fetchImpl = fetch,
  qboTransport = null,
  projectsTransport = null,
} = {}) {
  if (!businessId) throw new Error("businessId is required");
  const tokenRow = qboTransport?.tokenRow || await getLatestQuickBooksTokenRow(businessId);
  const realmId = qboTransport?.realmId || tokenRow?.realm_id;
  if (!realmId) throw new Error("quickbooks_realm_id_missing");

  const entityList = Array.from(REST_IMPORT_ENTITIES);
  const run = await createOrResumeBackfillRun({ db, businessId, realmId, startDate, endDate, batchSize, now });
  const resume = backfillProgressFromRun(run || {});
  const completed = new Set(resume.completedEntities);
  const aggregateCounts = {};
  let fetchedCount = resume.fetchedCount;
  let committedCount = resume.committedCount;
  let failedRecordCount = resume.failedRecordCount;
  let retryCount = resume.retryCount;
  const lastCommittedPage = { ...resume.lastCommittedPage };
  if (run?.id) {
    await updateBackfillRun({ db, runId: run.id, patch: {
      status: "running",
      realm_id: realmId,
      started_at: run.started_at || now.toISOString(),
      date_range_start: startDate,
      date_range_end: endDate,
      updated_at: now.toISOString(),
      error_message: null,
      retry_state: { retry_count: retryCount },
      progress: {
        current_entity: resume.currentEntity,
        current_start_position: resume.currentStartPosition,
        completed_entities: Array.from(completed),
        last_committed_page: lastCommittedPage,
      },
    } });
  }

  try {
    for (const entity of entityList) {
      if (completed.has(entity)) continue;
      let startPosition = resume.currentEntity === entity ? resume.currentStartPosition : 1;
      while (true) {
        if (run?.id) {
          await updateBackfillRun({ db, runId: run.id, patch: {
            current_entity: entity,
            current_start_position: startPosition,
            status: "running",
            updated_at: now.toISOString(),
            progress: {
              current_entity: entity,
              current_start_position: startPosition,
              completed_entities: Array.from(completed),
              last_committed_page: lastCommittedPage,
            },
          } });
        }

        const rows = await fetchBackfillEntityPage({
          businessId,
          realmId,
          entity,
          startPosition,
          batchSize,
          startDate,
          qboTransport,
          fetchImpl,
        });
        fetchedCount += rows.length;
        if (!rows.length) break;

        const sync = await runQboJobCostingSync({
          businessId,
          mode: "backfill",
          since: startDate,
          db,
          now,
          qboTransport: {
            realmId,
            fetchAll: ({ entity: requestedEntity }) => (requestedEntity === entity ? rows : []),
          },
        });
        mergeEntityCounts(aggregateCounts, sync.entityCounts);
        const pageFailures = (sync.reconciliationFailures || []).filter((item) => item.entity === entity).length;
        if (pageFailures > 0) {
          failedRecordCount += pageFailures;
          retryCount += 1;
          const error = new Error(`${entity} backfill page ${startPosition} had ${pageFailures} failed records.`);
          if (run?.id) {
            await updateBackfillRun({ db, runId: run.id, patch: {
              status: "failed",
              error_message: error.message,
              failed_record_count: failedRecordCount,
              retry_count: retryCount,
              retry_state: { retry_count: retryCount, entity, start_position: startPosition },
              updated_at: now.toISOString(),
            } });
          }
          throw error;
        }

        committedCount += rows.length;
        lastCommittedPage[entity] = startPosition;
        startPosition += rows.length;
        if (run?.id) {
          await updateBackfillRun({ db, runId: run.id, patch: {
            current_entity: entity,
            current_start_position: startPosition,
            last_committed_page: lastCommittedPage,
            fetched_count: fetchedCount,
            committed_count: committedCount,
            failed_record_count: failedRecordCount,
            retry_count: retryCount,
            counts: { fetched: fetchedCount, committed: committedCount, failed: failedRecordCount, retries: retryCount, entityCounts: aggregateCounts },
            progress: {
              current_entity: entity,
              current_start_position: startPosition,
              completed_entities: Array.from(completed),
              last_committed_page: lastCommittedPage,
            },
            updated_at: now.toISOString(),
          } });
        }

        if (rows.length < batchSize) break;
      }
      completed.add(entity);
      if (run?.id) {
        await updateBackfillRun({ db, runId: run.id, patch: {
          completed_entities: Array.from(completed),
          current_entity: null,
          current_start_position: 1,
          progress: {
            current_entity: null,
            current_start_position: 1,
            completed_entities: Array.from(completed),
            last_committed_page: lastCommittedPage,
          },
          updated_at: now.toISOString(),
        } });
      }
    }

    const sync = { ok: true, mode: "backfill", businessId, realmId, since: startDate, entityCounts: aggregateCounts };
    let projects = { ok: true, skipped: true, reason: "projects_transport_unavailable" };
    try {
      projects = await runQboProjectsSync({ businessId, autoImport: true, db, projectsTransport, now });
    } catch (error) {
      projects = { ok: false, skipped: true, error: error.message };
    }

    if (run?.id) {
      await updateBackfillRun({ db, runId: run.id, patch: {
        status: "succeeded",
        finished_at: now.toISOString(),
        updated_at: now.toISOString(),
        current_entity: null,
        current_start_position: 1,
        completed_entities: Array.from(completed),
        last_committed_page: lastCommittedPage,
        fetched_count: fetchedCount,
        committed_count: committedCount,
        failed_record_count: failedRecordCount,
        retry_count: retryCount,
        progress: { completed: true, startDate, endDate, completed_entities: Array.from(completed), last_committed_page: lastCommittedPage },
        counts: { fetched: fetchedCount, committed: committedCount, failed: failedRecordCount, retries: retryCount, entityCounts: aggregateCounts },
      } });
    }

    return { ok: true, businessId, realmId, backfillRunId: run?.id || null, sync, projects };
  } catch (error) {
    if (run?.id) {
      await updateBackfillRun({ db, runId: run.id, patch: {
        status: "failed",
        error_message: error.message,
        failed_record_count: failedRecordCount,
        retry_count: retryCount + 1,
        retry_state: { retry_count: retryCount + 1 },
        updated_at: now.toISOString(),
      } });
    }
    throw error;
  }
}

export async function getQboOngoingSyncDiagnostics({ businessId, db = defaultSupabase } = {}) {
  if (!businessId) throw new Error("businessId is required");
  const [events, cursors, daily, backfills] = await Promise.all([
    db.from("qbo_webhook_events").select("*").eq("business_id", businessId).order("event_received_at", { ascending: false }).limit(10),
    db.from("qbo_cdc_cursors").select("*").eq("business_id", businessId).order("updated_at", { ascending: false }),
    db.from("qbo_job_costing_daily_sync_state").select("*").eq("business_id", businessId).order("updated_at", { ascending: false }).limit(5),
    db.from("qbo_job_costing_backfill_runs").select("*").eq("business_id", businessId).order("created_at", { ascending: false }).limit(5),
  ]);

  const errors = [events, cursors, daily, backfills].map((item) => item.error).filter((error) => error && !isMissingSchemaError(error));
  if (errors.length) throw errors[0];

  return {
    ok: true,
    webhookEvents: events.error ? [] : events.data || [],
    cdcCursors: cursors.error ? [] : cursors.data || [],
    dailySync: daily.error ? [] : daily.data || [],
    backfills: backfills.error ? [] : backfills.data || [],
    workerFlags: {
      webhookWorkerDisabled: String(process.env.DISABLE_QBO_JOB_COSTING_WEBHOOK_WORKER || "").toLowerCase() === "true",
      cdcCronDisabled: String(process.env.DISABLE_QBO_JOB_COSTING_CDC_CRON || "").toLowerCase() === "true",
      dailyCronDisabled: String(process.env.DISABLE_QBO_JOB_COSTING_DAILY_CRON || "").toLowerCase() === "true",
      allSyncDisabled: String(process.env.DISABLE_QBO_JOB_COSTING_SYNC || "").toLowerCase() === "true",
    },
  };
}

export default {
  QBO_JOB_COSTING_WEBHOOK_ENTITIES,
  verifyQuickBooksWebhookSignature,
  parseQuickBooksWebhookPayload,
  storeQuickBooksWebhookEvents,
  processQboWebhookEvent,
  processQueuedQboWebhookEvents,
  runQboCdcForBusiness,
  runDailyQboJobCostingReconciliation,
  runQboJobCostingBackfill,
  getQboOngoingSyncDiagnostics,
};
