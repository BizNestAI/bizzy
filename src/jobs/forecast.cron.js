import { supabase } from '../services/supabaseAdmin.js';
import { generateCashFlowForecast } from '../api/accounting/generateCashFlowForecast.js';
import { log } from '../utils/reviews/logger.js';

const DEMO_USER = process.env.DEMO_USER_UUID || '00000000-0000-0000-0000-000000000000';

async function runOnce() {
  log.info('[cron] forecast refresh start');

  const { data, error } = await supabase
    .from('quickbooks_tokens')
    .select('business_id, user_id')
    .not('business_id', 'is', null);

  if (error) {
    log.error('[cron] forecast token fetch failed', error);
    return;
  }

  const seen = new Set();
  for (const token of data || []) {
    const businessId = token.business_id;
    if (!businessId || seen.has(businessId)) continue;
    seen.add(businessId);

    const userId = token.user_id || DEMO_USER;
    try {
      await generateCashFlowForecast({ userId, businessId, months: 12, forceMock: false });
      log.info('[cron] forecast refreshed', businessId);
    } catch (err) {
      log.error('[cron] forecast refresh failed', businessId, err?.message || err);
    }
  }

  log.info('[cron] forecast refresh complete', seen.size, 'businesses');
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
  const delay = computeDelay(hour, minute);
  const interval = 24 * 60 * 60 * 1000; // daily

  log.info('[cron] forecast cron scheduled daily @', `${hour}:${String(minute).padStart(2, '0')}`);

  setTimeout(() => {
    runOnce().catch((err) => log.error('[cron] forecast run error', err));
    setInterval(() => {
      runOnce().catch((err) => log.error('[cron] forecast run error', err));
    }, interval);
  }, delay);
}

export const runForecastCronOnce = runOnce;
