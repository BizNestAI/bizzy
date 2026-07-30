import fetch from "node-fetch";
import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { withQuickBooksAuth } from "../quickbooksTokenService.js";
import { qbApiBase, qboEnvName } from "../../utils/qboEnv.js";
import {
  buildPaymentAllocationsFromPayment,
  mapQboDocumentType,
  normalizeQboCustomer,
  normalizeQboPaymentRecord,
  normalizeQboRevenueDocument,
  parseCustomerRef,
  parseProjectRef,
  toNumber,
} from "./qboJobCostingParsers.js";
import { generateJobCandidatesForBusiness } from "./jobIdentityResolver.js";
import { getQboProjectsDiagnostics } from "./qboProjectsService.js";

export const JOB_COSTING_QBO_IMPORT_ORDER = [
  "Customer",
  "Estimate",
  "Invoice",
  "SalesReceipt",
  "CreditMemo",
  "Payment",
  "Deposit",
];

const PAGE_SIZE = 1000;
const MINOR_VERSION = "75";
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeQboLiteral(value) {
  return String(value || "").replace(/'/g, "''");
}

function isMissingSchemaError(error) {
  return ["42P01", "42703", "PGRST204", "PGRST205"].includes(error?.code) || /does not exist|schema cache|column/i.test(error?.message || "");
}

function emptyCounts() {
  return {
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    deleted: 0,
    linked: 0,
  };
}

function increment(counts, key, by = 1) {
  counts[key] = toNumber(counts[key], 0) + by;
}

export async function withQboRetry(operation, { attempts = 3, baseDelayMs = 300 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const retryable = RETRY_STATUSES.has(Number(error?.status || error?.statusCode));
      if (!retryable || attempt === attempts) break;
      const retryAfter = Number(error?.retryAfterMs || 0);
      await sleep(retryAfter || baseDelayMs * attempt);
    }
  }
  throw lastError;
}

