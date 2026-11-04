import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { completedWindow, cents, roundRatio, projectAccount, reconcileMonth, buildOperatingModel, hash } from '../src/services/accounting/operatingForecastModel.js';
import { canonicalRows, sparseChanges, displayStats } from '../src/utils/forecast/operatingForecastDisplay.js';
import { operatingFixture, BUSINESS } from './fixtures/operatingForecast.js';
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
test('completed window uses canonical business timezone and excludes current partial month', () => {
  assert.deepEqual([completedWindow(new Date('2026-11-04T12:00:00Z'), 'America/New_York')[0], completedWindow(new Date('2026-11-04T12:00:00Z'), 'America/New_York').at(-1)], ['2025-11-01', '2026-10-01']);
  assert.equal(completedWindow(new Date('2026-11-01T02:00:00Z'), 'America/New_York').at(-1), '2026-09-01');
  assert.equal(completedWindow(new Date('2026-11-01T02:00:00Z'), 'UTC').at(-1), '2026-10-01');
  assert.throws(() => completedWindow(new Date(), null));
});
test('signed cents and symmetric rounding', () => {
  assert.equal(cents(-25.11), -2511);
  assert.equal(cents('1.005'), 101);
  assert.equal(cents('-1.005'), -101);
  assert.equal(roundRatio(-5, 2), -3);
  assert.throws(() => cents('no'));
});
test('inactive follows three observed zeros', () => {
  assert.equal(projectAccount([...Array(9).fill(180000), 0, 0, 0]).classification, 'inactive');
});
test('recurrence uses all recent active observations within 10% and median of last three', () => {
  const p = projectAccount([...Array(6).fill(100), 180000, 181000, 179000, 180000, 180000, 182000]);
  assert.equal(p.classification, 'recurring');
  assert.equal(p.projected_cents, 180000);
  assert.equal(projectAccount([...Array(6).fill(100), 10000, 10000, 10000, 10000, 10000, 12001]).classification, 'variable');
  assert.equal(projectAccount(Array(12).fill(-2500)).projected_cents, -2500);
});
test('variable exact 50/30/20 blend includes zero activity', () => {
  const v = [100, 200, 300, 400, 500, 600, 0, 0, 0, 1000, 2000, 3000];
  const p = projectAccount(v);
  assert.equal(p.classification, 'variable');
  assert.equal(p.projected_cents, roundRatio(50 * 6000 * 6 * 12 + 30 * 6000 * 3 * 12 + 20 * 8100 * 3 * 6, 100 * 3 * 6 * 12));
});
test('intermittent and new account denominators are explicit', () => {
  const p = projectAccount([...Array(10).fill(0), 10001, 0]);
  assert.equal(p.classification, 'intermittent');
  assert.equal(p.projected_cents, 5001);
  assert.equal(p.averaging_months, 2);
  assert.equal(p.limited_history, true);
  const q = projectAccount([...Array(9).fill(0), 100, 200, 300]);
  assert.equal(q.classification, 'variable');
  assert.equal(q.projected_cents, 200);
});
test('source identity, basis, missing account identity and exact reconciliation fail closed', () => {
  const {
    months,
    config
  } = operatingFixture();
  const m = months[11];
  assert.ok(reconcileMonth(m.snapshot, m.accounts, BUSINESS, m.month, config));
  for (const change of [{
    accounting_method: 'Accrual'
  }, {
    business_id: 'other'
  }, {
    source_start_date: '2026-11-01'
  }, {
    expenses: 0
  }]) assert.throws(() => reconcileMonth({
    ...m.snapshot,
    ...change
  }, m.accounts, BUSINESS, m.month, config));
  assert.throws(() => reconcileMonth(m.snapshot, m.accounts.slice(1), BUSINESS, m.month, config));
  assert.throws(() => reconcileMonth(m.snapshot, m.accounts.map(a => ({
    ...a,
    qbo_account_id: null
  })), BUSINESS, m.month, config));
  const fingerprint = reconcileMonth(m.snapshot, m.accounts, BUSINESS, m.month, config);
  assert.equal(reconcileMonth({
    ...m.snapshot,
    metadata: {
      financial_content: {
        fingerprint
      }
    }
  }, m.accounts, BUSINESS, m.month, config), fingerprint);
  assert.throws(() => reconcileMonth({
    ...m.snapshot,
    metadata: {
      financial_content: {
        fingerprint: 'bad'
      }
    }
  }, m.accounts, BUSINESS, m.month, config));
});
test('eligible zero report differs from absent report', () => {
  const {
    months,
    config
  } = operatingFixture();
  const s = {
    ...months[0].snapshot,
    revenue: 0,
    cogs: 0,
    expenses: 0,
    net_profit: 0
  };
  assert.ok(reconcileMonth(s, [], BUSINESS, months[0].month, config));
  assert.throws(() => reconcileMonth({}, [], BUSINESS, months[0].month, config));
});
test('production-shaped replay reconciles, retains rent/software/credits and includes COGS, excludes Other Income', () => {
  const {
    months,
    config
  } = operatingFixture();
  months.forEach(m => reconcileMonth(m.snapshot, m.accounts, BUSINESS, m.month, config));
  const result = buildOperatingModel(months);
  assert.equal(result.rows.length, 12);
  assert.equal(result.rows[0].month, '2026-11-01');
  assert.equal(result.rows.at(-1).month, '2027-10-01');
  assert.equal(result.metadata.accounts.find(a => a.qbo_account_id === 'rent').projected_cents, 180000);
  assert.ok(result.metadata.accounts.find(a => a.qbo_account_id === 'software').projected_cents >= 60000);
  assert.equal(result.metadata.accounts.find(a => a.qbo_account_id === 'credit').projected_cents, -2500);
  assert.equal(result.metadata.accounts.some(a => a.section === 'Other Income'), false);
  assert.equal(result.metadata.monthly_cogs, 100);
  assert.ok(result.rows[0].baseline_expenses > 2400);
  assert.notEqual(result.rows[0].baseline_expenses, 382);
  const r = result.rows[0];
  assert.equal(cents(r.baseline_operating_net_cash_flow), cents(r.baseline_revenue) - cents(r.baseline_expenses));
  assert.deepEqual(buildOperatingModel(months), result);
  console.log('production-shaped baseline', JSON.stringify(r));
});
test('persisted horizon is never relabeled and all displays reconcile to cents', () => {
  const rows = canonicalRows([{
    month: '2026-12-01',
    revenue: 1103,
    expenses: 1081.9
  }]);
  assert.equal(rows[0].month, '2026-12-01');
  assert.equal(rows[0].operating_net_cash_flow, 21.1);
  assert.equal(displayStats(rows).operating_net_cash_flow, 21.1);
  assert.deepEqual(sparseChanges(rows, canonicalRows([{
    ...rows[0],
    revenue: 1200
  }])), [{
    month: '2026-12-01',
    revenue_override: 1200
  }]);
  assert.deepEqual(sparseChanges(rows, rows), []);
  assert.throws(() => canonicalRows([{
    month: 'Dec'
  }]));
});
test('content hashing is deterministic and sensitive to financial content', () => {
  assert.equal(hash({
    a: 1
  }), hash({
    a: 1
  }));
  assert.notEqual(hash({
    a: 1
  }), hash({
    a: 2
  }));
});
test('daily source refresh precedes evaluation and records actual outcome; manual uses same path', () => {
  const cron = read('src/jobs/forecast.cron.js');
  assert.match(cron, /evaluateForecastBusiness/);
  assert.match(cron, /outcome: result.outcome/);
  assert.doesNotMatch(cron, /forecast refreshed/);
  const ui = read('src/components/Accounting/ForecastEditorChart.jsx');
  assert.doesNotMatch(ui, /alignForecastHorizon|Math.floor|Ending Cash|Cash In|Cash Out/);
  assert.match(ui, /Refresh forecast/);
});
test('Other Expense is reconciled but cannot change operating results', () => {
  const {
    months,
    config
  } = operatingFixture();
  const original = buildOperatingModel(months);
  const month = months[11];
  month.accounts.push({
    ...month.accounts[0],
    qbo_account_id: 'nonoperating-cost',
    account_type: 'Other Expense',
    total_amount: 12.34
  });
  month.snapshot.net_profit = (cents(month.snapshot.net_profit) - 1234) / 100;
  assert.ok(reconcileMonth(month.snapshot, month.accounts, BUSINESS, month.month, config));
  assert.deepEqual(buildOperatingModel(months).rows, original.rows);
  assert.throws(() => buildOperatingModel(months.slice(1)));
});
test('account union uses stable section and ID across renames, gaps and zero observations', () => {
  const {
    months
  } = operatingFixture();
  months.forEach((m, i) => {
    m.accounts = m.accounts.filter(a => a.qbo_account_id !== 'software');
    if (i !== 5) m.accounts.push({
      qbo_account_id: 'stable',
      account_type: 'Expense',
      account_name: i < 6 ? 'Old name' : 'Renamed',
      account_path: i < 6 ? 'Old parent' : 'New parent',
      total_amount: i < 4 ? 0 : 100
    });
  });
  months[11].accounts.push({
    qbo_account_id: 'stable',
    account_type: 'Income',
    total_amount: 10
  });
  const accounts = buildOperatingModel(months).metadata.accounts;
  const expense = accounts.find(a => a.qbo_account_id === 'stable' && a.section === 'Expense');
  assert.equal(expense.calculation.series_cents[5], 0);
  assert.equal(expense.averaging_months, 12); // known early zero rows are not treated as a new account
  assert.equal(expense.limited_history, false);
  assert.equal(accounts.filter(a => a.qbo_account_id === 'stable').length, 2);
  const fresh = months.map(m => ({
    ...m,
    accounts: m.accounts.filter(a => a.qbo_account_id !== 'fresh')
  }));
  fresh[10].accounts.push({
    qbo_account_id: 'fresh',
    account_type: 'Expense',
    total_amount: 100
  });
  const p = buildOperatingModel(fresh).metadata.accounts.find(a => a.qbo_account_id === 'fresh');
  assert.equal(p.averaging_months, 2);
  assert.equal(p.calculation.series_cents[11], 0);
  assert.equal(p.creation_verified, false);
});
test('recurrence tolerance is symmetric, inclusive and safe for zero median', () => {
  for (const sign of [1, -1]) {
    const exact = projectAccount([...Array(6).fill(100), ...[10000, 10000, 10000, 10000, 10000, 11000].map(n => n * sign)]);
    assert.equal(exact.classification, 'recurring');
    const outside = projectAccount([...Array(6).fill(100), ...[10000, 10000, 10000, 10000, 10000, 11001].map(n => n * sign)]);
    assert.equal(outside.classification, 'variable');
  }
  assert.equal(projectAccount([...Array(6).fill(0), -100, -100, -100, 100, 100, 100]).classification, 'variable');
  assert.equal(projectAccount(Array(12).fill(0)).classification, 'inactive');
  assert.throws(() => completedWindow(new Date(), 'invalid/timezone')); // explicit fail-closed fallback, never host time
});
test('Other section summaries reconcile independently and average cards retain signed cent arithmetic', () => {
  const {
      months,
      config
    } = operatingFixture(),
    m = months[11];
  assert.throws(() => reconcileMonth({
    ...m.snapshot,
    metadata: {
      pnl_components: {
        other_income: 0,
        other_expense: 0
      }
    }
  }, m.accounts, BUSINESS, m.month, config));
  const data = canonicalRows([{
    month: '2026-11-01',
    revenue: -0.01,
    expenses: 0
  }, {
    month: '2026-12-01',
    revenue: 0,
    expenses: 0.01
  }]);
  const stats = displayStats(data);
  assert.equal(stats.revenue, -0.01);
  assert.equal(cents(stats.operating_net_cash_flow), cents(stats.revenue) - cents(stats.expenses));
});
test('accuracy uses signed cent operating costs, a deterministic baseline vintage and business month boundaries', async () => {
  const {
    operatingAccuracyRows
  } = await import('../src/services/accounting/operatingForecastAccuracy.js');
  const forecast = (generated_at, baseline_revenue) => ({
    month: '2026-11-01',
    baseline_revenue,
    baseline_expenses: 100.01,
    effective_revenue: 99999,
    run: {
      id: generated_at,
      generated_at
    }
  });
  const f = [forecast('2026-11-01T02:00:00Z', 500.02), forecast('2026-10-20T00:00:00Z', 1), forecast('2026-11-02T00:00:00Z', 9999)];
  const rows = operatingAccuracyRows(f, [{
    review_year: 2026,
    review_month: 11,
    revenue: 200,
    cogs: 50,
    expenses: 100.02,
    net_profit: 9999
  }], {
    timezone: 'America/New_York',
    now: new Date('2026-12-02T12:00:00Z')
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].forecastRevenue, 500.02);
  assert.equal(rows[0].forecastProfit, 400.01);
  assert.equal(rows[0].actualExpenses, 150.02);
  assert.equal(rows[0].actualProfit, 49.98);
});
test('signed accuracy percentages do not manufacture perfect scores for zero or negative results', async () => {
  const {
    percentageError
  } = await import('../src/utils/forecast/operatingForecastDisplay.js');
  assert.equal(percentageError([{
    a: -100,
    f: -80
  }], 'a', 'f'), 20);
  assert.equal(percentageError([{
    a: 0,
    f: 0
  }], 'a', 'f'), null);
});
