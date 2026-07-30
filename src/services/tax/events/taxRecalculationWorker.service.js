/* global process */
import { supabase } from "../../supabaseAdmin.js";
import { processPendingTaxRecalculationRequests } from "./processTaxRecalculationRequests.js";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 10;
let timer = null;

export function isTaxRecalculationWorkerEnabled() {
  const raw = process.env.TAX_RECALCULATION_WORKER_ENABLED;
  if (raw == null || raw === "") return true;
  return String(raw).trim().toLowerCase() !== "false";
}

export function startTaxRecalculationWorker({
  intervalMs = Number(process.env.TAX_RECALCULATION_WORKER_INTERVAL_MS || DEFAULT_INTERVAL_MS),
  batchSize = Number(process.env.TAX_RECALCULATION_WORKER_BATCH_SIZE || DEFAULT_BATCH_SIZE),
  workerId = process.env.TAX_RECALCULATION_WORKER_ID || `tax-recalc:${process.env.HOSTNAME || "local"}:${process.pid}`,
} = {}) {
  if (timer) return timer;
  if (!isTaxRecalculationWorkerEnabled()) {
    console.info("[tax-recalculation-worker] disabled via env");
    return null;
  }
  const run = () => {
    processPendingTaxRecalculationRequests({ supabase, workerId, batchSize })
      .then((result) => {
        if (result.processed > 0) {
          console.info("[tax-recalculation-worker] processed", {
            workerId,
            processed: result.processed,
            completed: result.completed,
            skipped: result.skipped,
            failed: result.failed,
          });
        }
      })
      .catch((err) => console.warn("[tax-recalculation-worker] failed", err?.message || err));
  };
  timer = setInterval(run, Math.max(5_000, intervalMs));
  timer.unref?.();
  run();
  console.info("[tax-recalculation-worker] started", { workerId, intervalMs, batchSize });
  return timer;
}

export function stopTaxRecalculationWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
