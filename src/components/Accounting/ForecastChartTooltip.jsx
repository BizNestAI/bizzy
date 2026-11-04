import { formatForecastCurrency, formatForecastMonth, FORECAST_SERIES } from '../../utils/forecast/forecastPresentation.js';

export default function ForecastChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const values = new Map(payload.map(item => [item.dataKey, item.value]));
  return <div className="forecast-chart-tooltip" role="status">
    <p className="forecast-chart-tooltip-month">{formatForecastMonth(label)}</p>
    {FORECAST_SERIES.map(series => <div key={series.key} className="forecast-chart-tooltip-row">
      <span className="forecast-series-dot" style={{ background: series.color }} aria-hidden="true" />
      <span>{series.label}</span>
      <strong>{values.has(series.key) ? formatForecastCurrency(values.get(series.key)) : '—'}</strong>
    </div>)}
  </div>;
}
