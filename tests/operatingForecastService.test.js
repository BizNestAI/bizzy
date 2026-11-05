/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import { operatingFixture, BUSINESS } from './fixtures/operatingForecast.js';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
const {
  loadOperatingHistory,
  getForecastV1Status,
  ensureForecastV1Run,
  upsertForecastV1Overrides,
  resetForecastV1Overrides,
  refreshOperatingSources
} = await import('../src/services/accounting/operatingForecastService.js');
const NOW = new Date('2026-11-04T12:00:00Z');
function fake() {
  const {
    months,
    config
  } = operatingFixture();
  const tables = {
    business_financial_reporting_config: [{
      business_id: BUSINESS,
      ...config
    }],
    monthly_review_qbo_pnl_snapshots: months.map(m => m.snapshot),
    monthly_review_qbo_pnl_accounts: months.flatMap(m => m.accounts).map((a, i) => ({
      ...a,
      id: String(i).padStart(4, '0')
    })),
    forecast_runs: [],
    forecast_months: [],
    forecast_overrides: []
  };
  const calls = [];
  const db = {
    tables,
    calls,
    from(table) {
      let data = [...(tables[table] || [])],
        single = false,
        patch = null;
      const q = {
        update(value) {
          patch = value;
          return q;
        },
        select() {
          return q;
        },
        eq(k, v) {
          data = data.filter(r => r[k] === v);
          return q;
        },
        in(k, v) {
          data = data.filter(r => v.includes(r[k]));
          return q;
        },
        gte(k, v) {
          data = data.filter(r => r[k] >= v);
          return q;
        },
        lte(k, v) {
          data = data.filter(r => r[k] <= v);
          return q;
        },
        order(k, {
          ascending = true
        } = {}) {
          data.sort((a, b) => String(a[k]).localeCompare(String(b[k])) * (ascending ? 1 : -1));
          return q;
        },
        range(a, b) {
          data = data.slice(a, b + 1);
          return q;
        },
        limit(n) {
          data = data.slice(0, n);
          return q;
        },
        single() {
          single = true;
          return q;
        },
        maybeSingle() {
          single = true;
          return q;
        },
        then(resolve) {
          if (patch) data.forEach(row => Object.assign(row, patch));
          return Promise.resolve({
            data: single ? data[0] || null : data,
            error: null
          }).then(resolve);
        }
      };
      return q;
    },
    async rpc(name, args) {
      calls.push({
        name,
        args
      });
      if (name === 'claim_operating_forecast') {
        tables.forecast_runs.push({ id: 'other-active-claim', business_id: BUSINESS, status: 'generating', model_version: args.p_payload.model_version, generation_started_at: NOW.toISOString(), generation_lease_expires_at: '2030-01-01T00:00:00Z' });
        return { data: null, error: null };
      }
      if (name === 'edit_operating_forecast_overrides') return {
        data: tables.forecast_runs[0].id,
        error: null
      };
      return {
        data: null,
        error: null
      };
    }
  };
  return db;
}
const oldRun = {
  id: 'old',
  business_id: BUSINESS,
  status: 'completed',
  model_version: 'forecast_v1',
  history_start: '2025-09-01',
  history_end: '2026-08-01',
  forecast_start: '2026-09-01',
  forecast_end: '2027-08-01',
  generated_at: '2026-09-02T00:00:00Z'
};
test('new history requires exact 12 completed Cash reports without any close authority', async () => {
  const db = fake();
  const h = await loadOperatingHistory({
    db,
    businessId: BUSINESS,
    now: NOW
  });
  assert.equal(h.complete, true);
  assert.equal(h.months.length, 12);
  assert.equal(h.months[0].month, '2025-11-01');
});
test('missing source returns previous persisted coverage explicitly stale and blocking month', async () => {
  const db = fake();
  db.tables.forecast_runs = [oldRun];
  db.tables.monthly_review_qbo_pnl_snapshots.pop();
  const result = await getForecastV1Status({
    db,
    businessId: BUSINESS,
    now: NOW
  });
  assert.equal(result.freshness, 'missing_history');
  assert.equal(result.forecast.end, '2027-08-01');
  assert.deepEqual(result.missing_months, ['2026-10-01']);
  assert.equal(db.calls.length, 0);
});
test('different input in progress cannot publish a competing version', async () => {
  const db = fake();
  const result = await ensureForecastV1Run({
    db,
    businessId: BUSINESS,
    now: NOW
  });
  assert.equal(result.data_status, 'generation_in_progress');
  assert.deepEqual(db.calls.map(c => c.name), ['claim_operating_forecast']);
});
test('identical manual input reuses a completed run without claiming/generating', async () => {
  const db = fake();
  await ensureForecastV1Run({
    db,
    businessId: BUSINESS,
    now: NOW
  });
  const fingerprint = db.calls[0].args.p_fingerprint;
  db.tables.forecast_runs = [{
    ...oldRun,
    model_version: 'operating_accounts_monthly_v2',
    input_fingerprint: fingerprint
  }];
  db.calls.length = 0;
  const a = await ensureForecastV1Run({
    db,
    businessId: BUSINESS,
    now: NOW
  });
  const b = await ensureForecastV1Run({
    db,
    businessId: BUSINESS,
    now: NOW
  });
  assert.equal(a.outcome, 'unchanged');
  assert.equal(b.run_id, a.run_id);
  assert.equal(db.calls.length, 0);
});
test('sparse override save and metric reset send atomic RPC patches and return canonical baseline', async () => {
  const db = fake();
  db.tables.forecast_runs = [oldRun];
  db.tables.forecast_months = [{
    forecast_run_id: 'old',
    business_id: BUSINESS,
    month: '2026-11-01',
    baseline_revenue: 100,
    baseline_expenses: 50
  }];
  const result = await upsertForecastV1Overrides({
    db,
    businessId: BUSINESS,
    forecastRunId: 'old',
    rows: [{
      month: '2026-11-01',
      revenue_override: 20
    }]
  });
  assert.deepEqual(db.calls[0].args.p_rows, [{
    month: '2026-11-01',
    revenue_override: 20
  }]);
  assert.equal(result.forecast.months[0].operating_net_cash_flow, 50);
  await resetForecastV1Overrides({
    db,
    businessId: BUSINESS,
    forecastRunId: 'old',
    metric: 'revenue'
  });
  assert.deepEqual(db.calls[1].args.p_rows, [{
    month: '2026-11-01',
    revenue_override: null
  }]);
});
test('daily refresh awaits all 12 completed source months and stops on failure', async () => {
  const db = fake(),
    seen = [];
  await refreshOperatingSources({
    db,
    businessId: BUSINESS,
    now: NOW,
    refreshSnapshot: async p => {
      seen.push(p);
    }
  });
  assert.equal(seen.length, 12);
  assert.equal(seen.at(-1).month, 10);
  let n = 0;
  await assert.rejects(refreshOperatingSources({
    db,
    businessId: BUSINESS,
    now: NOW,
    refreshSnapshot: async () => {
      if (++n === 2) throw new Error('provider failure');
    }
  }));
  assert.equal(n, 2);
});
test('equivalent provider snapshot UUID refresh reuses financial-content version', async () => {
  const db = fake();
  await ensureForecastV1Run({
    db,
    businessId: BUSINESS,
    now: NOW
  });
  const payload = db.calls[0].args.p_payload;
  db.tables.forecast_runs = [{
    ...oldRun,
    model_version: 'operating_accounts_monthly_v2',
    input_fingerprint: 'previous-exact-lineage',
    data_quality: payload.data_quality
  }];
  const ids = new Map(db.tables.monthly_review_qbo_pnl_snapshots.map((s, i) => [s.id, `replacement-${i}`]));
  db.tables.monthly_review_qbo_pnl_snapshots.forEach(s => {
    s.id = ids.get(s.id);
  });
  db.tables.monthly_review_qbo_pnl_accounts.forEach(a => {
    a.snapshot_id = ids.get(a.snapshot_id);
  });
  db.calls.length = 0;
  assert.equal((await ensureForecastV1Run({
    db,
    businessId: BUSINESS,
    now: NOW
  })).outcome, 'unchanged');
  assert.equal(db.calls.length, 0);
});
test('partial daily refresh reports successful, failed and remaining periods without generating', async () => {
  const db = fake();
  let attempted = 0;
  await assert.rejects(refreshOperatingSources({
    db,
    businessId: BUSINESS,
    now: NOW,
    wait: async () => {},
    refreshSnapshot: async () => {
      if (++attempted === 3) throw Object.assign(new Error('rate limited'), {
        details: {
          provider_status: 429
        }
      });
    }
  }), error => {
    assert.equal(error.details.outcome, 'stale_source');
    assert.deepEqual(error.details.refreshed_months, ['2025-11-01', '2025-12-01']);
    assert.equal(error.details.failed_month, '2026-01-01');
    assert.equal(error.details.unrefreshed_months.length, 10);
    return true;
  });
  assert.equal(db.calls.length, 0);
});
test('generation rechecks sources and returns canonical completed operating costs', async () => {
  const db = fake();
  db.rpc = async (name, args) => {
    if (name === 'claim_operating_forecast') {
      const run = {
        ...args.p_payload,
        id: 'new',
        business_id: BUSINESS,
        status: 'generating',
        generation_started_at: NOW.toISOString(),
        generation_lease_expires_at: '2030-01-01T00:00:00Z',
        input_fingerprint: args.p_fingerprint
      };
      db.tables.forecast_runs = [run];
      return {
        data: run,
        error: null
      };
    }
    if (name === 'complete_operating_forecast') {
      db.tables.forecast_runs[0].status = 'completed';
      db.tables.forecast_runs[0].generated_at = NOW.toISOString();
      db.tables.forecast_months = args.p_months.map(row => ({
        ...row,
        business_id: BUSINESS,
        forecast_run_id: 'new'
      }));
      return {
        data: 'new',
        error: null
      };
    }
  };
  const result = await ensureForecastV1Run({
    db,
    businessId: BUSINESS,
    now: NOW,
    clock: () => NOW
  });
  assert.equal(result.outcome, 'generated');
  assert.equal(result.forecast.months.length, 12);
  assert.equal(result.forecast.months[0].expenses, 4419.33);
  assert.equal(result.forecast.months[0].operating_net_cash_flow, Math.round((result.forecast.months[0].revenue - result.forecast.months[0].expenses) * 100) / 100);
});
test('source change between claim and completion fails the claim without publishing', async () => {
  const db = fake();
  db.rpc = async (name, args) => {
    assert.equal(name, 'claim_operating_forecast');
    const run = {
      ...args.p_payload,
      id: 'new',
      business_id: BUSINESS,
      status: 'generating',
      input_fingerprint: args.p_fingerprint,
      generation_started_at: NOW.toISOString(),
      generation_lease_expires_at: '2030-01-01T00:00:00Z'
    };
    db.tables.forecast_runs = [run];
    db.tables.monthly_review_qbo_pnl_snapshots[0].expenses += 1;
    return {
      data: run,
      error: null
    };
  };
  await assert.rejects(ensureForecastV1Run({
    db,
    businessId: BUSINESS,
    now: NOW,
    clock: () => NOW
  }), error => error.details?.outcome === 'stale_source');
  assert.equal(db.tables.forecast_runs[0].status, 'failed');
  assert.equal(db.tables.forecast_months.length, 0);
});
test('actual cron evaluation awaits source completion and never generates after partial failure',async()=>{
 const {evaluateForecastBusiness}=await import('../src/jobs/forecast.cron.js');
 const calls=[];let release;
 const pending=evaluateForecastBusiness({businessId:BUSINESS,refresh:async()=>{calls.push('source-start');await new Promise(resolve=>{release=resolve;});calls.push('source-complete');},ensure:async()=>{calls.push('generate');return {outcome:'generated'};}});
 assert.deepEqual(calls,['source-start']);release();assert.equal((await pending).outcome,'generated');assert.deepEqual(calls,['source-start','source-complete','generate']);
 await assert.rejects(evaluateForecastBusiness({businessId:BUSINESS,refresh:async()=>{throw new Error('partial source refresh');},ensure:async()=>assert.fail('must not generate after source failure')}));
});

