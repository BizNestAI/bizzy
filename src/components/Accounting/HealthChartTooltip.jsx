import React from 'react';
import './OperatingForecast.css';
import './FinancialHealth.css';
import { formatForecastCurrency, FORECAST_COLORS } from '../../utils/forecast/forecastPresentation.js';

export default function HealthChartTooltip({ active, payload, label, kind = 'revenue' }) {
  if (!active || !payload?.length) return null;
  const point = payload.find(p => p.dataKey === (kind === 'expense' ? 'value' : kind)) || payload[0];
  if (point.value == null) return null;
  const title = kind === 'expense' ? point.name : point.payload?.fullMonth || label;
  const name = kind === 'profit' ? 'Net profit' : kind === 'expense' ? 'Expenses' : 'Revenue';
  const color = kind === 'profit' ? Number(point.value) < 0 ? FORECAST_COLORS.negative : FORECAST_COLORS.positive : kind === 'expense' ? FORECAST_COLORS.expenses : FORECAST_COLORS.revenue;
  return <div className="forecast-chart-tooltip" role="status"><p className="forecast-chart-tooltip-month">{title}</p><div className="forecast-chart-tooltip-row"><span className="forecast-series-dot" style={{ background: color }} /><span>{name}</span><strong>{formatForecastCurrency(point.value)}</strong></div></div>;
}
