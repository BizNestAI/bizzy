import { reconsiderNeedsReviewTransactions } from "./routineExpenseReconsiderationService.js";
import { getBookkeepingStartDate, isTransactionInActiveBookkeepingScope } from "./bookkeepingScope.js";

export const BOOKKEEPING_PROCESSING_STATUSES = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  DEAD_LETTER: "dead_letter",
  SKIPPED: "skipped",
};

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_DISCOVERY_LIMIT = 250;
const STALE_PROCESSING_MINUTES = 10;
const UNRESOLVED_RETRY_COOLDOWN_HOURS = 24;

let deps = {
  runBookkeepingSuggestionPass: async (args) => {
    const mod = await import("../../api/bookkeeping/routes/bookkeeping.suggest.routes.js");
    return mod.runBookkeepingSuggestionPass(args);
  },
  reconsiderNeedsReviewTransactions,
};

export function __setBackgroundBookkeepingProcessingTestDeps(next = {}) {
  deps = { ...deps, ...next };
}

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function uniqueIds(ids = []) {
  return Array.from(new Set((ids || []).map((id) => (id ? String(id) : null)).filter(Boolean)));
}

function retryIso(now, attemptCount) {
  const base = now instanceof Date ? now : new Date(now);
  const delayMs = Math.min(60_000 * 2 ** Math.min(Number(attemptCount || 1), 6), 60 * 60 * 1000);
  return new Date(base.getTime() + delayMs).toISOString();
}

function errorCode(error) {
  return String(error?.code || error?.name || "bookkeeping_processing_failed").slice(0, 120);
}

function errorMessage(error) {
  return String(error?.message || error || "Bookkeeping processing failed.").slice(0, 1000);
}

function hoursFrom(now, hours) {
  const base = now instanceof Date ? now : new Date(now);
  return new Date(base.getTime() + Number(hours || 0) * 60 * 60 * 1000).toISOString();
}

async function getDefaultSupabase() {
  const mod = await import("../supabaseAdmin.js");
  return mod.supabase;
}

function processingEvidenceFingerprint(cat = {}) {
  const meta = cat?.meta || {};
  const parts = [
    cat?.status || "",
    cat?.suggested_qbo_account_id || "",
    cat?.suggested_canonical_account_key || "",
    cat?.final_qbo_account_id || "",
    cat?.final_canonical_account_key || "",
    meta?.canonical_account_key || "",
    meta?.canonical_coa_resolved === true ? "coa_resolved" : "",
    meta?.canonical_coa_revalidation_status || "",
    meta?.canonical_coa_revalidation_reason || "",
    meta?.canonical_account_review_required === true ? "coa_review" : "",
    meta?.canonical_mapping_review_required === true ? "mapping_review" : "",
    meta?.canonical_vendor_id || "",
    meta?.canonical_vendor_reliable === true ? "vendor_reliable" : "",
    meta?.canonical_vendor_resolution_reason || "",
    meta?.post_block_reason || "",
    meta?.auto_handle_decision?.reason || "",
    cat?.updated_at || "",
  ];
  return parts.map((part) => String(part || "")).join("|").slice(0, 1000);
}

function unresolvedBlockReason(cat = {}) {
  const meta = cat?.meta || {};
  return String(
    meta?.auto_handle_decision?.reason ||
    meta?.canonical_coa_revalidation_reason ||
    meta?.canonical_vendor_resolution_reason ||
    meta?.post_block_reason ||
    cat?.post_error ||
    "still_needs_review"
  ).slice(0, 200);
}

function isUnresolvedCategorization(cat = {}) {
  return ["needs_review", "uncategorized", "failed", ""].includes(String(cat?.status || "").toLowerCase()) &&
    !cat?.qbo_txn_id &&
    !cat?.posted_at;
}

async function fetchOwnedTransactionIds({ db, businessId, transactionIds }) {
  const ids = uniqueIds(transactionIds);
  if (!businessId || !ids.length) return [];
  const { data, error } = await db
    .from("bank_transactions")
    .select("id")
    .eq("business_id", businessId)
    .in("id", ids);
  if (error) throw error;
  return (data || []).map((row) => String(row.id));
}

async function assertOwnedTransactionIds({ db, businessId, transactionIds }) {
  const ids = uniqueIds(transactionIds);
  const owned = new Set(await fetchOwnedTransactionIds({ db, businessId, transactionIds: ids }));
  const missing = ids.filter((id) => !owned.has(String(id)));
  if (missing.length) {
    const err = new Error("bookkeeping_queue_transaction_business_mismatch");
    err.transaction_ids = missing;
    throw err;
  }
  return ids;
}

