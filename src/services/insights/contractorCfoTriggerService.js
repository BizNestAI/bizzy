/* global process */
import { supabase } from '../supabaseAdmin.js';
import { runContractorCfoInsightsForBusiness } from './contractorCfoEngine.js';
import { ensureContractorCfoInsightsSchemaReady } from './contractorCfoSchemaCheck.js';

const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOCK_TTL_SECONDS = 2 * 60 * 60;
const INSTANCE_ID = [
  process.env.RAILWAY_REPLICA_ID,
  process.env.RAILWAY_DEPLOYMENT_ID,
  process.env.HOSTNAME,
  `pid:${process.pid}`,
].filter(Boolean).join(':');

export function isContractorCfoInsightsEnabled() {
  const raw = process.env.CONTRACTOR_CFO_INSIGHTS_ENABLED;
  if (raw == null || raw === '') return true;
  return String(raw).trim().toLowerCase() !== 'false';
}

export async function runContractorCfoInsightsIfEnabled({
  businessId,
  trigger = 'manual',
  force = false,
  limit,
} = {}) {
  if (!businessId) {
    return { ok: true, skipped: true, reason: 'missing_business_id', inserted: 0 };
  }
  if (!isContractorCfoInsightsEnabled()) {
    return { ok: true, skipped: true, reason: 'contractor_cfo_insights_disabled', inserted: 0 };
  }
  const schema = await ensureContractorCfoInsightsSchemaReady();
  if (!schema.ok) {
    console.warn('[contractor-cfo-insights] disabled by schema check', {
      reason: schema.reason,
      missingColumns: schema.missingColumns,
    });
    return {
      ok: true,
      skipped: true,
      reason: schema.reason || 'insights_schema_not_ready',
      inserted: 0,
      missing_columns: schema.missingColumns || [],
    };
  }

  return runContractorCfoInsightsForBusiness(businessId, {
    trigger,
    force,
    ...(limit ? { limit } : {}),
  });
}

export function triggerContractorCfoInsightsBestEffort({
  businessId,
  trigger = 'manual',
  force = false,
  limit,
} = {}) {
  if (!businessId) return;
  runContractorCfoInsightsIfEnabled({ businessId, trigger, force, limit }).catch((err) => {
    console.warn('[contractor-cfo-insights] generation failed', {
      businessId,
      trigger,
      message: err?.message || String(err),
    });
  });
}

async function activeBusinessIdsFrom(table, filter, idColumn = 'business_id') {
  let query = supabase
    .from(table)
    .select(idColumn)
    .not(idColumn, 'is', null)
    .limit(5000);
  if (filter) query = filter(query);

  const { data, error } = await query;
  if (error) {
    console.warn('[contractor-cfo-insights-cron] active business lookup failed', table, error?.message || error);
    return [];
  }
  return (data || []).map((row) => row[idColumn]).filter(Boolean);
}

export async function getActiveContractorCfoBusinessIds() {
  const [qboIds, plaidIds] = await Promise.all([
    activeBusinessIdsFrom('quickbooks_tokens', (q) => q.eq('is_active', true).eq('status', 'active')),
    activeBusinessIdsFrom('plaid_items', (q) => q.eq('is_active', true)),
  ]);

  return Array.from(new Set([...qboIds, ...plaidIds]));
}

