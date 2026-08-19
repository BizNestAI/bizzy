import { supabase } from "../services/supabaseAdmin.js";
import {
  enqueueUnresolvedBookkeepingBacklog,
  processPendingBookkeepingRequests,
} from "../services/bookkeeping/backgroundBookkeepingProcessingService.js";

const DISABLED = String(process.env.DISABLE_BOOKKEEPING_PROCESSING_WORKER || "").toLowerCase() === "true";
const INTERVAL_MINUTES = Number(process.env.BOOKKEEPING_PROCESSING_WORKER_INTERVAL_MINUTES || 5);
const BATCH_SIZE = Number(process.env.BOOKKEEPING_PROCESSING_WORKER_BATCH_SIZE || 25);
const DISCOVERY_BUSINESS_LIMIT = Number(process.env.BOOKKEEPING_PROCESSING_DISCOVERY_BUSINESS_LIMIT || 25);
const DISCOVERY_TXN_LIMIT = Number(process.env.BOOKKEEPING_PROCESSING_DISCOVERY_TXN_LIMIT || 100);

let timer = null;

async function getActiveBusinessIds() {
  const ids = new Set();
  const { data: items, error: itemErr } = await supabase
    .from("plaid_items")
    .select("business_id")
    .in("status", ["active", "connected"])
    .not("business_id", "is", null)
    .limit(DISCOVERY_BUSINESS_LIMIT);
  if (itemErr) {
    console.warn("[bookkeeping-processing] active item discovery failed", itemErr?.message || itemErr);
  }
  (items || []).forEach((row) => {
    if (row.business_id) ids.add(row.business_id);
  });

  const { data: queueRows, error: queueErr } = await supabase
    .from("bookkeeping_processing_requests")
    .select("business_id")
    .in("status", ["pending", "failed"])
    .not("business_id", "is", null)
    .limit(DISCOVERY_BUSINESS_LIMIT);
  if (queueErr) {
    console.warn("[bookkeeping-processing] queued business discovery failed", queueErr?.message || queueErr);
  }
  (queueRows || []).forEach((row) => {
    if (row.business_id) ids.add(row.business_id);
  });

  return Array.from(ids).slice(0, DISCOVERY_BUSINESS_LIMIT);
}

export async function runBookkeepingProcessingWorkerOnce({
  batchSize = BATCH_SIZE,
  workerId = `bookkeeping:${process.env.HOSTNAME || "local"}:${process.pid}`,
} = {}) {
  const businesses = await getActiveBusinessIds();
  let enqueued = 0;
  for (const businessId of businesses) {
    try {
      const result = await enqueueUnresolvedBookkeepingBacklog({
        businessId,
        supabase,
        limit: DISCOVERY_TXN_LIMIT,
      });
      enqueued += Number(result?.enqueued || 0);
    } catch (err) {
      console.warn("[bookkeeping-processing] backlog enqueue failed", {
        business_id: businessId,
        message: err?.message || String(err),
      });
    }
  }

  const processed = await processPendingBookkeepingRequests({
    supabase,
    workerId,
    batchSize,
  });

  if (enqueued > 0 || processed.claimed > 0) {
    console.info("[bookkeeping-processing] worker tick", {
      businesses: businesses.length,
      enqueued,
      claimed: processed.claimed,
      completed: processed.completed,
      failed: processed.failed,
      dead_letter: processed.dead_letter,
    });
  }

  return { ok: true, businesses: businesses.length, enqueued, ...processed };
}

export function startBookkeepingProcessingWorker() {
  if (timer) return timer;
  if (DISABLED) {
    console.info("[bookkeeping-processing] worker disabled via env");
    return null;
  }
  const intervalMs = Math.max(1, INTERVAL_MINUTES) * 60 * 1000;
  const run = () => {
    runBookkeepingProcessingWorkerOnce().catch((err) => {
      console.warn("[bookkeeping-processing] worker failed", err?.message || err);
    });
  };
  timer = setInterval(run, intervalMs);
  timer.unref?.();
  run();
  console.info("[bookkeeping-processing] worker started", {
    interval_minutes: INTERVAL_MINUTES,
    batch_size: BATCH_SIZE,
    discovery_txn_limit: DISCOVERY_TXN_LIMIT,
  });
  return timer;
}

export default {
  startBookkeepingProcessingWorker,
  runBookkeepingProcessingWorkerOnce,
};
