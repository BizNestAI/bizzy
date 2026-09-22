/* global process */
import { supabase } from "../services/supabaseAdmin.js";
import { postSingleBookkeepingTransactionNow } from "./booksPost.cron.js";
import {
  appendInteractivePostingCommandEvent,
  claimInteractivePostingCommands,
  processInteractivePostingCommand,
} from "../services/bookkeeping/interactivePostingCommandService.js";
import {
  isMissingInteractivePostingCommandRpcError,
  nextInteractivePostingPollDelayMs,
} from "./interactivePostingCommandWorkerDiagnostics.js";

const POLL_SECONDS = Number(process.env.INTERACTIVE_POSTING_COMMAND_POLL_SECONDS || 1);
const MAX_BACKOFF_SECONDS = Number(process.env.INTERACTIVE_POSTING_COMMAND_MAX_BACKOFF_SECONDS || 300);
const BATCH_SIZE = Number(process.env.INTERACTIVE_POSTING_COMMAND_BATCH_SIZE || 5);
const DISABLED = String(process.env.DISABLE_INTERACTIVE_POSTING_COMMAND_WORKER || "").toLowerCase() === "true";
const CHANNEL = "bookkeeping_interactive_posting_commands";

let pollTimer = null;
let pollRunning = false;
let listenClient = null;
let listenerStarted = false;
let missingRpcLogged = false;
let consecutiveMissingRpcFailures = 0;
const directWakeups = new Map();
let directWakeScheduled = false;
let directWakeRunning = false;

const workerHealth = {
  ok: true,
  degraded: false,
  reason: null,
  last_error: null,
  last_error_code: null,
  last_error_at: null,
  consecutive_missing_rpc_failures: 0,
  next_poll_delay_ms: null,
};

export function getInteractivePostingCommandWorkerHealth() {
  return { ...workerHealth };
}

export function resetInteractivePostingCommandWorkerDiagnosticsForTest() {
  missingRpcLogged = false;
  consecutiveMissingRpcFailures = 0;
  Object.assign(workerHealth, {
    ok: true,
    degraded: false,
    reason: null,
    last_error: null,
    last_error_code: null,
    last_error_at: null,
    consecutive_missing_rpc_failures: 0,
    next_poll_delay_ms: null,
  });
}

function workerId() {
  return `interactive-posting:${process.env.RAILWAY_SERVICE_NAME || process.env.HOSTNAME || "worker"}:${process.pid}`;
}

async function processExactOperation(operationId) {
  if (!operationId) return { ok: true, skipped: true, reason: "missing_operation_id" };
  return processInteractivePostingCommand({
    db: supabase,
    operationId,
    workerId: workerId(),
    postTransactionNow: postSingleBookkeepingTransactionNow,
  });
}

async function drainDirectWakeups() {
  if (directWakeRunning) return;
  directWakeRunning = true;
  directWakeScheduled = false;
  try {
    while (directWakeups.size) {
      const [operationId, wake] = directWakeups.entries().next().value;
      directWakeups.delete(operationId);
      const queueWaitMs = Math.max(0, Date.now() - wake.enqueuedAtMs);
      console.info("[interactive-posting-command-worker] direct wake claimed", {
        operation_id: operationId,
        correlation_id: wake.correlationId || null,
        queue_wait_ms: queueWaitMs,
      });
      await appendInteractivePostingCommandEvent({
        db: supabase,
        operationId,
        event: "approval_claimed",
        extra: { correlation_id: wake.correlationId || null, queue_wait_ms: queueWaitMs, wake_source: "http_acceptance" },
      }).catch(() => null);
      await processExactOperation(operationId).catch((err) => {
        console.warn("[interactive-posting-command-worker] direct wake processing failed; periodic recovery remains active", {
          operation_id: operationId,
          correlation_id: wake.correlationId || null,
          queue_wait_ms: queueWaitMs,
          message: err?.message || String(err),
        });
      });
    }
  } finally {
    directWakeRunning = false;
    if (directWakeups.size) scheduleDirectWakeDrain();
  }
}

function scheduleDirectWakeDrain() {
  if (directWakeScheduled || directWakeRunning) return;
  directWakeScheduled = true;
  queueMicrotask(() => drainDirectWakeups().catch((err) => {
    directWakeScheduled = false;
    directWakeRunning = false;
    console.warn("[interactive-posting-command-worker] direct wake drain failed; periodic recovery remains active", err?.message || err);
  }));
}

export function signalInteractivePostingCommandWakeup({ operationId, correlationId = null } = {}) {
  if (!operationId) return { queued: false, reason: "missing_operation_id" };
  if (!directWakeups.has(operationId)) {
    directWakeups.set(operationId, { correlationId, enqueuedAtMs: Date.now() });
  }
  scheduleDirectWakeDrain();
  return { queued: true, operation_id: operationId, wake_source: "http_acceptance" };
}

export async function runInteractivePostingCommandWorkerOnce({ operationId = null, batchSize = BATCH_SIZE } = {}) {
  if (operationId) return processExactOperation(operationId);
  const claimed = await claimInteractivePostingCommands({
    db: supabase,
    workerId: workerId(),
    batchSize,
  });
  const results = [];
  for (const command of claimed || []) {
    results.push(await processInteractivePostingCommand({
      db: supabase,
      operationId: command.operation_id,
      workerId: workerId(),
      postTransactionNow: postSingleBookkeepingTransactionNow,
      claimedCommand: command,
    }));
  }
  return { ok: true, claimed: claimed?.length || 0, results };
}