function computeDelay(targetHour = 6, targetMinute = 0) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(targetHour, targetMinute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduledWindowFor(date = new Date(), targetHour = 6, targetMinute = 0) {
  const window = new Date(date);
  window.setHours(targetHour, targetMinute, 0, 0);
  if (window > date) window.setDate(window.getDate() - 1);
  return window;
}

function runKeyForScheduledWindow(scheduledFor) {
  return `contractor_cfo:daily:${scheduledFor.toISOString()}`;
}

async function claimScheduledRun({ scheduledFor, lockOwner = INSTANCE_ID, lockTtlSeconds = DEFAULT_LOCK_TTL_SECONDS }) {
  const runKey = runKeyForScheduledWindow(scheduledFor);
  const { data, error } = await supabase.rpc('claim_contractor_cfo_insight_run', {
    p_run_key: runKey,
    p_scheduled_for: scheduledFor.toISOString(),
    p_lock_owner: lockOwner,
    p_lock_ttl_seconds: lockTtlSeconds,
  });

  if (error) {
    console.warn('[contractor-cfo-insights-cron] run lock claim failed', error?.message || error);
    return { claimed: false, runId: null, reason: 'lock_claim_failed', runKey, error };
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    claimed: Boolean(row?.claimed),
    runId: row?.run_id || null,
    reason: row?.reason || 'unknown',
    runKey,
  };
}

async function finishScheduledRun(runId, patch = {}) {
  if (!runId) return;
  const { error } = await supabase
    .from('contractor_cfo_insight_runs')
    .update({
      ...patch,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', runId);
  if (error) {
    console.warn('[contractor-cfo-insights-cron] run status update failed', error?.message || error);
  }
}

export async function runContractorCfoInsightsDailyOnce(options = {}) {
  if (!isContractorCfoInsightsEnabled()) {
    console.info('[contractor-cfo-insights-cron] disabled via env');
    return { ok: true, skipped: true, reason: 'contractor_cfo_insights_disabled', businesses: 0 };
  }

  const hour = Number(options.hour ?? process.env.CONTRACTOR_CFO_INSIGHTS_CRON_HOUR ?? 6);
  const minute = Number(options.minute ?? process.env.CONTRACTOR_CFO_INSIGHTS_CRON_MINUTE ?? 0);
  const scheduledFor = options.scheduledFor
    ? new Date(options.scheduledFor)
    : scheduledWindowFor(new Date(), hour, minute);
  if (!Number.isFinite(scheduledFor.getTime())) {
    return { ok: false, skipped: true, reason: 'invalid_scheduled_for', businesses: 0 };
  }

  const lock = await claimScheduledRun({
    scheduledFor,
    lockOwner: options.lockOwner || INSTANCE_ID,
    lockTtlSeconds: Number(options.lockTtlSeconds || process.env.CONTRACTOR_CFO_INSIGHTS_LOCK_TTL_SECONDS || DEFAULT_LOCK_TTL_SECONDS),
  });

  if (!lock.claimed) {
    return {
      ok: true,
      skipped: true,
      reason: lock.reason,
      run_id: lock.runId,
      run_key: lock.runKey,
      businesses: 0,
      inserted: 0,
    };
  }

  let inserted = 0;
  let skipped = 0;
  let businessIds = [];

  try {
    businessIds = await getActiveContractorCfoBusinessIds();

    for (const businessId of businessIds) {
      try {
        const result = await runContractorCfoInsightsIfEnabled({
          businessId,
          trigger: 'scheduled',
          force: false,
        });
        inserted += Number(result?.inserted || 0);
        skipped += Number(result?.skipped || 0);
      } catch (err) {
        skipped += 1;
        console.warn('[contractor-cfo-insights-cron] business failed', businessId, err?.message || err);
      }
    }

    await finishScheduledRun(lock.runId, {
      status: 'completed',
      businesses_count: businessIds.length,
      inserted_count: inserted,
      skipped_count: skipped,
      error: null,
    });

    return {
      ok: true,
      run_id: lock.runId,
      run_key: lock.runKey,
      businesses: businessIds.length,
      inserted,
      skipped,
    };
  } catch (err) {
    await finishScheduledRun(lock.runId, {
      status: 'failed',
      businesses_count: businessIds.length,
      inserted_count: inserted,
      skipped_count: skipped,
      error: err?.message || String(err),
    });
    throw err;
  }
}

export function startContractorCfoInsightsCron() {
  if (!isContractorCfoInsightsEnabled()) {
    console.info('[contractor-cfo-insights-cron] disabled via env');
    return;
  }
  if (String(process.env.DISABLE_CONTRACTOR_CFO_INSIGHTS_CRON || '').toLowerCase() === 'true') {
    console.info('[contractor-cfo-insights-cron] disabled via DISABLE_CONTRACTOR_CFO_INSIGHTS_CRON');
    return;
  }

  ensureContractorCfoInsightsSchemaReady()
    .then((schema) => {
      if (!schema.ok) {
        console.warn('[contractor-cfo-insights-cron] not scheduled; insights schema is not ready', {
          reason: schema.reason,
          missingColumns: schema.missingColumns,
        });
        return;
      }

      const hour = Number(process.env.CONTRACTOR_CFO_INSIGHTS_CRON_HOUR ?? 6);
      const minute = Number(process.env.CONTRACTOR_CFO_INSIGHTS_CRON_MINUTE ?? 0);
      const delay = computeDelay(hour, minute);
      let scheduledFor = new Date(Date.now() + delay);
      scheduledFor.setSeconds(0, 0);

      console.info('[contractor-cfo-insights-cron] scheduled daily', {
        hour,
        minute,
      });

      setTimeout(() => {
        runContractorCfoInsightsDailyOnce({ scheduledFor, hour, minute })
          .then((result) => console.info('[contractor-cfo-insights-cron] complete', result))
          .catch((err) => console.warn('[contractor-cfo-insights-cron] failed', err?.message || err));
        setInterval(() => {
          scheduledFor = new Date(scheduledFor.getTime() + DAILY_INTERVAL_MS);
          runContractorCfoInsightsDailyOnce({ scheduledFor, hour, minute })
            .then((result) => console.info('[contractor-cfo-insights-cron] complete', result))
            .catch((err) => console.warn('[contractor-cfo-insights-cron] failed', err?.message || err));
        }, DAILY_INTERVAL_MS);
      }, delay);
    })
    .catch((err) => {
      console.warn('[contractor-cfo-insights-cron] not scheduled; schema check failed', err?.message || err);
    });
}

export default {
  isContractorCfoInsightsEnabled,
  runContractorCfoInsightsIfEnabled,
  triggerContractorCfoInsightsBestEffort,
  getActiveContractorCfoBusinessIds,
  runContractorCfoInsightsDailyOnce,
  startContractorCfoInsightsCron,
};
