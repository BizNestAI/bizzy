import { asCents } from './operatingForecastDisplay.js';

export const formatForecastCurrency = value => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const formatForecastMonth = value => new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
export function formatForecastAxis(value) {
  if (!Number.isFinite(Number(value))) return '—';
  const absolute = Math.abs(Number(value));
  const amount = absolute >= 1000 ? absolute.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 }).toLowerCase() : absolute.toLocaleString('en-US', { maximumFractionDigits: absolute > 0 && absolute < 1 ? 2 : 0 });
  return `${Number(value) < 0 ? '-' : ''}$${amount}`;
}
export function forecastTotals(rows) {
  const revenue = rows.reduce((sum, row) => sum + asCents(row.revenue), 0);
  const expenses = rows.reduce((sum, row) => sum + asCents(row.expenses), 0);
  if (![revenue, expenses, revenue - expenses].every(Number.isSafeInteger)) throw new Error('money_precision_limit');
  return { revenue: revenue / 100, expenses: expenses / 100, operating_net_cash_flow: (revenue - expenses) / 100 };
}
export const formatForecastInput = value => Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function parseForecastInput(text) {
  const value = String(text).trim();
  const match = value.match(/^([+-]?)(?:\$)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{0,2}))?$/);
  if (!match) return null;
  try { return asCents(`${match[1]}${match[2].replaceAll(',', '')}${match[3] ? `.${match[3]}` : ''}`) / 100; }
  catch { return null; }
}

export const FORECAST_SERIES = [
  { key: 'revenue', label: 'Revenue', color: '#2dd4bf' },
  { key: 'expenses', label: 'Operating costs', color: '#fbbf24' },
  { key: 'operating_net_cash_flow', label: 'Operating net', color: '#34d399' },
];
