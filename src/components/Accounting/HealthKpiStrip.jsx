import React from 'react';
import './OperatingForecast.css';
import './FinancialHealth.css';

export function HealthDelta({ trend, change }) {
  if (!change) return null;
  return <span className={`health-delta ${trend === 'up' ? 'health-favorable' : trend === 'down' ? 'health-unfavorable' : ''}`}>
    <span aria-hidden="true">{change.startsWith('-') ? '↓' : change.startsWith('+') ? '↑' : '→'}</span> {change}
    <span className="sr-only">{trend === 'up' ? ' favorable' : trend === 'down' ? ' unfavorable' : ' unchanged'}</span>
  </span>;
}

export default function HealthKpiStrip({ kpis = [], loading = false }) {
  const primary = ['Current Revenue', 'Current Expenses', 'Net Profit'];
  const margin = kpis.find(k => k.label === 'Profit Margin');
  return <div className="forecast-kpis health-kpis financial-health-visual" aria-label="Monthly financial summary" aria-busy={loading}>
    {primary.map((label, i) => {
      const kpi = kpis.find(k => k.label === label);
      const negative = kpi?.value?.includes('-');
      return <section key={label} className={`forecast-kpi ${i === 0 ? 'forecast-tone-cyan' : i === 1 ? 'forecast-tone-amber' : negative ? 'health-tone-rose' : ''}`} aria-label={['Revenue', 'Expenses', 'Net profit'][i]}>
        <div className="forecast-kpi-label">{['Revenue', 'Expenses', 'Net profit'][i]}<span className="forecast-kpi-accent" aria-hidden="true" /></div>
        {loading ? <div className="health-skeleton health-kpi-skeleton" aria-label="Loading amount" /> : <>
          <p className={`forecast-kpi-value ${negative && i === 2 ? 'forecast-negative' : ''}`}>{kpi?.value ?? '—'}</p>
          <div className="health-kpi-comparison"><span>{kpi?.detail || 'Selected month unavailable'}</span><HealthDelta trend={kpi?.trend} change={kpi?.change} /></div>
          {i === 2 && margin && <div className="health-margin"><span>Profit margin <strong>{margin.value}</strong></span><HealthDelta trend={margin.trend} change={margin.change} /></div>}
        </>}
      </section>;
    })}
  </div>;
}
