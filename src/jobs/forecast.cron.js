/* global process */
import { supabase } from '../services/supabaseAdmin.js';
import { refreshMonthlyQboFinancialSnapshot } from '../services/accounting/healthMonthlySnapshotService.js';
import { refreshOperatingSources, ensureForecastV1Run } from '../services/accounting/operatingForecastService.js';
import { log } from '../utils/reviews/logger.js';
import { qboEnvName } from '../utils/qboEnv.js';
import { filterEntitledBusinessIds } from '../services/billing/entitledBusinesses.js';

export async function evaluateForecastBusiness({ businessId, refresh = refreshOperatingSources, ensure = ensureForecastV1Run, refreshSnapshot = refreshMonthlyQboFinancialSnapshot }) {
  await refresh({ businessId, refreshSnapshot });
  return ensure({ businessId, reason: 'daily' });
}

async function runOnce() {
  log.info('[cron] forecast refresh start');

  const { data, error } = await supabase
    .from('quickbooks_tokens')
    .select('business_id')
    .eq('qbo_env', qboEnvName)
    .eq('is_active', true)
    .eq('status', 'active')
    .not('business_id', 'is', null);

  if (error) {
    log.error('[cron] forecast token fetch failed', error);
    return;
  }

  const entitled = new Set(await filterEntitledBusinessIds((data || []).map((row) => row.business_id)));
  const seen = new Set();
  const outcomes = { generated: 0, unchanged: 0, missing_history: 0, stale_source: 0, failed: 0 };
  for (const token of data || []) {
    const businessId = token.business_id;
    if (!businessId || !entitled.has(businessId) || seen.has(businessId)) continue;
    seen.add(businessId);

    try {
      const result = await evaluateForecastBusiness({ businessId });
      outcomes[result.outcome in outcomes ? result.outcome : 'failed'] += 1;
      log.info('[cron] operating forecast', { businessId, outcome: result.outcome });
    } catch (err) {
      outcomes[err?.details?.outcome === 'stale_source' ? 'stale_source' : 'failed'] += 1;
      log.error('[cron] operating forecast', { businessId, outcome: err?.details?.outcome || 'failed', reason: err?.message || String(err), refreshed_months: err?.details?.refreshed_months, failed_month: err?.details?.failed_month, unrefreshed_months: err?.details?.unrefreshed_months });
    }
  }

  log.info('[cron] forecast evaluation finished', { businesses: seen.size, outcomes });
}

function computeDelay(targetHour = 3, targetMinute = 10) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(targetHour, targetMinute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function startForecastCron() {
  if (process.env.DISABLE_FORECAST_CRON === 'true') {
    log.info('[cron] forecast cron disabled via env flag');
    return;
  }

  const hour = Number(process.env.FORECAST_CRON_HOUR ?? 3);
  const minute = Number(process.env.FORECAST_CRON_MINUTE ?? 10);
  const delay = computeDelay(hour, minute) + Math.floor(Math.random() * 30000);
  const interval = 24 * 60 * 60 * 1000; // daily

  log.info('[cron] forecast cron scheduled daily @', `${hour}:${String(minute).padStart(2, '0')}`);

  let inFlight = false;
  const evaluate = async () => {
    if (inFlight) { log.info('[cron] operating forecast evaluation already running'); return; }
    inFlight = true;
    try { await runOnce(); }
    catch (error) { log.error('[cron] forecast run error', { outcome: 'failed', reason: error?.message || String(error) }); }
    finally { inFlight = false; }
  };
  setTimeout(() => {
    evaluate();
    setInterval(evaluate, interval);
  }, delay);
}

export const runForecastCronOnce = runOnce;
