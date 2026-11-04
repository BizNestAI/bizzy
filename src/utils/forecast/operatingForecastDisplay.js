import { decimalCents } from './money.js';
export const asCents = decimalCents;
export function canonicalRows(rows = []) {
  return rows.map(row => {
    if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(row.month) || rows.filter(r => r.month === row.month).length !== 1) throw new Error('Invalid persisted forecast month');
    const revenue = asCents(row.revenue),
      expenses = asCents(row.expenses);
    return {
      ...row,
      revenue: revenue / 100,
      expenses: expenses / 100,
      operating_net_cash_flow: (revenue - expenses) / 100
    };
  }).sort((a, b) => a.month.localeCompare(b.month));
}
export function sparseChanges(baseline, draft) {
  return draft.flatMap(row => {
    const original = baseline.find(r => r.month === row.month);
    if (!original) return [];
    const result = {
      month: row.month
    };
    if (asCents(original.revenue) !== asCents(row.revenue)) result.revenue_override = asCents(row.revenue) / 100;
    if (asCents(original.expenses) !== asCents(row.expenses)) result.expense_override = asCents(row.expenses) / 100;
    return Object.keys(result).length > 1 ? [result] : [];
  });
}
export function displayStats(rows) {
  if (!rows.length) return null;
  const average = key => {
    const total = rows.reduce((s, r) => s + asCents(r[key]), 0);
    return Math.sign(total) * Math.floor((Math.abs(total) + rows.length / 2) / rows.length);
  };
  const revenue = average('revenue'),
    expenses = average('expenses');
  return {
    revenue: revenue / 100,
    expenses: expenses / 100,
    operating_net_cash_flow: (revenue - expenses) / 100
  };
}
// Negative operating results are valid; all-zero actuals have no percentage score.
export function percentageError(rows, actualKey, forecastKey) {
  const points = rows.filter(r => Number.isFinite(r[actualKey]) && Number.isFinite(r[forecastKey]) && r[actualKey] !== 0);
  if (!points.length) return null;
  return Math.round(points.reduce((sum, r) => sum + Math.abs(r[actualKey] - r[forecastKey]) / Math.abs(r[actualKey]), 0) / points.length * 1000) / 10;
}
