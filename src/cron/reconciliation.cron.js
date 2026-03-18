import { supabase } from "../services/supabaseAdmin.js";
import { evaluateReconciliationStatus } from "../services/bookkeeping/reconciliationEvaluator.js";

const POLL_MINUTES = Number(process.env.RECON_CRON_MINUTES || 60);
const MIN_INTERVAL_HOURS = Number(process.env.RECON_MIN_INTERVAL_HOURS || 6);
const MIN_INTERVAL_MS = MIN_INTERVAL_HOURS * 60 * 60 * 1000;
const DISABLED = String(process.env.DISABLE_RECON_CRON || "").toLowerCase() === "true";
const CHUNK_SIZE = 25;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getActiveBusinessIds() {
  const ids = new Set();
  const { data: items, error: itemsErr } = await supabase
    .from("plaid_items")
    .select("business_id")
    .eq("status", "connected")
    .not("business_id", "is", null);
  if (itemsErr) {
    console.warn("[recon-cron] plaid_items fetch failed", itemsErr.message || itemsErr);
  }
  (items || []).forEach((row) => {
    if (row.business_id) ids.add(row.business_id);
  });

  // Fallback to active plaid_accounts
  const { data: accounts, error: acctErr } = await supabase
    .from("plaid_accounts")
    .select("business_id")
    .eq("is_active", true)
    .not("business_id", "is", null);
  if (acctErr) {
    console.warn("[recon-cron] plaid_accounts fetch failed", acctErr.message || acctErr);
  }
  (accounts || []).forEach((row) => {
    if (row.business_id) ids.add(row.business_id);
  });

  return Array.from(ids);
}

async function getLastReconRunAt(businessId) {
  const { data, error } = await supabase
    .from("reconciliation_health")
    .select("last_checked_at")
    .eq("business_id", businessId)
    .order("last_checked_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[recon-cron] last run fetch failed", businessId, error.message || error);
    return null;
  }
  return data?.last_checked_at || null;
}

export async function runReconciliationOnceForBusiness(businessId, { force = false, preferQboBalance } = {}) {
  if (!businessId) return null;
  try {
    if (!force) {
      const last = await getLastReconRunAt(businessId);
      if (last) {
        const since = Date.now() - new Date(last).getTime();
        if (since < MIN_INTERVAL_MS) {
          if (process.env.NODE_ENV !== "production") {
            console.info("[recon-cron] skip (throttled)", { businessId, last });
          }
          return { skipped: true, reason: "throttled", last_checked_at: last };
        }
      }
    }
    const result = await evaluateReconciliationStatus(businessId, {
      preferQboBalance: preferQboBalance ?? force,
    });
    return { ok: true, result };
  } catch (err) {
    console.warn("[recon-cron] run failed", businessId, err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

async function runOnceAllBusinesses() {
  const bizIds = await getActiveBusinessIds();
  if (!bizIds.length) {
    if (process.env.NODE_ENV !== "production") {
      console.info("[recon-cron] no active businesses");
    }
    return;
  }

  let processed = 0;
  for (let i = 0; i < bizIds.length; i += CHUNK_SIZE) {
    const slice = bizIds.slice(i, i + CHUNK_SIZE);
    const runs = slice.map((bid) => runReconciliationOnceForBusiness(bid, { force: false, preferQboBalance: false }));
    await Promise.allSettled(runs);
    processed += slice.length;
    if (i + CHUNK_SIZE < bizIds.length) {
      await sleep(250);
    }
  }
  if (process.env.NODE_ENV !== "production") {
    console.info("[recon-cron] sweep complete", { businesses: bizIds.length, processed });
  }
}

export function startReconciliationCron() {
  if (DISABLED) {
    console.info("[recon-cron] disabled via env");
    return;
  }
  const intervalMs = Math.max(1, POLL_MINUTES) * 60 * 1000;
  console.info("[recon-cron] started", { interval_minutes: POLL_MINUTES, min_interval_hours: MIN_INTERVAL_HOURS });
  runOnceAllBusinesses().catch((err) => console.error("[recon-cron] initial tick failed", err?.message || err));
  setInterval(() => {
    runOnceAllBusinesses().catch((err) => console.error("[recon-cron] tick failed", err?.message || err));
  }, intervalMs);
}

export default {
  startReconciliationCron,
  runReconciliationOnceForBusiness,
};
