/* global process */
import crypto from "crypto";
import {
  runMerchantBacklogApprovalOperation,
  markMerchantBacklogApprovalOperationFailed,
} from "./autoPostControl.js";

export const INTERACTIVE_POSTING_COMMAND_TYPE = "interactive_transaction_post";
export const INTERACTIVE_COMMAND_STATES = Object.freeze({
  ACCEPTED: "accepted",
  CLAIMED: "claimed",
  PROCESSING: "processing",
  POSTING: "posting",
  POSTED: "posted",
  RETRYABLE_FAILURE: "retryable_failure",
  BLOCKED: "blocked",
  FAILED: "failed",
});

const TERMINAL_STATES = new Set([
  INTERACTIVE_COMMAND_STATES.POSTED,
  INTERACTIVE_COMMAND_STATES.BLOCKED,
  INTERACTIVE_COMMAND_STATES.FAILED,
]);

const ACTIVE_STATES = new Set([
  INTERACTIVE_COMMAND_STATES.ACCEPTED,
  INTERACTIVE_COMMAND_STATES.CLAIMED,
  INTERACTIVE_COMMAND_STATES.PROCESSING,
  INTERACTIVE_COMMAND_STATES.POSTING,
  INTERACTIVE_COMMAND_STATES.RETRYABLE_FAILURE,
]);

let defaultSupabasePromise = null;
let duplicatePreflightFactoryPromise = null;

async function getDefaultSupabase() {
  defaultSupabasePromise ||= import("../supabaseAdmin.js").then((module) => module.supabase);
  return defaultSupabasePromise;
}

async function getDefaultDuplicatePreflight() {
  duplicatePreflightFactoryPromise ||= import("./qboDuplicatePreflightService.js").then((module) => module.createCachedLiveDuplicatePreflight);
  const createCachedLiveDuplicatePreflight = await duplicatePreflightFactoryPromise;
  return createCachedLiveDuplicatePreflight();
}

function serviceIdentity() {
  return `${process.env.RAILWAY_SERVICE_NAME || process.env.HOSTNAME || "interactive-posting"}:${process.pid || "worker"}`;
}

