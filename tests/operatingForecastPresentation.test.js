import test from 'node:test';
import assert from 'node:assert/strict';
import { formatForecastAxis, forecastTotals, parseForecastInput, formatForecastInput } from '../src/utils/forecast/forecastPresentation.js';

test('axis labels reserve signs and compact large currency while inputs retain cents', () => {
  for (const [value, text] of [[950,'$950'],[1900,'$1.9k'],[12500,'$12.5k'],[-950,'-$950'],[-12500,'-$12.5k'],[1250000,'$1.3m']]) assert.equal(formatForecastAxis(value), text);
  assert.equal(formatForecastInput(-1234.5), '-1,234.50');
  for (const text of ['-1234.56','-1,234.56','-$1,234.56']) assert.equal(parseForecastInput(text), -1234.56);
  assert.equal(parseForecastInput('123.'),123);
  for (const text of ['1.234','1,23.45','--1','1e3','','-']) assert.equal(parseForecastInput(text),null);
});
test('visible totals use cents, signed credits and derived operating net only', () => {
  const rows=[{revenue:1103,expenses:1081.9,operating_net_cash_flow:99999},{revenue:10.01,expenses:-1.01}];
  assert.deepEqual(forecastTotals(rows),{revenue:1113.01,expenses:1080.89,operating_net_cash_flow:32.12});
  assert.deepEqual(forecastTotals(rows.slice(0,1)),{revenue:1103,expenses:1081.9,operating_net_cash_flow:21.1});
});