async function qboQuery({ realmId, accessToken, entity, startPosition = 1, maxResults = PAGE_SIZE, since = null, fetchImpl = fetch }) {
  const fields = "*";
  const where = since ? ` where MetaData.LastUpdatedTime > '${escapeQboLiteral(since)}'` : "";
  const query = `select ${fields} from ${entity}${where} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
  const params = new URLSearchParams({ query, minorversion: MINOR_VERSION });
  const url = `${qbApiBase}/v3/company/${realmId}/query?${params.toString()}`;

  return withQboRetry(async () => {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`[qbo job-costing sync] ${entity} query failed ${response.status}: ${text}`);
      error.status = response.status;
      const retryAfter = Number(response.headers?.get?.("retry-after") || 0);
      if (retryAfter) error.retryAfterMs = retryAfter * 1000;
      throw error;
    }
    return response.json();
  });
}

async function fetchAllQboEntities({ realmId, accessToken, entity, since = null, fetchImpl = fetch }) {
  const rows = [];
  let startPosition = 1;

  while (true) {
    const json = await qboQuery({ realmId, accessToken, entity, startPosition, maxResults: PAGE_SIZE, since, fetchImpl });
    const page = json?.QueryResponse?.[entity] || [];
    rows.push(...page);
    if (!Array.isArray(page) || page.length < PAGE_SIZE) break;
    startPosition += PAGE_SIZE;
  }

  return rows;
}

async function maybeCreateSyncRun({ db, businessId, realmId, mode, since }) {
  const { data, error } = await db
    .from("qbo_entity_sync_runs")
    .insert({
      business_id: businessId,
      realm_id: realmId,
      qbo_env: qboEnvName,
      mode,
      trigger_source: mode,
      since,
      status: "running",
    })
    .select("id")
    .maybeSingle();

  if (error && !isMissingSchemaError(error)) throw error;
  return data?.id || null;
}

async function maybeFinishSyncRun({ db, runId, status, result, error = null }) {
  if (!runId) return;
  const counts = Object.values(result?.entityCounts || {}).reduce((acc, entityCounts) => {
    acc.fetched += toNumber(entityCounts.fetched, 0);
    acc.created += toNumber(entityCounts.created, 0);
    acc.updated += toNumber(entityCounts.updated, 0);
    acc.unchanged += toNumber(entityCounts.unchanged, 0);
    acc.deleted += toNumber(entityCounts.deleted, 0);
    acc.linked += toNumber(entityCounts.linked, 0);
    acc.errors += toNumber(entityCounts.failed, 0);
    return acc;
  }, { fetched: 0, created: 0, updated: 0, unchanged: 0, deleted: 0, linked: 0, errors: 0 });
  const payload = {
    status,
    finished_at: new Date().toISOString(),
    entity_counts: result?.entityCounts || {},
    missing_refs: result?.missingRefs || [],
    orphan_allocations: result?.orphanAllocations || [],
    duplicate_external_ids: result?.duplicateExternalIds || [],
    reconciliation_failures: result?.reconciliationFailures || [],
    last_error: error ? String(error.message || error) : null,
    source_snapshot: result || {},
    fetched_count: counts.fetched,
    created_count: counts.created,
    updated_count: counts.updated,
    unchanged_count: counts.unchanged,
    deleted_count: counts.deleted,
    linked_count: counts.linked,
    errors_count: counts.errors + (result?.reconciliationFailures?.length || 0),
    candidates_created_count: Number(result?.jobCandidates?.created || result?.jobCandidates?.createdCount || 0),
    cursor: { since: result?.since || null, mode: result?.mode || null },
  };
  const { error: updateError } = await db.from("qbo_entity_sync_runs").update(payload).eq("id", runId);
  if (updateError && !isMissingSchemaError(updateError)) throw updateError;
}

async function getExistingCustomerId({ db, businessId, realmId, qboCustomerId }) {
  if (!qboCustomerId) return null;
  const { data, error } = await db
    .from("qbo_customers")
    .select("customer_id")
    .eq("business_id", businessId)
    .eq("realm_id", realmId)
    .eq("qbo_customer_id", String(qboCustomerId))
    .maybeSingle();
  if (error && !isMissingSchemaError(error)) throw error;
  return data?.customer_id || null;
}

async function getJobIdForQboRef({ db, businessId, realmId, ref, sourceEntityTypes = ["project", "customer", "sub_customer"] }) {
  if (!ref?.value) return null;
  const { data, error } = await db
    .from("job_external_links")
    .select("job_id")
    .eq("business_id", businessId)
    .eq("source_system", "quickbooks")
    .eq("realm_id", realmId)
    .eq("external_entity_id", String(ref.value))
    .in("source_entity_type", sourceEntityTypes)
    .maybeSingle();
  if (error && !isMissingSchemaError(error)) throw error;
  if (data?.job_id) return data.job_id;
  return null;
}

async function upsertAndFetch({ db, table, payload, onConflict, select = "*" }) {
  const keys = String(onConflict || "").split(",").map((key) => key.trim()).filter(Boolean);
  let existing = null;
  if (keys.length) {
    let query = db.from(table).select("*");
    for (const key of keys) query = query.eq(key, payload[key]);
    const existingResult = await query.maybeSingle();
    if (existingResult.error && !isMissingSchemaError(existingResult.error)) throw existingResult.error;
    existing = existingResult.data || null;
  }
  const { data, error } = await db
    .from(table)
    .upsert(payload, { onConflict })
    .select(select)
    .maybeSingle();
  if (error) throw error;
  const mutation = !existing
    ? "created"
    : String(existing.sync_token ?? existing.source_updated_at ?? "") === String(payload.sync_token ?? payload.source_updated_at ?? "")
      ? "unchanged"
      : "updated";
  if (data && typeof data === "object") {
    Object.defineProperty(data, "__mutation", { value: mutation, enumerable: false, configurable: true });
  }
  return data;
}

async function importCustomer({ db, businessId, realmId, qboCustomer, now }) {
  const normalized = normalizeQboCustomer(qboCustomer, { businessId, realmId, now });
  let customerId = await getExistingCustomerId({ db, businessId, realmId, qboCustomerId: qboCustomer.Id });
  const created = !customerId;

  if (!customerId) {
    const { data: inserted, error } = await db
      .from("customers")
      .insert(normalized.canonicalCustomer)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    customerId = inserted?.id || null;
  } else {
    const { error } = await db.from("customers").update(normalized.canonicalCustomer).eq("id", customerId);
    if (error) throw error;
  }

  const qboPayload = { ...normalized.qboCustomer, customer_id: customerId };
  const linkPayload = { ...normalized.externalLink, customer_id: customerId };
  await upsertAndFetch({
    db,
    table: "qbo_customers",
    payload: qboPayload,
    onConflict: "business_id,realm_id,qbo_customer_id",
    select: "id",
  });
  await upsertAndFetch({
    db,
    table: "customer_external_links",
    payload: linkPayload,
    onConflict: "business_id,realm_id,source_system,source_entity_type,external_entity_id",
    select: "id",
  });

  return { customer_id: customerId, mutation: created ? "created" : "updated" };
}

async function importRevenueDocument({ db, businessId, realmId, qboType, document, now, diagnostics }) {
  const customerRef = parseCustomerRef(document);
  const projectRef = parseProjectRef(document);
  const customerId = await getExistingCustomerId({ db, businessId, realmId, qboCustomerId: customerRef?.value });
  if (customerRef?.value && !customerId) {
    diagnostics.missingRefs.push({ entity: qboType, external_id: String(document.Id), ref_type: "CustomerRef", ref_id: customerRef.value });
  }

  const jobId =
    (await getJobIdForQboRef({ db, businessId, realmId, ref: projectRef, sourceEntityTypes: ["project"] })) ||
    (await getJobIdForQboRef({ db, businessId, realmId, ref: customerRef, sourceEntityTypes: ["customer", "sub_customer"] }));

  const payload = {
    ...normalizeQboRevenueDocument(document, qboType, { businessId, realmId, customerId, jobId, now }),
    last_synced_at: now.toISOString(),
  };

  const saved = await upsertAndFetch({
    db,
    table: "job_revenue_documents",
    payload,
    onConflict: "business_id,realm_id,source_system,source_document_type,external_document_id",
    select: "id, source_document_type, external_document_id",
  });
  return { ...saved, mutation: saved?.__mutation || "updated", linked: Boolean(payload.job_id) };
}

async function loadRevenueDocumentMap({ db, businessId, realmId }) {
  const { data, error } = await db
    .from("job_revenue_documents")
    .select("id, source_document_type, external_document_id")
    .eq("business_id", businessId)
    .eq("realm_id", realmId)
    .eq("source_system", "quickbooks");
  if (error && !isMissingSchemaError(error)) throw error;
  const map = new Map();
  (data || []).forEach((doc) => {
    if (doc.external_document_id && doc.source_document_type) {
      map.set(`${doc.source_document_type}:${doc.external_document_id}`, doc);
    }
  });
  return map;
}

async function importPayment({ db, businessId, realmId, payment, now, diagnostics }) {
  const customerRef = parseCustomerRef(payment);
  const customerId = await getExistingCustomerId({ db, businessId, realmId, qboCustomerId: customerRef?.value });
  if (customerRef?.value && !customerId) {
    diagnostics.missingRefs.push({ entity: "Payment", external_id: String(payment.Id), ref_type: "CustomerRef", ref_id: customerRef.value });
  }

  const paymentRecord = await upsertAndFetch({
    db,
    table: "job_payment_records",
    payload: {
      ...normalizeQboPaymentRecord(payment, { businessId, realmId, customerId, now }),
      last_synced_at: now.toISOString(),
    },
    onConflict: "business_id,realm_id,source_system,external_payment_id",
    select: "id",
  });

  const documentByExternalKey = await loadRevenueDocumentMap({ db, businessId, realmId });
  const { allocations, orphans } = buildPaymentAllocationsFromPayment({
    paymentRecordId: paymentRecord.id,
    payment,
    documentByExternalKey,
    now,
  });
  diagnostics.orphanAllocations.push(...orphans.map((orphan) => ({ payment_id: String(payment.Id), ...orphan })));

  const { error: deleteAllocationsError } = await db
    .from("job_payment_allocations")
    .delete()
    .eq("business_id", businessId)
    .eq("payment_record_id", paymentRecord.id);
  if (deleteAllocationsError) throw deleteAllocationsError;

  for (const allocation of allocations) {
    await upsertAndFetch({
      db,
      table: "job_payment_allocations",
      payload: { ...allocation, business_id: businessId },
      onConflict: "business_id,payment_record_id,revenue_document_id,linked_transaction_type,linked_transaction_id",
      select: "id",
    });
  }

  return {
    payment_record_id: paymentRecord.id,
    mutation: paymentRecord?.__mutation || "updated",
    allocations: allocations.length,
    orphans: orphans.length,
    linked: allocations.length,
  };
}

async function importDepositEvidence({ db, businessId, realmId, deposit, now, diagnostics }) {
  const linkedTxns = (deposit.Line || []).flatMap((line) =>
    (Array.isArray(line.LinkedTxn) ? line.LinkedTxn : line.LinkedTxn ? [line.LinkedTxn] : []).map((linked) => ({
      txn_id: String(linked.TxnId || linked.txnId || ""),
      txn_type: String(linked.TxnType || linked.txnType || ""),
      amount: toNumber(line.Amount, 0),
      raw: { line, linked },
    }))
  ).filter((row) => row.txn_id);
  const linkedPaymentIds = linkedTxns
    .filter((row) => /payment|receive_payment/i.test(row.txn_type))
    .map((row) => row.txn_id);
  let jobId = null;
  let paymentRecordId = null;
  let revenueDocumentId = null;

  for (const paymentId of linkedPaymentIds) {
    const { data: paymentRecord, error: paymentError } = await db
      .from("job_payment_records")
      .select("id")
      .eq("business_id", businessId)
      .eq("realm_id", realmId)
      .eq("source_system", "quickbooks")
      .eq("external_payment_id", paymentId)
      .maybeSingle();
    if (paymentError && !isMissingSchemaError(paymentError)) throw paymentError;
    if (!paymentRecord?.id) continue;
    paymentRecordId = paymentRecord.id;
    const { data: allocations, error: allocationError } = await db
      .from("job_payment_allocations")
      .select("revenue_document_id")
      .eq("business_id", businessId)
      .eq("payment_record_id", paymentRecord.id)
      .limit(1);
    if (allocationError && !isMissingSchemaError(allocationError)) throw allocationError;
    revenueDocumentId = allocations?.[0]?.revenue_document_id || null;
    if (revenueDocumentId) {
      const { data: doc, error: docError } = await db
        .from("job_revenue_documents")
        .select("job_id")
        .eq("business_id", businessId)
        .eq("id", revenueDocumentId)
        .maybeSingle();
      if (docError && !isMissingSchemaError(docError)) throw docError;
      jobId = doc?.job_id || null;
    }
    break;
  }

  const status = linkedPaymentIds.length && paymentRecordId ? "confirmed" : "partial";
  const payload = {
    business_id: businessId,
    job_id: jobId,
    bank_transaction_id: null,
    realm_id: realmId,
    qbo_env: qboEnvName,
    qbo_txn_id: String(deposit.Id || ""),
    qbo_txn_type: "Deposit",
    match_type: "deposit_evidence",
    match_confidence: status === "confirmed" ? 0.9 : 0.45,
    amount: Math.abs(toNumber(deposit.TotalAmt ?? deposit.TotalAmtValue, 0)),
    status,
    source_snapshot: {
      deposit,
      linked_txns: linkedTxns,
      linked_payment_ids: linkedPaymentIds,
      payment_record_id: paymentRecordId,
      revenue_document_id: revenueDocumentId,
      explanation: status === "confirmed"
        ? "QBO deposit is settlement evidence for linked payment records and does not create revenue."
        : "QBO deposit linkage is incomplete; preserved as partial settlement evidence and does not create revenue.",
    },
    updated_at: now.toISOString(),
  };

  const existingResult = await db
    .from("job_revenue_evidence")
    .select("id")
    .eq("business_id", businessId)
    .eq("realm_id", realmId)
    .eq("qbo_txn_type", "Deposit")
    .eq("qbo_txn_id", String(deposit.Id || ""))
    .maybeSingle();
  if (existingResult.error && !isMissingSchemaError(existingResult.error)) throw existingResult.error;
  let saved = null;
  let mutation = "created";
  if (existingResult.data?.id) {
    const updateResult = await db
      .from("job_revenue_evidence")
      .update(payload)
      .eq("business_id", businessId)
      .eq("id", existingResult.data.id);
    if (updateResult.error && !isMissingSchemaError(updateResult.error)) throw updateResult.error;
    saved = existingResult.data;
    mutation = "updated";
  } else {
    const insertResult = await db
      .from("job_revenue_evidence")
      .insert(payload)
      .select("id")
      .maybeSingle();
    if (insertResult.error && !isMissingSchemaError(insertResult.error)) throw insertResult.error;
    saved = insertResult.data;
  }
  if (status === "partial") {
    diagnostics.missingRefs.push({ entity: "Deposit", external_id: String(deposit.Id || ""), ref_type: "LinkedTxn", ref_id: linkedPaymentIds.join(",") || null, reason: "deposit_payment_link_incomplete" });
  }
  return { evidence_id: saved?.id || null, mutation, linked: status === "confirmed" ? 1 : 0, partial: status === "partial" ? 1 : 0 };
}

async function fetchEntitiesWithTransport({ qboTransport, entity, since, mode }) {
  if (!qboTransport) return null;
  if (typeof qboTransport.fetchAll === "function") return qboTransport.fetchAll({ entity, since, mode });
  if (typeof qboTransport[entity] === "function") return qboTransport[entity]({ since, mode });
  if (Array.isArray(qboTransport[entity])) return qboTransport[entity];
  return [];
}

export async function runQboJobCostingSync({
  businessId,
  mode = "incremental",
  since = null,
  db = defaultSupabase,
  fetchImpl = fetch,
  qboTransport = null,
  now = new Date(),
} = {}) {
  if (!businessId) throw new Error("businessId is required");

  const diagnostics = {
    missingRefs: [],
    orphanAllocations: [],
    duplicateExternalIds: [],
    reconciliationFailures: [],
  };
  const result = {
    ok: true,
    businessId,
    mode,
    since,
    entityCounts: {},
    ...diagnostics,
  };

  const runner = async (accessToken, context) => {
    const realmId = qboTransport?.realmId || context?.realmId;
    if (!realmId) throw new Error("quickbooks_realm_id_missing");
    result.realmId = realmId;
    const runId = await maybeCreateSyncRun({ db, businessId, realmId, mode, since });

    try {
      const entityRows = {};
      for (const entity of JOB_COSTING_QBO_IMPORT_ORDER) {
        const rows = qboTransport
          ? await fetchEntitiesWithTransport({ qboTransport, entity, since, mode })
          : await fetchAllQboEntities({ realmId, accessToken, entity, since: mode === "incremental" ? since : null, fetchImpl });
        entityRows[entity] = rows || [];
        result.entityCounts[entity] = { ...emptyCounts(), fetched: entityRows[entity].length };
      }

      for (const customer of entityRows.Customer) {
        try {
          const imported = await importCustomer({ db, businessId, realmId, qboCustomer: customer, now });
          increment(result.entityCounts.Customer, imported.mutation || "updated");
        } catch (error) {
          increment(result.entityCounts.Customer, "failed");
          diagnostics.reconciliationFailures.push({ entity: "Customer", external_id: String(customer.Id || ""), error: error.message });
        }
      }

      for (const entity of ["Estimate", "Invoice", "SalesReceipt", "CreditMemo"]) {
        for (const document of entityRows[entity]) {
          try {
            const imported = await importRevenueDocument({ db, businessId, realmId, qboType: entity, document, now, diagnostics });
            increment(result.entityCounts[entity], imported.mutation || "updated");
            if (imported.linked) increment(result.entityCounts[entity], "linked");
          } catch (error) {
            increment(result.entityCounts[entity], "failed");
            diagnostics.reconciliationFailures.push({ entity, external_id: String(document.Id || ""), error: error.message });
          }
        }
      }

      for (const payment of entityRows.Payment) {
        try {
          const imported = await importPayment({ db, businessId, realmId, payment, now, diagnostics });
          increment(result.entityCounts.Payment, imported.mutation || "updated");
          result.entityCounts.Payment.allocations = toNumber(result.entityCounts.Payment.allocations, 0) + imported.allocations;
          result.entityCounts.Payment.orphans = toNumber(result.entityCounts.Payment.orphans, 0) + imported.orphans;
          increment(result.entityCounts.Payment, "linked", imported.linked || 0);
        } catch (error) {
          increment(result.entityCounts.Payment, "failed");
          diagnostics.reconciliationFailures.push({ entity: "Payment", external_id: String(payment.Id || ""), error: error.message });
        }
      }

      for (const deposit of entityRows.Deposit) {
        try {
          const imported = await importDepositEvidence({ db, businessId, realmId, deposit, now, diagnostics });
          increment(result.entityCounts.Deposit, imported.mutation || "updated");
          increment(result.entityCounts.Deposit, "linked", imported.linked || 0);
          result.entityCounts.Deposit.partial = toNumber(result.entityCounts.Deposit.partial, 0) + imported.partial;
        } catch (error) {
          increment(result.entityCounts.Deposit, "failed");
          diagnostics.reconciliationFailures.push({ entity: "Deposit", external_id: String(deposit.Id || ""), error: error.message });
        }
      }

      try {
        result.jobCandidates = await generateJobCandidatesForBusiness({ businessId, realmId, db, now });
      } catch (error) {
        diagnostics.reconciliationFailures.push({ entity: "JobCandidate", error: error.message });
        result.jobCandidates = { ok: false, error: error.message };
      }

      result.missingRefs = diagnostics.missingRefs;
      result.orphanAllocations = diagnostics.orphanAllocations;
      result.duplicateExternalIds = diagnostics.duplicateExternalIds;
      result.reconciliationFailures = diagnostics.reconciliationFailures;
      await maybeFinishSyncRun({ db, runId, status: "succeeded", result });
      return result;
    } catch (error) {
      result.ok = false;
      result.error = error.message;
      await maybeFinishSyncRun({ db, runId, status: "failed", result, error });
      throw error;
    }
  };

  if (qboTransport) {
    return runner(qboTransport.accessToken || "test-token", { realmId: qboTransport.realmId });
  }

  return withQuickBooksAuth(businessId, runner);
}

export async function getQboJobCostingSyncDiagnostics({ businessId, db = defaultSupabase } = {}) {
  if (!businessId) throw new Error("businessId is required");
  const [runs, customers, documents, payments, allocations] = await Promise.all([
    db.from("qbo_entity_sync_runs").select("*").eq("business_id", businessId).order("started_at", { ascending: false }).limit(5),
    db.from("qbo_customers").select("id", { count: "exact", head: true }).eq("business_id", businessId),
    db.from("job_revenue_documents").select("id", { count: "exact", head: true }).eq("business_id", businessId).eq("source_system", "quickbooks"),
    db.from("job_payment_records").select("id", { count: "exact", head: true }).eq("business_id", businessId).eq("source_system", "quickbooks"),
    db.from("job_payment_allocations").select("id", { count: "exact", head: true }).eq("business_id", businessId),
  ]);

  const tableErrors = [runs, customers, documents, payments, allocations]
    .map((item) => item.error)
    .filter((error) => error && !isMissingSchemaError(error));
  if (tableErrors.length) throw tableErrors[0];

  let projectsDiagnostics = null;
  try {
    projectsDiagnostics = await getQboProjectsDiagnostics({ businessId, db });
  } catch (error) {
    projectsDiagnostics = { ok: false, error: error.message };
  }

  return {
    ok: true,
    lastRuns: runs.error ? [] : runs.data || [],
    counts: {
      qboCustomers: customers.count || 0,
      revenueDocuments: documents.count || 0,
      paymentRecords: payments.count || 0,
      paymentAllocations: allocations.count || 0,
      qboProjects: projectsDiagnostics?.counts?.qboProjects || 0,
    },
    projects: projectsDiagnostics,
    limitations: {
      projectsGraphqlEnabled: projectsDiagnostics?.limitations?.graphqlProjectsIntegrationEnabled || false,
      projectsApiAccessChecked: Boolean(projectsDiagnostics?.capability?.checked_at),
      authoritativeInvoiceStore: "job_revenue_documents",
      collectionsOpenItemsStore: "ar_open_items",
    },
  };
}

export function getQboEntityImportKey(qboType, entity) {
  if (!entity?.Id) return null;
  if (qboType === "Payment") return `payment:${entity.Id}`;
  if (qboType === "Customer") return `customer:${entity.Id}`;
  return `${mapQboDocumentType(qboType)}:${entity.Id}`;
}