function deploymentSha() {
  return process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || null;
}

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function stableOperationHash(input = {}) {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function uniqueSortedIds(ids = []) {
  return Array.from(new Set((ids || []).filter(Boolean).map(String))).sort();
}

function sanitizeMessage(value = "") {
  return String(value || "Posting could not finish.").replace(/\s+/g, " ").slice(0, 500);
}

function tableStore(db, table) {
  if (!db?.store) return null;
  db.store[table] ||= [];
  return db.store[table];
}

export function buildInteractivePostingOperationId({
  businessId,
  transactionIds = [],
  selectedQboAccountId,
  idempotencyKey = null,
} = {}) {
  const ids = uniqueSortedIds(transactionIds);
  return stableOperationHash({
    type: INTERACTIVE_POSTING_COMMAND_TYPE,
    business_id: businessId || null,
    transaction_ids: ids,
    selected_qbo_account_id: selectedQboAccountId ? String(selectedQboAccountId) : null,
    idempotency_key: idempotencyKey || ids.join(","),
  });
}

function timelineEvent({ command, event, at = new Date(), extra = {} }) {
  const acceptedAt = Date.parse(command?.requested_at || command?.created_at || "");
  const eventAt = nowIso(at);
  return {
    event,
    operation_id: command?.operation_id || null,
    business_id: command?.business_id || null,
    transaction_ids: Array.isArray(command?.transaction_ids) ? command.transaction_ids : [],
    timestamp: eventAt,
    elapsed_ms: Number.isFinite(acceptedAt) ? Math.max(0, Date.parse(eventAt) - acceptedAt) : null,
    service: serviceIdentity(),
    deployment_sha: deploymentSha(),
    lease_attempt: command?.attempt_count ?? null,
    ...extra,
  };
}

export async function appendInteractivePostingCommandEvent({
  db = null,
  operationId,
  event,
  extra = {},
  at = new Date(),
} = {}) {
  db ||= await getDefaultSupabase();
  if (!db || !operationId || !event) return null;
  const current = await fetchInteractivePostingCommand({ db, operationId, maybe: true });
  if (!current) return null;
  const nextEvent = timelineEvent({ command: current, event, at, extra });
  const nextTimeline = [...(Array.isArray(current.event_timeline) ? current.event_timeline : []), nextEvent];
  await updateInteractiveCommand({
    db,
    operationId,
    patch: { event_timeline: nextTimeline },
  });
  console.info("[interactive-posting-command]", nextEvent);
  return nextEvent;
}

async function fetchQboAccount(db, businessId, selectedQboAccountId) {
  if (!selectedQboAccountId) return null;
  if (db.store?.qbo_accounts) {
    return db.store.qbo_accounts.find(
      (row) => row.business_id === businessId && String(row.qbo_account_id) === String(selectedQboAccountId)
    ) || null;
  }
  const { data, error } = await db
    .from("qbo_accounts")
    .select("qbo_account_id,name,account_type,active")
    .eq("business_id", businessId)
    .eq("qbo_account_id", String(selectedQboAccountId))
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function createInteractivePostingCommand({
  db = null,
  businessId,
  actorId = null,
  selectedQboAccountId,
  selectedQboAccountName = null,
  selectedQboAccountType = null,
  merchantSnapshot = {},
  rememberForFuture = true,
  groupSnapshotToken = null,
  transactionIds = [],
  expectedRowVersions = {},
  idempotencyKey = null,
  requestedAt = new Date(),
} = {}) {
  db ||= await getDefaultSupabase();
  const ids = uniqueSortedIds(transactionIds);
  if (!db) {
    const err = new Error("db is required.");
    err.status = 400;
    err.code = "missing_db";
    throw err;
  }
  if (!businessId) {
    const err = new Error("Missing business id.");
    err.status = 400;
    err.code = "missing_business_id";
    throw err;
  }
  if (!ids.length) {
    const err = new Error("No transactions selected.");
    err.status = 400;
    err.code = "interactive_posting_empty_selection";
    throw err;
  }
  if (!selectedQboAccountId) {
    const err = new Error("Missing selected account.");
    err.status = 400;
    err.code = "interactive_posting_missing_account";
    throw err;
  }

  const operationId = buildInteractivePostingOperationId({
    businessId,
    transactionIds: ids,
    selectedQboAccountId,
    idempotencyKey,
  });
  const requestedIso = nowIso(requestedAt);
  const account = await fetchQboAccount(db, businessId, selectedQboAccountId);
  const snapshot = {
    ...(merchantSnapshot || {}),
    group_snapshot_token: groupSnapshotToken || merchantSnapshot?.group_snapshot_token || null,
  };
  const command = {
    operation_id: operationId,
    business_id: businessId,
    command_type: INTERACTIVE_POSTING_COMMAND_TYPE,
    transaction_ids: ids,
    selected_qbo_account_id: String(selectedQboAccountId),
    selected_qbo_account_name: selectedQboAccountName || account?.name || null,
    selected_qbo_account_type: selectedQboAccountType || account?.account_type || null,
    merchant_snapshot: snapshot,
    expected_row_versions: expectedRowVersions || {},
    remember_for_future: rememberForFuture !== false,
    actor_id: actorId || null,
    idempotency_key: idempotencyKey || null,
    requested_at: requestedIso,
    state: INTERACTIVE_COMMAND_STATES.ACCEPTED,
    stage: INTERACTIVE_COMMAND_STATES.ACCEPTED,
    stage_started_at: requestedIso,
    event_timeline: [],
    created_at: requestedIso,
    updated_at: requestedIso,
  };
  command.event_timeline = [timelineEvent({ command, event: "command_accept_started", at: requestedIso })];

  if (db.store) {
    const rows = tableStore(db, "bookkeeping_interactive_posting_commands");
    const existing = rows.find((row) => row.operation_id === operationId);
    if (existing) return { ok: true, reused: true, command: { ...existing }, operation_id: operationId };
    rows.push({ ...command });
    const stored = rows.find((row) => row.operation_id === operationId);
    stored.event_timeline.push(timelineEvent({ command: stored, event: "command_committed", at: requestedIso }));
    return { ok: true, reused: false, command: { ...stored }, operation_id: operationId };
  }

  const { data, error } = await db
    .from("bookkeeping_interactive_posting_commands")
    .insert(command)
    .select("*")
    .maybeSingle();
  if (error) {
    const duplicate = String(error?.code || "") === "23505" || /duplicate key/i.test(String(error?.message || ""));
    if (!duplicate) throw error;
    const existing = await fetchInteractivePostingCommand({ db, operationId });
    return { ok: true, reused: true, command: existing, operation_id: operationId };
  }
  await appendInteractivePostingCommandEvent({ db, operationId, event: "command_committed", at: requestedIso });
  await appendInteractivePostingCommandEvent({ db, operationId, event: "worker_notified", at: new Date() });
  return { ok: true, reused: false, command: data, operation_id: operationId };
}

export async function fetchInteractivePostingCommand({ db = null, operationId, businessId = null, maybe = false } = {}) {
  db ||= await getDefaultSupabase();
  if (!operationId) return null;
  if (db.store) {
    const rows = tableStore(db, "bookkeeping_interactive_posting_commands");
    const row = rows.find((item) => item.operation_id === operationId && (!businessId || item.business_id === businessId));
    if (!row && !maybe) {
      const err = new Error("interactive_posting_command_not_found");
      err.status = 404;
      throw err;
    }
    return row ? { ...row } : null;
  }
  let query = db.from("bookkeeping_interactive_posting_commands").select("*").eq("operation_id", operationId);
  if (businessId) query = query.eq("business_id", businessId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data && !maybe) {
    const err = new Error("interactive_posting_command_not_found");
    err.status = 404;
    throw err;
  }
  return data || null;
}

async function updateInteractiveCommand({ db = null, operationId, patch = {}, states = null } = {}) {
  db ||= await getDefaultSupabase();
  const nextPatch = { ...patch, updated_at: patch.updated_at || nowIso() };
  if (db.store) {
    const rows = tableStore(db, "bookkeeping_interactive_posting_commands");
    const row = rows.find((item) => item.operation_id === operationId);
    if (!row) return null;
    if (states && !states.includes(row.state)) return null;
    Object.assign(row, nextPatch);
    return { ...row };
  }
  let query = db.from("bookkeeping_interactive_posting_commands").update(nextPatch).eq("operation_id", operationId);
  if (states?.length) query = query.in("state", states);
  const { data, error } = await query.select("*").maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function claimInteractivePostingCommand({
  db = null,
  operationId,
  workerId = serviceIdentity(),
  now = new Date(),
  leaseSeconds = 120,
} = {}) {
  db ||= await getDefaultSupabase();
  const nowText = nowIso(now);
  if (db.store) {
    const rows = tableStore(db, "bookkeeping_interactive_posting_commands");
    const row = rows.find((item) => item.operation_id === operationId);
    if (!row) return null;
    const leaseExpired = !row.lease_expires_at || Date.parse(row.lease_expires_at) <= Date.parse(nowText);
    const retryDue = !row.next_attempt_at || Date.parse(row.next_attempt_at) <= Date.parse(nowText);
    if (!ACTIVE_STATES.has(row.state) || !leaseExpired || !retryDue) return null;
    row.state = INTERACTIVE_COMMAND_STATES.CLAIMED;
    row.stage = INTERACTIVE_COMMAND_STATES.CLAIMED;
    row.stage_started_at = nowText;
    row.claimed_at ||= nowText;
    row.lease_owner = workerId;
    row.lease_expires_at = new Date(Date.parse(nowText) + leaseSeconds * 1000).toISOString();
    row.attempt_count = Number(row.attempt_count || 0) + 1;
    row.last_heartbeat_at = nowText;
    row.failure_code = null;
    row.failure_message = null;
    row.updated_at = nowText;
    row.event_timeline = [...(row.event_timeline || []), timelineEvent({ command: row, event: "claim_succeeded", at: nowText })];
    return { ...row };
  }
  const { data, error } = await db.rpc("claim_bookkeeping_interactive_posting_command", {
    p_operation_id: operationId,
    p_worker_id: workerId,
    p_now: nowText,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw error;
  const command = Array.isArray(data) ? data[0] : data;
  if (!command?.operation_id) return null;
  await appendInteractivePostingCommandEvent({ db, operationId, event: "claim_succeeded", at: nowText });
  return command;
}

export async function claimInteractivePostingCommands({
  db = null,
  workerId = serviceIdentity(),
  batchSize = 5,
  now = new Date(),
  leaseSeconds = 120,
} = {}) {
  db ||= await getDefaultSupabase();
  const nowText = nowIso(now);
  if (db.store) {
    const rows = tableStore(db, "bookkeeping_interactive_posting_commands")
      .filter((row) => ACTIVE_STATES.has(row.state))
      .sort((a, b) => String(a.next_attempt_at || a.created_at).localeCompare(String(b.next_attempt_at || b.created_at)))
      .slice(0, Math.max(1, batchSize));
    const claimed = [];
    for (const row of rows) {
      const command = await claimInteractivePostingCommand({ db, operationId: row.operation_id, workerId, now, leaseSeconds });
      if (command) claimed.push(command);
    }
    return claimed;
  }
  const { data, error } = await db.rpc("claim_bookkeeping_interactive_posting_commands", {
    p_worker_id: workerId,
    p_batch_size: batchSize,
    p_now: nowText,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function setCommandStage({ db, command, state, stage = state, extra = {}, event = null } = {}) {
  const at = nowIso();
  const terminal = TERMINAL_STATES.has(state);
  const next = await updateInteractiveCommand({
    db,
    operationId: command.operation_id,
    patch: {
      state,
      stage,
      stage_started_at: at,
      last_heartbeat_at: at,
      lease_expires_at: terminal ? null : command.lease_expires_at || null,
      terminal_at: terminal ? at : null,
      ...extra,
    },
  });
  if (event) await appendInteractivePostingCommandEvent({ db, operationId: command.operation_id, event, at });
  return next || { ...command, state, stage, ...extra };
}

async function fetchReceiptRows(db, businessId, transactionIds) {
  if (db.store?.qbo_posted_transactions) {
    return db.store.qbo_posted_transactions.filter(
      (row) => row.business_id === businessId && transactionIds.includes(String(row.transaction_id)) && row.status === "posted"
    );
  }
  const { data, error } = await db
    .from("qbo_posted_transactions")
    .select("id,transaction_id,status,qbo_txn_id,qbo_txn_type,posted_at")
    .eq("business_id", businessId)
    .in("transaction_id", transactionIds)
    .eq("status", "posted");
  if (error) throw error;
  return data || [];
}

export async function processInteractivePostingCommand({
  db = null,
  operationId,
  workerId = serviceIdentity(),
  duplicatePreflight = null,
  postTransactionNow,
  claimedCommand = null,
  runApprovalOperation = runMerchantBacklogApprovalOperation,
} = {}) {
  db ||= await getDefaultSupabase();
  if (!duplicatePreflight && runApprovalOperation === runMerchantBacklogApprovalOperation) {
    duplicatePreflight = await getDefaultDuplicatePreflight();
  }
  if (!operationId) return { ok: false, claimed: false, reason: "missing_operation_id" };
  const claimed = claimedCommand?.operation_id === operationId
    ? claimedCommand
    : await claimInteractivePostingCommand({ db, operationId, workerId });
  if (!claimed) return { ok: true, claimed: false, operation_id: operationId };
  let command = claimed;
  const transactionIds = uniqueSortedIds(command.transaction_ids);
  try {
    await appendInteractivePostingCommandEvent({ db, operationId, event: "notification_received" });
    command = await setCommandStage({ db, command, state: INTERACTIVE_COMMAND_STATES.PROCESSING, stage: "validation", event: "validation_completed" });
    const decision = await runApprovalOperation({
      db,
      businessId: command.business_id,
      actorId: command.actor_id,
      selectedQboAccountId: command.selected_qbo_account_id,
      rememberForFuture: command.remember_for_future,
      groupSnapshotToken: command.merchant_snapshot?.group_snapshot_token || null,
      transactionIds,
      exclusionIds: Array.isArray(command.merchant_snapshot?.exclusion_ids) ? command.merchant_snapshot.exclusion_ids : [],
      expectedRowVersions: command.expected_row_versions || {},
      idempotencyKey: command.idempotency_key,
      duplicatePreflight,
      graceHours: 0,
      operationId: command.operation_id,
    });
    await appendInteractivePostingCommandEvent({ db, operationId, event: "decision_saved", extra: { blocked_count: decision.blocked_count || 0 } });
    await appendInteractivePostingCommandEvent({ db, operationId, event: "duplicate_preflight_completed" });
    const blocked = Array.isArray(decision.blocked) ? decision.blocked : [];
    const readyRows = [
      ...(Array.isArray(decision.scheduled) ? decision.scheduled : []),
    ].filter((row) => row?.transaction_id && !blocked.some((blockedRow) => blockedRow.transaction_id === row.transaction_id));

    if (!readyRows.length) {
      const reason = blocked[0]?.reason || "interactive_posting_no_rows_ready";
      await markMerchantBacklogApprovalOperationFailed({
        db,
        businessId: command.business_id,
        operationId,
        transactionIds,
        reasonCode: reason,
        message: reason,
      });
      await setCommandStage({
        db,
        command,
        state: INTERACTIVE_COMMAND_STATES.BLOCKED,
        stage: INTERACTIVE_COMMAND_STATES.BLOCKED,
        extra: { failure_code: reason, failure_message: sanitizeMessage(reason) },
      });
      return { ok: false, operation_id: operationId, blocked, reason };
    }

    const poster = postTransactionNow || (async () => {
      throw new Error("interactive_posting_missing_poster");
    });
    const postedIds = [];
    for (const row of readyRows) {
      command = await setCommandStage({ db, command, state: INTERACTIVE_COMMAND_STATES.POSTING, stage: "posting" });
      await appendInteractivePostingCommandEvent({ db, operationId, event: "qbo_create_started", extra: { transaction_id: row.transaction_id } });
      const result = await poster({
        businessId: command.business_id,
        transactionId: row.transaction_id,
        confirmPostAnyway: false,
      });
      await appendInteractivePostingCommandEvent({
        db,
        operationId,
        event: "qbo_create_completed",
        extra: { transaction_id: row.transaction_id, qbo_txn_id: result?.qbo_txn_id || null },
      });
      if (result?.ok !== true || !result.qbo_txn_id) {
        const err = new Error(result?.error || "interactive_posting_no_receipt");
        err.code = "interactive_posting_no_receipt";
        throw err;
      }
      postedIds.push(row.transaction_id);
    }
    const receipts = await fetchReceiptRows(db, command.business_id, transactionIds);
    const receiptIds = receipts.map((row) => row.id).filter(Boolean);
    await appendInteractivePostingCommandEvent({ db, operationId, event: "receipt_persisted", extra: { receipt_count: receiptIds.length } });
    command = await setCommandStage({
      db,
      command,
      state: INTERACTIVE_COMMAND_STATES.POSTED,
      stage: INTERACTIVE_COMMAND_STATES.POSTED,
      event: "operation_posted",
      extra: {
        posted_transaction_ids: postedIds,
        qbo_receipt_ids: receiptIds,
        failure_code: null,
        failure_message: null,
      },
    });
    return { ok: true, operation_id: operationId, posted_transaction_ids: postedIds, qbo_receipt_ids: receiptIds, command };
  } catch (err) {
    const code = err?.code || err?.message || "interactive_posting_failed";
    await markMerchantBacklogApprovalOperationFailed({
      db,
      businessId: command.business_id,
      operationId,
      transactionIds,
      reasonCode: code,
      message: err?.message || String(err),
    }).catch(() => null);
    await setCommandStage({
      db,
      command,
      state: INTERACTIVE_COMMAND_STATES.FAILED,
      stage: INTERACTIVE_COMMAND_STATES.FAILED,
      extra: { failure_code: code, failure_message: sanitizeMessage(err?.message || code) },
    });
    return { ok: false, operation_id: operationId, error: code, message: sanitizeMessage(err?.message || code) };
  }
}

export async function getInteractivePostingCommandStatus({ db = null, businessId, operationId } = {}) {
  db ||= await getDefaultSupabase();
  const command = await fetchInteractivePostingCommand({ db, businessId, operationId });
  const selectedIds = uniqueSortedIds(command.transaction_ids);
  const receipts = await fetchReceiptRows(db, businessId, selectedIds);
  const receiptTransactionIds = new Set(receipts.map((row) => String(row.transaction_id)));
  const postedTransactionIds = selectedIds.filter((id) => receiptTransactionIds.has(id));
  const terminal = TERMINAL_STATES.has(command.state);
  const active = !terminal;
  return {
    ok: true,
    operation_id: operationId,
    row_count: selectedIds.length,
    command_type: command.command_type,
    state: command.state,
    stage: command.stage,
    states: { [command.state]: selectedIds.length },
    terminal,
    active,
    stale: false,
    last_update_at: command.updated_at || null,
    selected_transaction_ids: selectedIds,
    posted_transaction_ids: postedTransactionIds,
    blocked_transaction_ids: command.state === INTERACTIVE_COMMAND_STATES.BLOCKED ? selectedIds.filter((id) => !receiptTransactionIds.has(id)) : [],
    failed_transaction_ids: command.state === INTERACTIVE_COMMAND_STATES.FAILED ? selectedIds.filter((id) => !receiptTransactionIds.has(id)) : [],
    failure_code: command.failure_code || null,
    failure_message: command.failure_message || null,
    user_message: buildInteractiveCommandUserMessage({ command, selectedIds, postedTransactionIds }),
    event_timeline: command.event_timeline || [],
    rows: selectedIds.map((id) => ({
      transaction_id: id,
      state: receiptTransactionIds.has(id) ? "posted" : command.state,
      stage: receiptTransactionIds.has(id) ? "posted" : command.stage,
      posted: receiptTransactionIds.has(id),
      updated_at: command.updated_at || null,
      requested_at: command.requested_at || null,
      claimed_at: command.claimed_at || null,
      lease_expires_at: command.lease_expires_at || null,
      failure_code: command.failure_code || null,
      failure_message: command.failure_message || null,
      qbo_txn_id: receipts.find((row) => String(row.transaction_id) === id)?.qbo_txn_id || null,
    })),
  };
}

function buildInteractiveCommandUserMessage({ command, selectedIds, postedTransactionIds }) {
  if (postedTransactionIds.length > 0 && postedTransactionIds.length === selectedIds.length) {
    return postedTransactionIds.length === 1 ? "1 transaction posted to QuickBooks." : `${postedTransactionIds.length} transactions posted to QuickBooks.`;
  }
  if (command.state === INTERACTIVE_COMMAND_STATES.BLOCKED) return "Posting needs attention before it can continue.";
  if (command.state === INTERACTIVE_COMMAND_STATES.FAILED) return "Posting could not finish. Review the transaction and retry when safe.";
  if (command.state === INTERACTIVE_COMMAND_STATES.RETRYABLE_FAILURE) return "Posting will retry automatically.";
  return "Posting to QuickBooks.";
}
