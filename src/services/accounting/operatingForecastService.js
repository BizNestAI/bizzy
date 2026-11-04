import fetch from 'node-fetch';
import { fetchQboReport } from '../bookkeeping/qboMonthlyPnlIngestionService.js';
import { SOURCE_REFRESH_POLICY, retryOperatingReport, waitForSource } from './operatingForecastRefresh.js';
import { supabase as defaultDb } from '../supabaseAdmin.js';
import { MODEL_VERSION, MODEL_CONFIG, hash, completedWindow, reconcileMonth, buildOperatingModel, cents, money } from './operatingForecastModel.js';
import { ForecastV1Error } from './forecastV1Service.js';
export { ForecastV1Error };
async function query(q) {
  const {
    data,
    error
  } = await q;
  if (error && /forecast_source_changed|forecast_reporting_configuration_changed/.test(error.message || '')) throw new ForecastV1Error('forecast_source_changed', 409, {
    outcome: 'stale_source'
  });
  if (error) throw new ForecastV1Error('forecast_storage_unavailable', 503, {
    cause: error.message
  });
  return data;
}
export async function loadOperatingHistory({
  db = defaultDb,
  businessId,
  now = new Date()
}) {
  const config = await query(db.from('business_financial_reporting_config').select('*').eq('business_id', businessId).maybeSingle());
  let window;
  try {
    window = completedWindow(now, config?.reporting_timezone);
  } catch {
    return {
      complete: false,
      months: [],
      missing_months: [],
      blocking: [{
        reason: 'reporting_timezone_required'
      }]
    };
  }
  const snapshots = await query(db.from('monthly_review_qbo_pnl_snapshots').select('*').eq('business_id', businessId).eq('accounting_method', 'Cash').eq('is_current', true).gte('source_start_date', window[0]).lte('source_start_date', window[11]));
  const ids = (snapshots || []).map(s => s.id);
  const accounts = [];
  if (ids.length) for (let offset = 0;; offset += 500) {
    const page = await query(db.from('monthly_review_qbo_pnl_accounts').select('*').eq('business_id', businessId).in('snapshot_id', ids).order('id').range(offset, offset + 499));
    accounts.push(...(page || []));
    if (!page || page.length < 500) break;
  }
  const months = [],
    blocking = [];
  for (const month of window) {
    const candidates = (snapshots || []).filter(s => `${s.review_year}-${String(s.review_month).padStart(2, '0')}-01` === month);
    try {
      if (config?.status !== 'verified' || !config.timezone_confirmed_at || config.home_currency !== 'USD') throw new Error('reporting_configuration_required');
      if (candidates.length !== 1) throw new Error('missing_cash_snapshot');
      const snapshot = candidates[0],
        detail = (accounts || []).filter(a => a.snapshot_id === snapshot.id);
      const fingerprint = reconcileMonth(snapshot, detail, businessId, month, config);
      months.push({
        month,
        snapshot,
        accounts: detail,
        fingerprint
      });
    } catch (error) {
      blocking.push({
        month,
        reason: error.message
      });
    }
  }
  return {
    complete: blocking.length === 0,
    months,
    missing_months: blocking.map(b => b.month),
    blocking,
    window,
    timezone: config?.reporting_timezone,
    realm: config?.qbo_realm_id,
    currency: config?.home_currency
  };
}
function identity(businessId, h) {
  return hash({
    businessId,
    basis: 'Cash',
    window: h.window,
    sources: h.months.map(m => ({
      id: m.snapshot.id,
      content: m.fingerprint
    })),
    model: MODEL_VERSION,
    config: MODEL_CONFIG
  });
}
// Exact snapshot lineage remains on the run, while equivalent content refreshes
// do not manufacture a new version solely because the provider snapshot UUID changed.
function financialIdentity(businessId, h) {
  return hash({
    businessId,
    basis: 'Cash',
    window: h.window,
    content: h.months.map(m => m.fingerprint),
    model: MODEL_VERSION,
    config: MODEL_CONFIG
  });
}
function matches(run, fingerprint, businessId, h) {
  return run?.input_fingerprint === fingerprint || run?.model_version === MODEL_VERSION && run?.data_quality?.financial_input_hash === financialIdentity(businessId, h);
}
async function latest(db, businessId) {
  return await query(db.from('forecast_runs').select('*').eq('business_id', businessId).eq('status', 'completed').in('model_version', [MODEL_VERSION, 'forecast_v1']).order('generated_at', {
    ascending: false
  }).limit(1).maybeSingle());
}
async function serialize(db, run, extra = {}) {
  if (!run) return {
    data_status: 'insufficient_history',
    is_sample: false,
    forecast: {
      months: []
    },
    ...extra
  };
  const [monthly, overrides] = await Promise.all([query(db.from('forecast_months').select('*').eq('business_id', run.business_id).eq('forecast_run_id', run.id).order('month')), query(db.from('forecast_overrides').select('*').eq('business_id', run.business_id).eq('forecast_run_id', run.id))]);
  const months = (monthly || []).map(r => {
    const o = (overrides || []).find(o => o.month === r.month);
    const revenue = money(cents(o?.revenue_override ?? r.baseline_revenue)),
      expenses = money(cents(o?.expense_override ?? r.baseline_expenses));
    return {
      ...r,
      revenue,
      expenses,
      operating_net_cash_flow: money(cents(revenue) - cents(expenses)),
      net_cash: money(cents(revenue) - cents(expenses)),
      revenue_override: o?.revenue_override ?? null,
      expense_override: o?.expense_override ?? null,
      has_override: o?.revenue_override != null || o?.expense_override != null
    };
  });
  return {
    data_status: 'available',
    is_sample: false,
    run_id: run.id,
    model_version: run.model_version,
    generated_at: run.generated_at,
    history: {
      start: run.history_start,
      end: run.history_end
    },
    forecast: {
      start: run.forecast_start,
      end: run.forecast_end,
      months
    },
    cash_balance: {
      status: 'unavailable'
    },
    freshness: 'current',
    assumptions_preserved: months.some(m => m.has_override),
    ...extra
  };
}
export async function getForecastV1Status({
  db = defaultDb,
  businessId,
  now = new Date()
} = {}) {
  if (!businessId) throw new ForecastV1Error('missing_business_id');
  const h = await loadOperatingHistory({
    db,
    businessId,
    now
  });
  const previous = await latest(db, businessId);
  if (!h.complete) return serialize(db, previous, {
    freshness: 'missing_history',
    outcome: 'missing_history',
    blocking: h.blocking,
    missing_months: h.missing_months
  });
  const fingerprint = identity(businessId, h);
  if (matches(previous, fingerprint, businessId, h)) return serialize(db, previous, {
    outcome: 'unchanged'
  });
  return serialize(db, previous, {
    data_status: previous ? 'available' : 'generation_required',
    freshness: 'stale',
    outcome: 'stale_source',
    refresh_required: true
  });
}
export async function ensureForecastV1Run({
  db = defaultDb,
  businessId,
  createdBy = null,
  now = new Date(),
  reason = 'manual',
  clock = () => new Date()
} = {}) {
  if (!businessId) throw new ForecastV1Error('missing_business_id');
  const h = await loadOperatingHistory({
    db,
    businessId,
    now
  });
  const previous = await latest(db, businessId);
  if (!h.complete) return serialize(db, previous, {
    freshness: 'missing_history',
    outcome: 'missing_history',
    blocking: h.blocking,
    missing_months: h.missing_months
  });
  const fingerprint = identity(businessId, h);
  if (matches(previous, fingerprint, businessId, h)) return serialize(db, previous, {
    outcome: 'unchanged'
  });
  const {
    rows: monthly,
    metadata
  } = buildOperatingModel(h.months);
  // Claim RPC serializes different fingerprints and expires abandoned leases.
  const claim = await query(db.rpc('claim_operating_forecast', {
    p_business_id: businessId,
    p_fingerprint: fingerprint,
    p_payload: {
      model_version: MODEL_VERSION,
      history_start: h.window[0],
      history_end: h.window[11],
      forecast_start: monthly[0].month,
      forecast_end: monthly[11].month,
      source_snapshot_ids: h.months.map(m => m.snapshot.id),
      source_snapshot_ids_hash: hash(h.months.map(m => m.snapshot.id)),
      model_config: MODEL_CONFIG,
      data_quality: {
        ...metadata,
        financial_input_hash: financialIdentity(businessId, h),
        reason,
        timezone: h.timezone,
        source_identity: {
          realm: h.realm,
          currency: h.currency
        },
        sources: h.months.map(m => ({
          id: m.snapshot.id,
          fingerprint: m.fingerprint,
          guard: {
            identity: {
              business_id: m.snapshot.business_id,
              qbo_realm_id: m.snapshot.qbo_realm_id,
              accounting_method: 'Cash',
              source_start_date: m.snapshot.source_start_date,
              source_end_date: m.snapshot.source_end_date,
              review_year: m.snapshot.review_year,
              review_month: m.snapshot.review_month
            },
            revenue: m.snapshot.revenue,
            cogs: m.snapshot.cogs,
            expenses: m.snapshot.expenses,
            net_profit: m.snapshot.net_profit,
            accounts: m.accounts.map(a => ({
              id: a.qbo_account_id,
              section: a.account_type,
              amount: a.total_amount,
              name: a.account_name ?? null,
              path: a.account_path ?? null,
              subtype: a.account_subtype ?? null
            }))
          }
        }))
      },
      created_by: createdBy
    },
    p_routine: reason === 'daily'
  }));
  if (!claim?.id) return serialize(db, previous, {
    data_status: previous ? 'available' : 'generation_in_progress',
    freshness: 'stale',
    outcome: 'stale_source',
    refresh_required: true
  });
  if (claim.status === 'completed') return serialize(db, claim, {
    outcome: matches(claim, fingerprint, businessId, h) ? 'unchanged' : 'stale_source',
    freshness: matches(claim, fingerprint, businessId, h) ? 'current' : 'stale'
  });
  try {
    const recheck = await loadOperatingHistory({
      db,
      businessId,
      now: clock()
    });
    if (!recheck.complete || identity(businessId, recheck) !== fingerprint) throw new ForecastV1Error('forecast_source_changed', 409, {
      outcome: 'stale_source'
    });
    await query(db.rpc('complete_operating_forecast', {
      p_business_id: businessId,
      p_run_id: claim.id,
      p_months: monthly
    }));
    const run = await query(db.from('forecast_runs').select('*').eq('business_id', businessId).eq('id', claim.id).single());
    return serialize(db, run, {
      outcome: 'generated'
    });
  } catch (error) {
    await query(db.from('forecast_runs').update({
      status: 'failed',
      generation_lease_expires_at: null,
      error_metadata: {
        code: error.message
      }
    }).eq('business_id', businessId).eq('id', claim.id).eq('status', 'generating'));
    throw error;
  }
}
export async function upsertForecastV1Overrides({
  db = defaultDb,
  businessId,
  forecastRunId,
  createdBy = null,
  rows: changes = []
} = {}) {
  if (!businessId || !forecastRunId || !changes.length) throw new ForecastV1Error('missing_override_context');
  const payload = changes.map(r => {
    if (!/^\d{4}-\d{2}-01$/.test(r.month)) throw new ForecastV1Error('invalid_override_month');
    const v = {
      month: r.month
    };
    for (const key of ['revenue_override', 'expense_override']) if (Object.hasOwn(r, key)) v[key] = r[key] === null ? null : money(cents(r[key]));
    if (Object.keys(v).length === 1) throw new ForecastV1Error('empty_override');
    if (r.reason !== undefined) v.reason = r.reason;
    return v;
  });
  const id = await query(db.rpc('edit_operating_forecast_overrides', {
    p_business_id: businessId,
    p_run_id: forecastRunId,
    p_rows: payload,
    p_actor: createdBy
  }));
  // Read freshness again: saving an assumption cannot make stale source history current.
  if (!id) throw new ForecastV1Error('forecast_override_save_failed', 500);
  return getForecastV1Status({
    db,
    businessId
  });
}
export async function resetForecastV1Overrides({
  db = defaultDb,
  businessId,
  forecastRunId,
  month = null,
  metric = null
} = {}) {
  const monthly = await query(db.from('forecast_months').select('month').eq('business_id', businessId).eq('forecast_run_id', forecastRunId));
  if (metric && !['revenue', 'expenses'].includes(metric)) throw new ForecastV1Error('invalid_override_metric');
  return upsertForecastV1Overrides({
    db,
    businessId,
    forecastRunId,
    rows: (monthly || []).filter(r => !month || r.month === month).map(r => ({
      month: r.month,
      ...(metric !== 'expenses' ? {
        revenue_override: null
      } : {}),
      ...(metric !== 'revenue' ? {
        expense_override: null
      } : {})
    }))
  });
}
export async function refreshOperatingSources({
  db = defaultDb,
  businessId,
  now = new Date(),
  refreshSnapshot,
  fetchReport = fetchQboReport,
  wait = waitForSource,
  random = Math.random
} = {}) {
  const config = await query(db.from('business_financial_reporting_config').select('*').eq('business_id', businessId).maybeSingle());
  const window = completedWindow(now, config?.reporting_timezone);
  const refreshed = [];
  for (const month of window) {
    try {
      if (refreshed.length) await wait(SOURCE_REFRESH_POLICY.paceMs);
      await refreshSnapshot({
        db,
        businessId,
        year: Number(month.slice(0, 4)),
        month: Number(month.slice(5, 7)),
        source: 'operating_forecast_daily',
        fetchReport: args => retryOperatingReport(fetchReport, {
          ...args,
          fetchImpl: (url, init) => fetch(url, {
            ...init,
            signal: AbortSignal.timeout(SOURCE_REFRESH_POLICY.timeoutMs)
          })
        }, {
          wait,
          random
        })
      });
      refreshed.push(month);
    } catch (error) {
      throw new ForecastV1Error('forecast_source_refresh_incomplete', 502, {
        outcome: 'stale_source',
        refreshed_months: refreshed,
        failed_month: month,
        unrefreshed_months: window.slice(refreshed.length),
        reason: error.error || error.message,
        provider_status: error.details?.provider_status || null
      });
    }
  }
  return {
    outcome: 'unchanged',
    refreshed_months: refreshed
  };
}
