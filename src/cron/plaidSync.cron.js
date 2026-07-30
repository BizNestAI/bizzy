import { supabase } from "../services/supabaseAdmin.js";
import { runPlaidSyncForBusiness } from "../services/plaid/plaidSyncService.js";
import { runReconciliationOnceForBusiness } from "./reconciliation.cron.js";

const CRON_DISABLED = String(process.env.DISABLE_PLAID_SYNC_CRON || "").toLowerCase() === "true";
const CRON_INTERVAL_MINUTES = Number(process.env.PLAID_SYNC_CRON_INTERVAL_MINUTES || 15);
const SYNC_HOUR = Number(process.env.PLAID_SYNC_HOUR_LOCAL || 5);
const STALE_HOURS = Number(process.env.PLAID_SYNC_STALE_HOURS || 20);
const MAX_ITEMS_PER_TICK = Number(process.env.PLAID_SYNC_MAX_ITEMS || 25);

function getHourInZone(timezone) {
  if (!timezone) return new Date().getHours();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: timezone,
    }).formatToParts(new Date());
    const hourPart = parts.find((p) => p.type === "hour");
    return hourPart ? Number(hourPart.value) : new Date().getHours();
  } catch {
    return new Date().getHours();
  }
}

function hoursSince(lastIso) {
  if (!lastIso) return Number.POSITIVE_INFINITY;
  const last = new Date(lastIso);
  if (Number.isNaN(last.getTime())) return Number.POSITIVE_INFINITY;
  const diffMs = Date.now() - last.getTime();
  return diffMs / (1000 * 60 * 60);
}

function shouldSyncNow(timezone, lastSyncAt) {
  const hour = getHourInZone(timezone);
  if (hour !== SYNC_HOUR) return false;
  const diff = hoursSince(lastSyncAt);
  return diff >= STALE_HOURS;
}

export function startPlaidDailySyncCron() {
  if (CRON_DISABLED) {
    console.info("[plaid-sync-cron] disabled via env");
    return;
  }
  const intervalMs = Math.max(1, CRON_INTERVAL_MINUTES) * 60 * 1000;
  console.info("[plaid-sync-cron] started, interval mins:", CRON_INTERVAL_MINUTES, "hour:", SYNC_HOUR);
  setInterval(() => {
    tick().catch((err) => console.error("[plaid-sync-cron] tick failed", err?.message || err));
  }, intervalMs);
}

async function tick() {
  const { data: items, error } = await supabase
    .from("plaid_items")
    .select("id,business_id,plaid_item_id,status,last_sync_at,metadata")
    .eq("status", "connected");
  if (error) {
    console.error("[plaid-sync-cron] failed to fetch items", error?.message || error);
    return;
  }
  if (!items || !items.length) return;

  let processed = 0;
  for (const item of items) {
    if (processed >= MAX_ITEMS_PER_TICK) break;
    const tz = item.metadata?.timezone || item.metadata?.profile?.timezone || null;
    if (!shouldSyncNow(tz, item.last_sync_at)) continue;
    processed += 1;
    try {
      const res = await runPlaidSyncForBusiness(item.business_id, { force: false });
      runReconciliationOnceForBusiness(item.business_id, {
        force: true,
        preferQboBalance: false,
      }).catch(() => {});
      if (process.env.NODE_ENV !== "production") {
        console.info("[plaid-sync-cron] synced business", item.business_id, res);
      }
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      console.warn("[plaid-sync-cron] sync failed", item.business_id, err?.message || err);
    }
  }
}
