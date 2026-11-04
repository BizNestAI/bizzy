import { cents, money, completedWindow } from './operatingForecastModel.js';
export function operatingAccuracyRows(forecasts, actuals, {
  timezone,
  now = new Date(),
  months = 6
}) {
  const cutoff = completedWindow(now, timezone).at(-1);
  const actualByMonth = new Map(actuals.map(a => [`${a.review_year}-${String(a.review_month).padStart(2, '0')}-01`, a]));
  const eligible = forecasts.filter(f => {
    if (!f.run?.generated_at || f.month > cutoff) return false;
    const date = new Date(f.run.generated_at);
    if (!Number.isFinite(date.getTime())) return false;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit'
    }).formatToParts(date);
    const localMonth = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-01`;
    return localMonth < f.month;
  }).sort((a, b) => a.month.localeCompare(b.month) || b.run.generated_at.localeCompare(a.run.generated_at) || String(b.run.id).localeCompare(String(a.run.id)));
  const seen = new Set();
  return eligible.flatMap(f => {
    const a = actualByMonth.get(f.month);
    if (!a || seen.has(f.month)) return [];
    seen.add(f.month);
    const revenue = cents(a.revenue),
      costs = cents(a.cogs) + cents(a.expenses);
    const fr = cents(f.baseline_revenue),
      fc = cents(f.baseline_expenses);
    return [{
      month: f.month,
      month_label: new Date(`${f.month}T00:00:00Z`).toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC'
      }),
      forecastRevenue: money(fr),
      forecastExpenses: money(fc),
      forecastProfit: money(fr - fc),
      actualRevenue: money(revenue),
      actualExpenses: money(costs),
      actualProfit: money(revenue - costs),
      source: 'qbo_cash_health_snapshots'
    }];
  }).slice(-months);
}
