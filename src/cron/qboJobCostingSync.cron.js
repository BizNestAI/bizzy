import { supabase } from "../services/supabaseAdmin.js";
import {
  processQueuedQboWebhookEvents,
  runDailyQboJobCostingReconciliation,
  runQboCdcForBusiness,
} from "../services/jobCosting/qboOngoingSyncService.js";
import { qboEnvName } from "../utils/qboEnv.js";

const ALL_DISABLED = String(process.env.DISABLE_QBO_JOB_COSTING_SYNC || "").toLowerCase() === "true";
const WEBHOOK_DISABLED = String(process.env.DISABLE_QBO_JOB_COSTING_WEBHOOK_WORKER || "").toLowerCase() === "true";
const CDC_DISABLED = String(process.env.DISABLE_QBO_JOB_COSTING_CDC_CRON || "").toLowerCase() === "true";
const DAILY_DISABLED = String(process.env.DISABLE_QBO_JOB_COSTING_DAILY_CRON || "").toLowerCase() === "true";

const WEBHOOK_INTERVAL_MS = Math.max(15, Number(process.env.QBO_JOB_COSTING_WEBHOOK_WORKER_SECONDS || 60)) * 1000;
const CDC_INTERVAL_MS = Math.max(5, Number(process.env.QBO_JOB_COSTING_CDC_MINUTES || 30)) * 60 * 1000;
const DAILY_INTERVAL_MS = Math.max(1, Number(process.env.QBO_JOB_COSTING_DAILY_HOURS || 24)) * 60 * 60 * 1000;
const CHUNK_SIZE = Math.max(1, Number(process.env.QBO_JOB_COSTING_SYNC_CHUNK_SIZE || 10));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getConnectedQuickBooksBusinessIds() {
  const { data, error } = await supabase
    .from("quickbooks_tokens")
    .select("business_id")
    .eq("qbo_env", qboEnvName)
    .not("realm_id", "is", null);
  if (error) {
    console.warn("[qbo-job-costing-sync-cron] token lookup failed", error.message || error);
    return [];
  }
  return Array.from(new Set((data || []).map((row) => row.business_id).filter(Boolean)));
}

async function runForConnectedBusinesses(taskName, task) {
  const businessIds = await getConnectedQuickBooksBusinessIds();
  for (let i = 0; i < businessIds.length; i += CHUNK_SIZE) {
    const batch = businessIds.slice(i, i + CHUNK_SIZE);
    await Promise.allSettled(batch.map((businessId) => task(businessId)));
    if (i + CHUNK_SIZE < businessIds.length) await sleep(250);
  }
  if (process.env.NODE_ENV !== "production") {
    console.info(`[qbo-job-costing-sync-cron] ${taskName} complete`, { businesses: businessIds.length });
  }
}

export async function runQboWebhookQueueOnce() {
  return processQueuedQboWebhookEvents({
    limit: Number(process.env.QBO_JOB_COSTING_WEBHOOK_BATCH_SIZE || 25),
  });
}

export async function runQboCdcSweepOnce() {
  return runForConnectedBusinesses("cdc", (businessId) => runQboCdcForBusiness({ businessId }));
}

export async function runQboDailyReconciliationSweepOnce() {
  return runForConnectedBusinesses("daily", (businessId) => runDailyQboJobCostingReconciliation({ businessId }));
}

export function startQboJobCostingSyncCron() {
  if (ALL_DISABLED) {
    console.info("[qbo-job-costing-sync-cron] disabled via DISABLE_QBO_JOB_COSTING_SYNC");
    return;
  }

  if (!WEBHOOK_DISABLED) {
    console.info("[qbo-job-costing-sync-cron] webhook worker started", { interval_seconds: WEBHOOK_INTERVAL_MS / 1000 });
    setInterval(() => {
      runQboWebhookQueueOnce().catch((error) => console.warn("[qbo-job-costing-sync-cron] webhook worker failed", error?.message || error));
    }, WEBHOOK_INTERVAL_MS);
  } else {
    console.info("[qbo-job-costing-sync-cron] webhook worker disabled");
  }

  if (!CDC_DISABLED) {
    console.info("[qbo-job-costing-sync-cron] CDC sweep started", { interval_minutes: CDC_INTERVAL_MS / 60000 });
    setInterval(() => {
      runQboCdcSweepOnce().catch((error) => console.warn("[qbo-job-costing-sync-cron] CDC sweep failed", error?.message || error));
    }, CDC_INTERVAL_MS);
  } else {
    console.info("[qbo-job-costing-sync-cron] CDC sweep disabled");
  }

  if (!DAILY_DISABLED) {
    console.info("[qbo-job-costing-sync-cron] daily reconciliation started", { interval_hours: DAILY_INTERVAL_MS / 3600000 });
    setInterval(() => {
      runQboDailyReconciliationSweepOnce()
        .catch((error) => console.warn("[qbo-job-costing-sync-cron] daily reconciliation failed", error?.message || error));
    }, DAILY_INTERVAL_MS);
  } else {
    console.info("[qbo-job-costing-sync-cron] daily reconciliation disabled");
  }
}

export default {
  startQboJobCostingSyncCron,
  runQboWebhookQueueOnce,
  runQboCdcSweepOnce,
  runQboDailyReconciliationSweepOnce,
};
