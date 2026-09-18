/* global process */
import { supabase } from "../services/supabaseAdmin.js";
import { postSingleBookkeepingTransactionNow } from "./booksPost.cron.js";
import {
  appendInteractivePostingCommandEvent,
  claimInteractivePostingCommands,
  processInteractivePostingCommand,
} from "../services/bookkeeping/interactivePostingCommandService.js";

const POLL_SECONDS = Number(process.env.INTERACTIVE_POSTING_COMMAND_POLL_SECONDS || 1);
const BATCH_SIZE = Number(process.env.INTERACTIVE_POSTING_COMMAND_BATCH_SIZE || 5);
const DISABLED = String(process.env.DISABLE_INTERACTIVE_POSTING_COMMAND_WORKER || "").toLowerCase() === "true";
const CHANNEL = "bookkeeping_interactive_posting_commands";

let pollTimer = null;
let pollRunning = false;
let listenClient = null;
let listenerStarted = false;

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
  const intervalMs = Math.max(1, POLL_SECONDS) * 1000;
  const tick = () => {
    if (pollRunning) return;
    pollRunning = true;
    runInteractivePostingCommandWorkerOnce()
      .catch((err) => console.warn("[interactive-posting-command-worker] poll failed", err?.message || err))
      .finally(() => {
        pollRunning = false;
      });
  };
  pollTimer = setInterval(tick, intervalMs);
  pollTimer.unref?.();
  tick();
  console.info("[interactive-posting-command-worker] started", {
    interval_seconds: POLL_SECONDS,
    batch_size: BATCH_SIZE,
  });
  return pollTimer;
}

export async function stopInteractivePostingCommandWorker() {
  if (pollTimer) clearInterval(pollTimer);
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
};
