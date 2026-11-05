/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { operatingFixture, BUSINESS } from './fixtures/operatingForecast.js';
import { buildOperatingModel, MODEL_CONFIG, MODEL_VERSION, reconcileMonth } from '../src/services/accounting/operatingForecastModel.js';
const enabled = process.env.OPERATING_FORECAST_LOCAL_DB === '1';
const container = process.env.OPERATING_FORECAST_PG_CONTAINER || 'bizzi-vehicle-validation-continuation';
let dbname = `operating_forecast_test_${process.pid}`;
const quote = v => `'${String(v).replaceAll("'", "''")}'`;
function sql(input, database = dbname) {
  const p = spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database, '-At'], {
    input,
    encoding: 'utf8',
    timeout: 30000
  });
  if (p.status !== 0) throw new Error(p.stderr || String(p.error));
  return p.stdout.trim();
}
function concurrent(input) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', dbname, '-At']);
    let out = '',
      err = '';
    const timer = setTimeout(() => {
      p.kill('SIGTERM');
      reject(new Error('database test timeout'));
    }, 15000);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => {
      clearTimeout(timer);
      code ? reject(new Error(err)) : resolve(out.trim());
    });
    p.stdin.end(input);
  });
}
for (const seeded of [false, true]) test(`${seeded ? 'existing V1' : 'clean'} local migration: atomic claims, idempotency, source recheck, signed overrides, concurrent carry/reset and service-only RPCs`, {
  skip: !enabled,
  timeout: 90000
}, async () => {
  dbname = `operating_forecast_test_${process.pid}_${seeded ? 'seeded' : 'clean'}`;
  sql(`create database ${dbname};`, 'postgres');
  try {
    sql(`create extension if not exists pgcrypto;
 create table business_profiles(id uuid primary key);
 create table monthly_review_runs(id uuid);
 create table financial_monthly_review_stamps(id uuid);
 create table business_financial_reporting_config(business_id uuid primary key,reporting_timezone text,status text,qbo_realm_id text,home_currency text);
 create table bank_transactions(id uuid primary key);
 insert into business_profiles values (${quote(BUSINESS)});
 insert into business_financial_reporting_config values (${quote(BUSINESS)},'America/New_York','verified','fixture-realm','USD');`);
    for (const file of ['20260910_monthly_review_qbo_pnl_snapshots.sql', '20260919_forecast_v1_authority.sql', '20260920_accounting_period_close_authority.sql']) sql(readFileSync(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    const legacyId = '10000000-0000-4000-8000-000000000001';
    if (seeded) sql(`insert into forecast_runs(id,business_id,status,model_version,history_start,history_end,forecast_start,forecast_end,generated_at,input_fingerprint,source_snapshot_ids_hash) values('${legacyId}',${quote(BUSINESS)},'completed','forecast_v1','2025-09-01','2026-08-01','2026-09-01','2027-08-01','2026-09-02','legacy','legacy');
      insert into forecast_months(forecast_run_id,business_id,month,baseline_revenue,baseline_expenses,baseline_operating_net_cash_flow,effective_revenue,effective_expenses,effective_operating_net_cash_flow) select '${legacyId}',${quote(BUSINESS)},d,100,50,50,100,50,50 from generate_series('2026-09-01'::date,'2027-08-01'::date,'1 month') d;
      insert into forecast_overrides(forecast_run_id,business_id,month,expense_override,reason,created_at) values('${legacyId}',${quote(BUSINESS)},'2026-12-01',222.22,'existing assumption','2026-09-03');`);
    const unchangedBefore = sql("select md5(coalesce(string_agg(row_to_json(t)::text,',' order by id),'')) from forecast_runs t;") + sql("select md5(coalesce(string_agg(row_to_json(t)::text,',' order by id),'')) from forecast_months t;") + sql("select md5(coalesce(string_agg(row_to_json(t)::text,',' order by id),'')) from forecast_overrides t;");
    const migration = readFileSync(new URL('../supabase/migrations/20261104120000_operating_forecast_launch.sql', import.meta.url), 'utf8');
    sql(migration);
    const shapingMigration = readFileSync(new URL('../supabase/migrations/20261104130000_operating_forecast_monthly_shaping.sql', import.meta.url), 'utf8');
    sql(shapingMigration);
    sql(shapingMigration);
    const unchangedAfter = sql("select md5(coalesce(string_agg(row_to_json(t)::text,',' order by id),'')) from forecast_runs t;") + sql("select md5(coalesce(string_agg(row_to_json(t)::text,',' order by id),'')) from forecast_months t;") + sql("select md5(coalesce(string_agg(row_to_json(t)::text,',' order by id),'')) from forecast_overrides t;");
    assert.equal(unchangedAfter, unchangedBefore);
    const {
      months,
      config
    } = operatingFixture();
    const model = buildOperatingModel(months);
    let seed = '';
    for (const m of months) {
      const s = m.snapshot;
      seed += `insert into monthly_review_qbo_pnl_snapshots(id,business_id,qbo_realm_id,review_year,review_month,source_start_date,source_end_date,accounting_method,is_current,status,revenue,cogs,expenses,net_profit,metadata) values(${quote(s.id)},${quote(BUSINESS)},'fixture-realm',${s.review_year},${s.review_month},${quote(s.source_start_date)},${quote(s.source_end_date)},'Cash',true,'current',${s.revenue},${s.cogs},${s.expenses},${s.net_profit},'{}');`;
      for (const a of m.accounts) seed += `insert into monthly_review_qbo_pnl_accounts(snapshot_id,business_id,qbo_account_id,account_name,account_type,total_amount) values(${quote(s.id)},${quote(BUSINESS)},${quote(a.qbo_account_id)},${quote(a.account_name)},${quote(a.account_type)},${a.total_amount});`;
    }
    sql(seed);
    const payload = {
      model_version: 'operating_accounts_launch_v1',
      history_start: months[0].month,
      history_end: months[11].month,
      forecast_start: model.rows[0].month,
      forecast_end: model.rows[11].month,
      source_snapshot_ids: months.map(m => m.snapshot.id),
      source_snapshot_ids_hash: 'fixture',
      model_config: MODEL_CONFIG,
      data_quality: {
        timezone: 'America/New_York',
        source_identity: {
          realm: 'fixture-realm',
          currency: 'USD'
        },
        sources: months.map(m => ({
          id: m.snapshot.id,
          fingerprint: reconcileMonth(m.snapshot, m.accounts, BUSINESS, m.month, config),
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
              name: a.account_name,
              path: a.account_path ?? null,
              subtype: a.account_subtype ?? null
            }))
          }
        }))
      }
    };
    const claim = (fingerprint, routine = false) => `select claim_operating_forecast(${quote(BUSINESS)},${quote(fingerprint.repeat(64))},${quote(JSON.stringify(payload))}::jsonb,${routine});`;
    const finish = (id, rows = model.rows) => `select complete_operating_forecast(${quote(BUSINESS)},${quote(id)},${quote(JSON.stringify(rows))}::jsonb);`;
    const first = JSON.parse(sql(claim('a')));
    assert.equal(sql(claim('b')), '');
    const flatRevenue = model.metadata.accounts.filter(a => a.section === 'Income').reduce((n, a) => n + a.projected_cents, 0) / 100;
    const flatExpenses = model.metadata.monthly_cogs + model.metadata.monthly_operating_expenses;
    const flatRows = model.rows.map(r => ({ ...r, baseline_revenue: flatRevenue, effective_revenue: flatRevenue, baseline_expenses: flatExpenses, effective_expenses: flatExpenses, baseline_operating_net_cash_flow: Math.round((flatRevenue - flatExpenses) * 100) / 100, effective_operating_net_cash_flow: Math.round((flatRevenue - flatExpenses) * 100) / 100 }));
    sql(finish(first.id, flatRows));
    if (seeded) assert.equal(sql(`select expense_override||','||reason from forecast_overrides where forecast_run_id=${quote(first.id)} and month='2026-12-01';`), '222.22,existing assumption');
    assert.equal(JSON.parse(sql(claim('a'))).id, first.id);
    const month = model.rows[0].month;
    const edit = (id, values) => `select edit_operating_forecast_overrides(${quote(BUSINESS)},${quote(id)},${quote(JSON.stringify([{
      month,
      ...values
    }]))}::jsonb);`;
    sql(edit(first.id, {
      revenue_override: 123.45
    }));
    assert.equal(sql(`select expense_override is null from forecast_overrides where forecast_run_id=${quote(first.id)} and month=${quote(month)};`), 't');
    payload.model_version = MODEL_VERSION;
    const second = JSON.parse(sql(claim('b', true)));
    assert.notEqual(second.id, first.id);
    assert.equal(second.model_version, MODEL_VERSION);
    // An edit holds the shared advisory lock while completion waits, then completion
    // reads the committed latest predecessor assumptions (not a stale JS copy).
    await Promise.all([concurrent(`begin;select pg_advisory_xact_lock(hashtextextended('operating:'||${quote(BUSINESS)},0));${edit(first.id, {
      expense_override: -25.11
    })}select pg_sleep(0.2);commit;`), concurrent(finish(second.id))]);
    assert.equal(sql(`select revenue_override||','||expense_override from forecast_overrides where forecast_run_id=${quote(second.id)} and month=${quote(month)};`), '123.45,-25.11');
    // A late editor attached to the predecessor is forwarded to current coverage.
    assert.equal(sql(edit(first.id, {
      revenue_override: 555.55
    })), second.id);
    sql(edit(second.id, {
      expense_override: null
    }));
    assert.equal(sql(`select effective_expenses=baseline_expenses from forecast_months where forecast_run_id=${quote(second.id)} and month=${quote(month)};`), 't');
    const before = sql(`select revenue_override from forecast_overrides where forecast_run_id=${quote(second.id)} and month=${quote(month)};`);
    assert.throws(() => sql(`select edit_operating_forecast_overrides(${quote(BUSINESS)},${quote(second.id)},${quote(JSON.stringify([{
      month,
      revenue_override: 1
    }, {
      month: '2030-01-01',
      expense_override: 1
    }]))}::jsonb);`));
    assert.equal(sql(`select revenue_override from forecast_overrides where forecast_run_id=${quote(second.id)} and month=${quote(month)};`), before);
    assert.equal(JSON.parse(sql(claim('c', true))).id, second.id);
    const third = JSON.parse(sql(claim('c')));
    sql(`update monthly_review_qbo_pnl_snapshots set expenses=expenses+1 where id=${quote(months[0].snapshot.id)};`);
    assert.throws(() => sql(finish(third.id)));
    assert.equal(sql(`select status from forecast_runs where id=${quote(third.id)};`), 'generating');
    assert.equal(sql(`select has_function_privilege('authenticated','public.edit_operating_forecast_overrides(uuid,uuid,jsonb,uuid)','EXECUTE');`), 'f');
    // Completion failure is atomic: neither monthly rows nor a completed version leak.
    assert.equal(sql(`select count(*) from forecast_months where forecast_run_id=${quote(third.id)};`), '0');
    assert.equal(sql(`select id from forecast_runs where status='completed' order by generated_at desc limit 1;`), second.id);
    assert.equal(sql(claim('d')), ''); // live lease cannot be stolen
    sql(`update forecast_runs set generation_lease_expires_at=clock_timestamp()-interval '1 second' where id=${quote(third.id)};`);
    const recovered = JSON.parse(sql(claim('d')));
    assert.notEqual(recovered.id, third.id);
    assert.equal(sql(`select status from forecast_runs where id=${quote(third.id)};`), 'failed');
    assert.throws(() => sql(finish(third.id)));
    sql(`update forecast_runs set status='failed' where id=${quote(recovered.id)};`);
    const races = await Promise.all([concurrent(claim('e')), concurrent(claim('f'))]);
    assert.equal(races.filter(Boolean).length, 1);
    assert.equal(sql(`select count(*) from forecast_runs where status='generating' and model_version='operating_accounts_monthly_v2';`), '1');
    // Cross-tenant requests and malformed/special numeric values cannot mutate rows.
    const otherBusiness = '00000000-0000-4000-8000-000000000002';
    assert.throws(() => sql(`select edit_operating_forecast_overrides(${quote(otherBusiness)},${quote(second.id)},'[{"month":"2026-11-01","revenue_override":1}]');`));
    for (const value of ['NaN', 'Infinity', 1.001]) assert.throws(() => sql(edit(second.id, {
      revenue_override: value
    })));
    assert.throws(() => sql(edit(second.id, {})));
    assert.throws(() => sql(`select claim_operating_forecast(${quote(BUSINESS)},null,'{}');`));
    for (const role of ['anon', 'authenticated']) for (const signature of ['claim_operating_forecast(uuid,text,jsonb,boolean)', 'complete_operating_forecast(uuid,uuid,jsonb)', 'edit_operating_forecast_overrides(uuid,uuid,jsonb,uuid)']) assert.equal(sql(`select has_function_privilege(${quote(role)},${quote('public.' + signature)},'EXECUTE');`), 'f');
    assert.equal(sql("select has_function_privilege('service_role','public.complete_operating_forecast(uuid,uuid,jsonb)','EXECUTE');"), 't');
    sql("update forecast_runs set status='failed' where status='generating';");
    sql(`update monthly_review_qbo_pnl_snapshots set expenses=expenses-1 where id=${quote(months[0].snapshot.id)};`);
    payload.model_config = { ...MODEL_CONFIG, shaping: { ...MODEL_CONFIG.shaping, historicalWeight: 20, baselineWeight: 80 } };
    const configured = JSON.parse(sql(claim('9', true)));
    assert.notEqual(configured.id, first.id);
    assert.notEqual(configured.id, second.id);
    sql(finish(configured.id));
    assert.equal(sql(`select effective_revenue from forecast_months where forecast_run_id=${quote(configured.id)} and month=${quote(month)};`), '555.55');
    assert.equal(sql(`select effective_expenses=baseline_expenses from forecast_months where forecast_run_id=${quote(configured.id)} and month=${quote(month)};`), 't');
    assert.equal(sql(`select status from forecast_runs where id=${quote(first.id)};`), 'completed');
    assert.equal(sql('select count(*) from accounting_period_closes;'), '0');
  } finally {
    sql(`drop database ${dbname} with (force);`, 'postgres');
  }
});
