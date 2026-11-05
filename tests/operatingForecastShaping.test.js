import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeAccount, projectAccount, buildOperatingModel, cents, MODEL_CONFIG, hash } from '../src/services/accounting/operatingForecastModel.js';
import { operatingFixture } from './fixtures/operatingForecast.js';
import { canonicalRows, displayStats } from '../src/utils/forecast/operatingForecastDisplay.js';
import { forecastTotals } from '../src/utils/forecast/forecastPresentation.js';
const total = xs => xs.reduce((a, b) => a + b, 0);
const shape = series => { const account = projectAccount(series); return { ...account, ...shapeAccount(account) }; };
test('recurring rent, flat history, inactive and one-time intermittent remain flat', () => {
  for (const series of [Array(12).fill(180000), Array(12).fill(-2500), Array(12).fill(0), [0,0,0,0,0,0,0,0,0,120000,0,0]]) {
    const result = shape(series);
    assert.equal(new Set(result.monthly_projected_cents).size, 1);
    assert.equal(result.shaping.applied, false);
  }
});
test('variable patterns, extreme months and signed credits preserve exact annual totals and final caps', () => {
  for (const sign of [1, -1]) for (const series of [
    [10000,15000,7000,9000,12000,20000,18000,8000,13000,21000,5000,17000],
    [1000000,15000,7000,9000,12000,20000,18000,8000,13000,21000,5000,17000],
    [100,-100,100,-100,100,-100,100,-100,100,-100,100,-100]
  ]) {
    const result = shape(series.map(v => sign * v));
    assert.equal(result.classification, 'variable');
    assert.equal(total(result.monthly_projected_cents), result.projected_cents * 12);
    if (result.projected_cents !== 0) {
      assert.ok(new Set(result.monthly_projected_cents).size > 1);
      for (const v of result.monthly_projected_cents) {
        assert.equal(Math.sign(v), Math.sign(result.projected_cents));
        assert.ok(Math.abs(v) >= Math.ceil(Math.abs(result.projected_cents) / 2));
        assert.ok(Math.abs(v) <= Math.floor(Math.abs(result.projected_cents) * 1.5));
      }
    }
    if (series[0] === 1000000) assert.ok(result.shaping.months[0].cap_applied);
    assert.deepEqual(shape(series.map(v => sign * v)), result);
  }
});
test('zero baseline stays zero; configuration is validated and fingerprint-sensitive', () => {
  const account = { ...projectAccount(Array(12).fill(0)), classification: 'variable' };
  assert.deepEqual(shapeAccount(account).monthly_projected_cents, Array(12).fill(0));
  assert.throws(() => shapeAccount(account, { ...MODEL_CONFIG.shaping, historicalWeight: 31 }));
  assert.notEqual(hash(MODEL_CONFIG), hash({ ...MODEL_CONFIG, shaping: { ...MODEL_CONFIG.shaping, historicalWeight: 20, baselineWeight: 80 } }));
});
test('every fixture account reconciles; monthly persisted totals drive cards, chart/table rows and footer', () => {
  const { months } = operatingFixture();
  const { rows, metadata } = buildOperatingModel(months);
  for (const a of metadata.accounts) assert.equal(total(a.monthly_projected_cents), a.projected_cents * 12);
  rows.forEach((row, i) => {
    const revenue = total(metadata.accounts.filter(a => a.section === 'Income').map(a => a.monthly_projected_cents[i]));
    const costs = total(metadata.accounts.filter(a => a.section !== 'Income').map(a => a.monthly_projected_cents[i]));
    assert.equal(cents(row.baseline_revenue), revenue);
    assert.equal(cents(row.baseline_expenses), costs);
    assert.equal(cents(row.baseline_operating_net_cash_flow), revenue - costs);
  });
  const display = canonicalRows(rows.map(r => ({month:r.month,revenue:r.effective_revenue,expenses:r.effective_expenses})));
  const totals = forecastTotals(display);
  assert.equal(cents(totals.revenue), total(rows.map(r => cents(r.baseline_revenue))));
  assert.equal(cents(displayStats(display).revenue) * 12, cents(totals.revenue));
  assert.equal(cents(displayStats(display).expenses) * 12, total(rows.map(r => cents(r.baseline_expenses))));
  assert.ok(new Set(display.map(r => r.revenue)).size > 1);
});
