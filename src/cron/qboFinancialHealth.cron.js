import { supabase } from "../services/supabaseAdmin.js";
import { refreshMonthlyQboFinancialSnapshot } from "../services/accounting/healthMonthlySnapshotService.js";
import { qboEnvName } from "../utils/qboEnv.js";
import { prevMonthParts } from "../utils/monthKey.js";

const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

function computeDelay(targetHour = 4, targetMinute = 20) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(targetHour, targetMinute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export async function runQboFinancialHealthRefreshOnce() {
  const { data, error } = await supabase
    .from("quickbooks_tokens")
    .select("business_id")
    .eq("qbo_env", qboEnvName)
    .eq("is_active", true)
    .eq("status", "active")
    .not("business_id", "is", null);

  if (error) {
    console.warn("[qbo-financial-health-cron] active connection lookup failed", error?.message || error);
    return { ok: false, businesses: 0, error: error?.message || String(error) };
  }

  const seen = new Set();
  let refreshed = 0;
  let failed = 0;

  for (const row of data || []) {
    const businessId = row?.business_id;
    if (!businessId || seen.has(businessId)) continue;
    seen.add(businessId);
    try {
      const now = new Date();
      const current = { year: now.getFullYear(), month: now.getMonth() + 1 };
      const prior = prevMonthParts(current);
      await refreshMonthlyQboFinancialSnapshot({ businessId, ...current, source: "daily_cron_current_month" });
      await refreshMonthlyQboFinancialSnapshot({ businessId, ...prior, source: "daily_cron_prior_month" });
      refreshed += 1;
    } catch (err) {
      failed += 1;
      console.warn("[qbo-financial-health-cron] business refresh failed", {
        business_id: businessId,
        error: err?.message || err,
      });
    }
  }

  return { ok: failed === 0, businesses: seen.size, refreshed, failed };
}

export function startQboFinancialHealthCron() {
  if (String(process.env.DISABLE_QBO_FINANCIAL_HEALTH_CRON || "").toLowerCase() === "true") {
    console.info("[qbo-financial-health-cron] disabled via env");
    return;
  }

  const hour = Number(process.env.QBO_FINANCIAL_HEALTH_CRON_HOUR ?? 4);
  const minute = Number(process.env.QBO_FINANCIAL_HEALTH_CRON_MINUTE ?? 20);
  const delay = computeDelay(hour, minute);

  console.info("[qbo-financial-health-cron] scheduled daily", {
    qbo_env: qboEnvName,
    hour,
    minute,
  });

  setTimeout(() => {
    runQboFinancialHealthRefreshOnce()
      .then((result) => console.info("[qbo-financial-health-cron] complete", result))
      .catch((err) => console.warn("[qbo-financial-health-cron] failed", err?.message || err));
    setInterval(() => {
      runQboFinancialHealthRefreshOnce()
        .then((result) => console.info("[qbo-financial-health-cron] complete", result))
        .catch((err) => console.warn("[qbo-financial-health-cron] failed", err?.message || err));
    }, DAILY_INTERVAL_MS);
  }, delay);
}

export default startQboFinancialHealthCron;