function markWorkerHealthy() {
  missingRpcLogged = false;
  consecutiveMissingRpcFailures = 0;
  Object.assign(workerHealth, {
    ok: true,
    degraded: false,
    reason: null,
    last_error: null,
    last_error_code: null,
    last_error_at: null,
    consecutive_missing_rpc_failures: 0,
    next_poll_delay_ms: Math.max(1, POLL_SECONDS) * 1000,
  });
}

function handlePollFailure(err) {
  if (!isMissingInteractivePostingCommandRpcError(err)) {
    console.warn("[interactive-posting-command-worker] poll failed", err?.message || err);
    workerHealth.ok = false;
    workerHealth.degraded = true;
    workerHealth.reason = "poll_failed";
    workerHealth.last_error = err?.message || String(err);
    workerHealth.last_error_code = err?.code || err?.status || null;
    workerHealth.last_error_at = new Date().toISOString();
    workerHealth.next_poll_delay_ms = Math.max(1, POLL_SECONDS) * 1000;
    return workerHealth.next_poll_delay_ms;
  }

  consecutiveMissingRpcFailures += 1;
  const delayMs = nextInteractivePostingPollDelayMs(consecutiveMissingRpcFailures, {
    baseSeconds: POLL_SECONDS,
    maxSeconds: MAX_BACKOFF_SECONDS,
  });
  Object.assign(workerHealth, {
    ok: false,
    degraded: true,
    reason: "missing_interactive_posting_claim_rpc",
    last_error: err?.message || String(err),
    last_error_code: err?.code || err?.status || null,
    last_error_at: new Date().toISOString(),
    consecutive_missing_rpc_failures: consecutiveMissingRpcFailures,
    next_poll_delay_ms: delayMs,
  });
  const payload = {
    severity: "critical",
    reason: workerHealth.reason,
    message: workerHealth.last_error,
    code: workerHealth.last_error_code,
    consecutive_failures: consecutiveMissingRpcFailures,
    next_poll_delay_ms: delayMs,
  };
  if (!missingRpcLogged) {
    console.error("[interactive-posting-command-worker] configuration error", payload);
    missingRpcLogged = true;
  } else {
    console.warn("[interactive-posting-command-worker] poll degraded; backing off", {
      reason: payload.reason,
      consecutive_failures: payload.consecutive_failures,
      next_poll_delay_ms: payload.next_poll_delay_ms,
    });
  }
  return delayMs;
}

async function startPgListener() {
  if (listenerStarted) return;
  listenerStarted = true;
  const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.POSTGRES_URL || "";
  if (!connectionString) {
    console.info("[interactive-posting-command-worker] LISTEN disabled; no direct Postgres connection URL configured");
    return;
  }
  try {
    const pg = await import("pg");
    const Client = pg.default?.Client || pg.Client;
    listenClient = new Client({ connectionString, application_name: "bizzi_interactive_posting_commands" });
    await listenClient.connect();
    await listenClient.query(`LISTEN ${CHANNEL}`);
    listenClient.on("notification", (message) => {
      const operationId = String(message?.payload || "").trim();
      if (!operationId) return;
      appendInteractivePostingCommandEvent({
        db: supabase,
        operationId,
        event: "notification_received",
      }).catch(() => null);
      processExactOperation(operationId).catch((err) => {
        console.warn("[interactive-posting-command-worker] notification processing failed", {
          operation_id: operationId,
          message: err?.message || String(err),
        });
      });
    });
    listenClient.on("error", (err) => {
      console.warn("[interactive-posting-command-worker] LISTEN error; polling fallback remains active", err?.message || err);
    });
    console.info("[interactive-posting-command-worker] LISTEN started", { channel: CHANNEL });
  } catch (err) {
    console.info("[interactive-posting-command-worker] LISTEN unavailable; polling fallback remains active", {
      reason: err?.code || err?.message || String(err),
    });
  }
}

export function startInteractivePostingCommandWorker() {
  if (pollTimer) return pollTimer;
  if (DISABLED) {
    console.info("[interactive-posting-command-worker] disabled via env");
    return null;
  }
  startPgListener().catch((err) => {
    console.warn("[interactive-posting-command-worker] listener startup failed", err?.message || err);
  });
  const baseIntervalMs = Math.max(1, POLL_SECONDS) * 1000;
  const scheduleNext = (delayMs = baseIntervalMs) => {
    const nextDelayMs = delayMs === 0 ? 0 : Math.max(baseIntervalMs, delayMs);
    pollTimer = setTimeout(tick, nextDelayMs);
    pollTimer.unref?.();
  };
  const tick = () => {
    if (pollRunning) {
      scheduleNext(baseIntervalMs);
      return;
    }
    pollRunning = true;
    runInteractivePostingCommandWorkerOnce()
      .then(() => {
        markWorkerHealthy();
        scheduleNext(baseIntervalMs);
      })
      .catch((err) => {
        const delayMs = handlePollFailure(err);
        scheduleNext(delayMs);
      })
      .finally(() => {
        pollRunning = false;
      });
  };
  scheduleNext(0);
  console.info("[interactive-posting-command-worker] started", {
    interval_seconds: POLL_SECONDS,
    batch_size: BATCH_SIZE,
  });
  return pollTimer;
}

export async function stopInteractivePostingCommandWorker() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  if (listenClient) {
    await listenClient.end().catch(() => null);
    listenClient = null;
  }
  listenerStarted = false;
}

export default {
  startInteractivePostingCommandWorker,
  stopInteractivePostingCommandWorker,
  runInteractivePostingCommandWorkerOnce,
  signalInteractivePostingCommandWakeup,
};