async function updateRequest({ db, requestId, patch }) {
  if (db.store?.bookkeeping_processing_requests) {
    const row = db.store.bookkeeping_processing_requests.find((item) => item.id === requestId);
    if (row) Object.assign(row, patch, { updated_at: patch.updated_at || new Date().toISOString() });
    return row || null;
  }
  const { data, error } = await db
    .from("bookkeeping_processing_requests")
    .update(patch)
    .eq("id", requestId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function insertOrResetRequests({ db, businessId, transactionIds, source = "unknown", priority = 0, now = new Date() }) {
  const ids = await assertOwnedTransactionIds({ db, businessId, transactionIds });
  if (!businessId || !ids.length) return { ok: true, enqueued: 0, transaction_ids: [] };
  const timestamp = nowIso(now);
  const rows = ids.map((transactionId) => ({
    business_id: businessId,
    transaction_id: transactionId,
    scope: "transaction",
    status: BOOKKEEPING_PROCESSING_STATUSES.PENDING,
    priority,
    process_after: timestamp,
    locked_at: null,
    locked_by: null,
    processed_at: null,
    blocked_reason: null,
    evidence_fingerprint: null,
    blocked_until: null,
    error_code: null,
    error_message: null,
    metadata: { source, last_enqueued_at: timestamp },
    updated_at: timestamp,
  }));

  if (db.store) {
    db.store.bookkeeping_processing_requests ||= [];
    let enqueued = 0;
    for (const row of rows) {
      const existing = db.store.bookkeeping_processing_requests.find(
        (item) => item.business_id === row.business_id && item.transaction_id === row.transaction_id
      );
      if (existing) {
        if (existing.status === BOOKKEEPING_PROCESSING_STATUSES.PROCESSING) {
          enqueued += 1;
          continue;
        }
        Object.assign(existing, {
          ...row,
          id: existing.id,
          attempt_count: 0,
          max_attempts: existing.max_attempts || 5,
          created_at: existing.created_at,
        });
      } else {
        db.store.bookkeeping_processing_requests.push({
          id: `bookkeeping_req_${row.transaction_id}`,
          attempt_count: 0,
          max_attempts: 5,
          created_at: timestamp,
          ...row,
        });
      }
      enqueued += 1;
    }
    return { ok: true, enqueued, transaction_ids: ids };
  }

  const { error: insertErr } = await db
    .from("bookkeeping_processing_requests")
    .upsert(rows, { onConflict: "business_id,transaction_id", ignoreDuplicates: true });
  if (insertErr) throw insertErr;

  const resetPatch = {
    status: BOOKKEEPING_PROCESSING_STATUSES.PENDING,
    priority,
    attempt_count: 0,
    process_after: timestamp,
    locked_at: null,
    locked_by: null,
    processed_at: null,
    blocked_reason: null,
    evidence_fingerprint: null,
    blocked_until: null,
    error_code: null,
    error_message: null,
    metadata: { source, last_enqueued_at: timestamp },
    updated_at: timestamp,
  };
  const { error: updateErr } = await db
    .from("bookkeeping_processing_requests")
    .update(resetPatch)
    .eq("business_id", businessId)
    .in("transaction_id", ids)
    .neq("status", BOOKKEEPING_PROCESSING_STATUSES.PROCESSING);
  if (updateErr) throw updateErr;
  return { ok: true, enqueued: ids.length, transaction_ids: ids };
}

export async function enqueueBookkeepingProcessingForTransactions({
  businessId,
  transactionIds = [],
  source = "unknown",
  priority = 0,
  supabase = null,
  now = new Date(),
} = {}) {
  const db = supabase || await getDefaultSupabase();
  return insertOrResetRequests({ db, businessId, transactionIds, source, priority, now });
}

async function claimDueRequests({ db, workerId, batchSize, now }) {
  const nowText = nowIso(now);
  if (typeof db.rpc === "function" && !db.store) {
    const { data, error } = await db.rpc("claim_bookkeeping_processing_requests", {
      p_worker_id: workerId,
      p_batch_size: batchSize,
      p_now: nowText,
    });
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  }

  if (db.store?.bookkeeping_processing_requests) {
    const nowMs = new Date(nowText).getTime();
    const staleMs = nowMs - STALE_PROCESSING_MINUTES * 60 * 1000;
    const claimable = db.store.bookkeeping_processing_requests
      .filter((row) => {
        const status = row.status;
        const due = new Date(row.process_after || nowText).getTime() <= nowMs;
        const attemptsRemain = Number(row.attempt_count || 0) < Number(row.max_attempts || 5);
        const stale =
          status === BOOKKEEPING_PROCESSING_STATUSES.PROCESSING &&
          row.locked_at &&
          new Date(row.locked_at).getTime() < staleMs;
        return due && attemptsRemain && (
          [BOOKKEEPING_PROCESSING_STATUSES.PENDING, BOOKKEEPING_PROCESSING_STATUSES.FAILED].includes(status) ||
          stale
        );
      })
      .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || new Date(a.process_after) - new Date(b.process_after))
      .slice(0, batchSize);
    for (const row of claimable) {
      row.status = BOOKKEEPING_PROCESSING_STATUSES.PROCESSING;
      row.locked_at = nowText;
      row.locked_by = workerId;
      row.attempt_count = Number(row.attempt_count || 0) + 1;
      row.error_code = null;
      row.error_message = null;
      row.updated_at = nowText;
    }
    return claimable.map((row) => ({ ...row }));
  }

  return [];
}

async function markRequestFailed({ db, request, workerId, now, error }) {
  const timestamp = nowIso(now);
  const attempts = Math.max(1, Number(request.attempt_count || 1));
  const dead = attempts >= Number(request.max_attempts || 5);
  return updateRequest({
    db,
    requestId: request.id,
    patch: {
      status: dead ? BOOKKEEPING_PROCESSING_STATUSES.DEAD_LETTER : BOOKKEEPING_PROCESSING_STATUSES.FAILED,
      process_after: retryIso(now, attempts),
      locked_at: null,
      locked_by: null,
      error_code: errorCode(error),
      error_message: errorMessage(error),
      metadata: {
        ...(request.metadata || {}),
        workerId,
        failed_at: timestamp,
      },
      updated_at: timestamp,
    },
  });
}

async function markRequestCompleted({ db, request, workerId, now, suggestion, reconsideration, categorization = null }) {
  const timestamp = nowIso(now);
  const unresolved = isUnresolvedCategorization(categorization);
  return updateRequest({
    db,
    requestId: request.id,
    patch: {
      status: BOOKKEEPING_PROCESSING_STATUSES.COMPLETED,
      processed_at: timestamp,
      locked_at: null,
      locked_by: null,
      blocked_reason: unresolved ? unresolvedBlockReason(categorization) : null,
      evidence_fingerprint: unresolved ? processingEvidenceFingerprint(categorization) : null,
      blocked_until: unresolved ? hoursFrom(now, UNRESOLVED_RETRY_COOLDOWN_HOURS) : null,
      metadata: {
        ...(request.metadata || {}),
        workerId,
        suggestion: {
          updated: suggestion?.updated || 0,
          auto_approved: suggestion?.auto_approved || 0,
          skipped: suggestion?.skipped || 0,
          row_error_count: suggestion?.row_error_count || 0,
        },
        reconsideration: {
          processed: reconsideration?.processed || 0,
          promoted: reconsideration?.promoted || 0,
          skipped: reconsideration?.skipped || 0,
        },
      },
      updated_at: timestamp,
    },
  });
}

async function skipRequest({ db, request, workerId, now, reason }) {
  const timestamp = nowIso(now);
  return updateRequest({
    db,
    requestId: request.id,
    patch: {
      status: BOOKKEEPING_PROCESSING_STATUSES.SKIPPED,
      processed_at: timestamp,
      locked_at: null,
      locked_by: null,
      error_code: reason,
      metadata: {
        ...(request.metadata || {}),
        workerId,
        reason,
      },
      updated_at: timestamp,
    },
  });
}

function isAlreadyHandledOrPosted(existingCat) {
  return (
    ["approved", "auto_approved", "posted"].includes(String(existingCat?.status || "").toLowerCase()) ||
    existingCat?.qbo_txn_id ||
    existingCat?.posted_at
  );
}

export async function processPendingBookkeepingRequests({
  supabase = null,
  workerId = `bookkeeping:${process.env.HOSTNAME || "local"}:${process.pid}`,
  batchSize = DEFAULT_BATCH_SIZE,
  now = new Date(),
} = {}) {
  const db = supabase || await getDefaultSupabase();
  const claimed = await claimDueRequests({
    db,
    workerId,
    batchSize: Math.max(1, Math.min(Number(batchSize || DEFAULT_BATCH_SIZE), 250)),
    now,
  });
  const results = [];
  const processable = [];
  for (const request of claimed) {
    try {
      if (!request.business_id || !request.transaction_id) {
        results.push(await skipRequest({ db, request, workerId, now, reason: "missing_transaction_scope" }));
        continue;
      }

      const { data: existingCat, error: existingCatErr } = await db
        .from("transaction_categorizations")
        .select("status,qbo_txn_id,posted_at")
        .eq("business_id", request.business_id)
        .eq("transaction_id", request.transaction_id)
        .maybeSingle();
      if (existingCatErr) throw existingCatErr;
      if (isAlreadyHandledOrPosted(existingCat)) {
        results.push(await skipRequest({ db, request, workerId, now, reason: "already_handled_or_posted" }));
        continue;
      }
      const owned = await fetchOwnedTransactionIds({
        db,
        businessId: request.business_id,
        transactionIds: [request.transaction_id],
      });
      if (!owned.length) {
        results.push(await skipRequest({ db, request, workerId, now, reason: "transaction_business_mismatch" }));
        continue;
      }
      processable.push(request);
    } catch (error) {
      results.push(await markRequestFailed({ db, request, workerId, now, error }));
    }
  }

  const byBusiness = new Map();
  for (const request of processable) {
    const list = byBusiness.get(request.business_id) || [];
    list.push(request);
    byBusiness.set(request.business_id, list);
  }

  for (const [businessId, requests] of byBusiness.entries()) {
    const transactionIds = requests.map((request) => request.transaction_id).filter(Boolean);
    try {
      const source = requests[0]?.metadata?.source || "background_bookkeeping";
      const suggestion = await deps.runBookkeepingSuggestionPass({
        businessId,
        body: {
          transaction_ids: transactionIds,
          range: "all",
          auto_approve: true,
          source,
          allow_qbo_account_create: false,
        },
      });
      const reconsideration = await deps.reconsiderNeedsReviewTransactions(businessId, {
        db,
        transactionIds,
        range: "all",
        limit: Math.max(1, transactionIds.length),
        source: "background_bookkeeping",
      });
      const { data: refreshedCats, error: refreshedErr } = await db
        .from("transaction_categorizations")
        .select("transaction_id,status,post_error,qbo_txn_id,posted_at,suggested_qbo_account_id,suggested_canonical_account_key,final_qbo_account_id,final_canonical_account_key,meta,updated_at")
        .eq("business_id", businessId)
        .in("transaction_id", transactionIds);
      if (refreshedErr) throw refreshedErr;
      const catByTxnId = new Map((refreshedCats || []).map((cat) => [String(cat.transaction_id), cat]));
      for (const request of requests) {
        results.push(await markRequestCompleted({
          db,
          request,
          workerId,
          now,
          suggestion,
          reconsideration,
          categorization: catByTxnId.get(String(request.transaction_id)) || null,
        }));
      }
    } catch (error) {
      for (const request of requests) {
        results.push(await markRequestFailed({ db, request, workerId, now, error }));
      }
    }
  }
  return {
    ok: true,
    claimed: claimed.length,
    completed: results.filter((row) => row?.status === BOOKKEEPING_PROCESSING_STATUSES.COMPLETED).length,
    failed: results.filter((row) => row?.status === BOOKKEEPING_PROCESSING_STATUSES.FAILED).length,
    dead_letter: results.filter((row) => row?.status === BOOKKEEPING_PROCESSING_STATUSES.DEAD_LETTER).length,
    skipped: results.filter((row) => row?.status === BOOKKEEPING_PROCESSING_STATUSES.SKIPPED).length,
    results,
  };
}

export async function enqueueUnresolvedBookkeepingBacklog({
  businessId,
  supabase = null,
  limit = DEFAULT_DISCOVERY_LIMIT,
  now = new Date(),
} = {}) {
  if (!businessId) return { ok: true, enqueued: 0, transaction_ids: [] };
  const db = supabase || await getDefaultSupabase();
  const max = Math.max(1, Math.min(Number(limit || DEFAULT_DISCOVERY_LIMIT), 1000));

  const { data, error } = await db
    .from("transaction_categorizations")
    .select("transaction_id,status,post_error,qbo_txn_id,posted_at,suggested_qbo_account_id,suggested_canonical_account_key,final_qbo_account_id,final_canonical_account_key,meta,updated_at")
    .eq("business_id", businessId)
    .in("status", ["needs_review", "uncategorized", "failed"])
    .is("qbo_txn_id", null)
    .limit(max);
  if (error) throw error;
  const candidateIds = (data || []).map((row) => row.transaction_id).filter(Boolean);
  if (!candidateIds.length) return { ok: true, enqueued: 0, transaction_ids: [] };
  const bookkeepingStartDate = await getBookkeepingStartDate(db, businessId);
  const { data: bankRows, error: bankErr } = await db
    .from("bank_transactions")
    .select("id,date,pending,is_archived")
    .eq("business_id", businessId)
    .in("id", candidateIds);
  if (bankErr) throw bankErr;
  const eligibleBankIds = new Set(
    (bankRows || [])
      .filter((row) =>
        row?.pending !== true &&
        row?.is_archived !== true &&
        isTransactionInActiveBookkeepingScope(row, bookkeepingStartDate)
      )
      .map((row) => String(row.id))
  );

  const { data: existing, error: existingErr } = await db
    .from("bookkeeping_processing_requests")
    .select("transaction_id,status,locked_at,blocked_until,evidence_fingerprint")
    .eq("business_id", businessId)
    .in("transaction_id", candidateIds);
  if (existingErr) throw existingErr;
  const existingByTxnId = new Map((existing || []).map((row) => [String(row.transaction_id), row]));
  const catByTxnId = new Map((data || []).map((row) => [String(row.transaction_id), row]));
  const nowMs = new Date(nowIso(now)).getTime();
  const transactionIds = candidateIds.filter((id) => {
    if (!eligibleBankIds.has(String(id))) return false;
    const existingRequest = existingByTxnId.get(String(id));
    if (!existingRequest) return true;
    const status = String(existingRequest.status || "").toLowerCase();
    if (["pending", "failed", "processing", "dead_letter"].includes(status)) return false;
    const currentFingerprint = processingEvidenceFingerprint(catByTxnId.get(String(id)) || {});
    const blockedUntilMs = existingRequest.blocked_until ? new Date(existingRequest.blocked_until).getTime() : 0;
    if (blockedUntilMs > nowMs && existingRequest.evidence_fingerprint === currentFingerprint) return false;
    return true;
  });
  return enqueueBookkeepingProcessingForTransactions({
    businessId,
    transactionIds,
    source: "bookkeeping_catchup",
    priority: -1,
    supabase: db,
    now,
  });
}

export async function getBookkeepingProcessingStatus({
  businessId,
  supabase = null,
} = {}) {
  if (!businessId) throw new Error("missing_business_id");
  const db = supabase || await getDefaultSupabase();
  const queuedStatuses = [
    BOOKKEEPING_PROCESSING_STATUSES.PENDING,
    BOOKKEEPING_PROCESSING_STATUSES.PROCESSING,
    BOOKKEEPING_PROCESSING_STATUSES.FAILED,
  ];
  const { data: queued, error: queueErr } = await db
    .from("bookkeeping_processing_requests")
    .select("id,status")
    .eq("business_id", businessId)
    .in("status", queuedStatuses)
    .limit(1000);
  if (queueErr) throw queueErr;
  const { data: unresolved, error: unresolvedErr } = await db
    .from("transaction_categorizations")
    .select("transaction_id")
    .eq("business_id", businessId)
    .in("status", ["needs_review", "uncategorized", "failed"])
    .is("qbo_txn_id", null)
    .limit(1000);
  if (unresolvedErr) throw unresolvedErr;
  return {
    ok: true,
    active_count: queued?.length || 0,
    unresolved_count: unresolved?.length || 0,
    up_to_date: !(queued?.length) && !(unresolved?.length),
  };
}

export async function runBookkeepingProcessingForBusiness({
  businessId,
  transactionIds = [],
  supabase = null,
  batchSize = DEFAULT_BATCH_SIZE,
  workerId,
  now = new Date(),
} = {}) {
  const db = supabase || await getDefaultSupabase();
  if (transactionIds?.length) {
    await enqueueBookkeepingProcessingForTransactions({
      businessId,
      transactionIds,
      source: "direct_processing_request",
      priority: 10,
      supabase: db,
      now,
    });
  } else {
    await enqueueUnresolvedBookkeepingBacklog({ businessId, supabase: db, limit: batchSize, now });
  }
  return processPendingBookkeepingRequests({ supabase: db, workerId, batchSize, now });
}

export default {
  enqueueBookkeepingProcessingForTransactions,
  enqueueUnresolvedBookkeepingBacklog,
  processPendingBookkeepingRequests,
  runBookkeepingProcessingForBusiness,
  getBookkeepingProcessingStatus,
};