test('unchanged sources with a prior flat-model run request a new version and retain fallback visibility', async () => {
  const db = fake();
  db.tables.forecast_runs = [{ ...oldRun, model_version: 'operating_accounts_launch_v1', generated_at: NOW.toISOString(), history_start: '2025-11-01', history_end: '2026-10-01', forecast_start: '2026-11-01', forecast_end: '2027-10-01', input_fingerprint: 'prior-flat-fingerprint' }];
  const saved = await getForecastV1Status({ db, businessId: BUSINESS, now: NOW });
  assert.equal(saved.run_id, oldRun.id);
  assert.equal(saved.freshness, 'stale');
  await ensureForecastV1Run({ db, businessId: BUSINESS, now: NOW });
  assert.equal(db.calls[0].name, 'claim_operating_forecast');
  assert.equal(db.calls[0].args.p_payload.model_version, 'operating_accounts_monthly_v2');
  assert.equal(db.calls[0].args.p_payload.model_config.shaping.historicalWeight, 30);
  assert.equal(db.calls[0].args.p_routine, false);
  assert.equal(db.calls[0].args.p_payload.input_fingerprint, db.calls[0].args.p_fingerprint);
  assert.equal(typeof db.calls[0].args.p_payload.model_config, 'object');
});

test('null without a live database claim and malformed RPC outputs fail closed before completion', async () => {
  for (const data of [null, undefined, {}, [], '', { id: 'bad', status: 'failed' }]) {
    const db = fake();
    db.rpc = async () => ({ data, error: null });
    await assert.rejects(ensureForecastV1Run({ db, businessId: BUSINESS, now: NOW, clock: () => NOW }), e => e.error === 'forecast_claim_response_invalid');
    assert.equal(db.tables.forecast_months.length, 0);
  }
});
test('routine daily limit returns a recognized stale completed version; manual requests are explicitly non-routine', async () => {
  for (const reason of ['daily', 'manual']) {
    const db = fake();
    let routine;
    db.rpc = async (name, args) => {
      assert.equal(name, 'claim_operating_forecast');
      routine = args.p_routine;
      return { data: { ...args.p_payload, id: 'limited', business_id: BUSINESS, status: 'completed', generated_at: NOW.toISOString(), input_fingerprint: 'b'.repeat(64), data_quality: { financial_input_hash: 'b'.repeat(64) } }, error: null };
    };
    if (reason === 'daily') {
      const result = await ensureForecastV1Run({ db, businessId: BUSINESS, now: NOW, reason, clock: () => NOW });
      assert.equal(result.outcome, 'routine_limited');
      assert.equal(result.freshness, 'stale');
    } else await assert.rejects(ensureForecastV1Run({ db, businessId: BUSINESS, now: NOW, reason, clock: () => NOW }), e => e.details.reason === 'unexpected_completed_input');
    assert.equal(routine, reason === 'daily');
  }
});
test('database validation rejection is diagnosed without financial payload or credential logging', async () => {
  const db = fake(), logs = [];
  db.rpc = async () => ({ data: null, error: { code: 'P0001', message: 'invalid_forecast_claim', details: '{"predicate":"model_version"}' } });
  await assert.rejects(ensureForecastV1Run({ db, businessId: BUSINESS, now: NOW, logger: { warn: (...args) => logs.push(args) } }), e => e.error === 'forecast_claim_rejected' && e.details.cause === 'invalid_forecast_claim');
  assert.equal(logs[0][1].outcome, 'rejected');
  assert.equal(logs[0][1].validation_predicate, 'model_version');
  assert.equal(logs[0][1].routine, false);
  assert.equal(logs[0][1].run_id, null);
  assert.doesNotMatch(JSON.stringify(logs), /series_cents|financial_input_hash|total_amount|source_snapshot_ids|service_role|token/i);
});

test('live claim returns explicit busy with saved coverage; expired claim output cannot be finalized', async () => {
  const db = fake();
  db.tables.forecast_runs = [oldRun];
  const busy = await ensureForecastV1Run({ db, businessId: BUSINESS, now: NOW, clock: () => NOW });
  assert.equal(busy.outcome, 'busy');
  assert.equal(busy.data_status, 'generation_in_progress');
  assert.equal(busy.run_id, oldRun.id);
  assert.equal(busy.claim_run_id, 'other-active-claim');
  db.rpc = async (name, args) => {
    assert.equal(name, 'claim_operating_forecast');
    return { data: { ...args.p_payload, id: 'expired', business_id: BUSINESS, status: 'generating', input_fingerprint: args.p_fingerprint, generation_started_at: '2026-11-04T11:00:00Z', generation_lease_expires_at: '2026-11-04T11:10:00Z' }, error: null };
  };
  await assert.rejects(ensureForecastV1Run({ db, businessId: BUSINESS, now: NOW, clock: () => NOW }), e => e.error === 'forecast_claim_expired' && e.status === 409);
});
