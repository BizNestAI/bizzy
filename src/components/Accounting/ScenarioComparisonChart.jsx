// File: /components/Accounting/ScenarioComparisonChart.jsx
import React, { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

function toLabel(ym) {
  if (!ym) return '';
  if (/^\d{4}-\d{2}$/.test(ym)) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1, 1);
    return d.toLocaleString('default', { month: 'short', year: 'numeric' });
  }
  return ym;
}

const currency = (n) =>
  typeof n === 'number'
    ? n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '-';

export default function ScenarioComparisonChart({ baselineData = [], scenarioData = [] }) {
  // Normalize rows and align by month
  const combinedData = useMemo(() => {
    const base = (baselineData || []).map((r) => ({
      month: r.month || r.month_label,
      label: toLabel(r.month || r.month_label),
      baselineCash: Number(r.net_cash || 0),
    }));
    const scen = (scenarioData || []).reduce((map, r) => {
      const key = r.month || r.month_label;
      map[key] = Number(r.net_cash || 0);
      return map;
    }, {});
    return base.map((b) => ({
      month: b.label,
      baselineCash: b.baselineCash,
      scenarioCash: scen[b.month] ?? 0,
    }));
  }, [baselineData, scenarioData]);

  const total = (key) =>
    combinedData.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);

  const baselineNet = total('baselineCash');
  const scenarioNet = total('scenarioCash');
  const deltaNet = scenarioNet - baselineNet;
  const deltaPct =
    baselineNet !== 0 ? ((deltaNet / baselineNet) * 100).toFixed(1) : 'N/A';

  const TooltipContent = ({ active, payload, label }) => {
    if (!active || !payload || !payload.length) return null;
    const row = payload.reduce((acc, p) => ({ ...acc, [p.dataKey]: p.value }), {});
    const diff = (Number(row.scenarioCash) || 0) - (Number(row.baselineCash) || 0);
    return (
      <div className="rounded-md border border-white/10 bg-zinc-900/95 p-2 text-xs text-white">
        <div className="mb-1 text-white/70">{label}</div>
        <div>Baseline: <span className="font-semibold">{currency(row.baselineCash)}</span></div>
        <div>Scenario: <span className="font-semibold">{currency(row.scenarioCash)}</span></div>
        <div className="mt-1 border-t border-white/10 pt-1">
          Δ Month: <span className={diff >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
            {diff >= 0 ? '+' : '–'}{currency(Math.abs(diff))}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-zinc-900 p-6 text-white">
      <h3 className="mb-2 text-lg font-semibold">📊 Baseline vs. Scenario</h3>

      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={combinedData} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#2a2a2a" strokeDasharray="2 4" />
          <XAxis dataKey="month" stroke="#a3a3a3" />
          <YAxis
            stroke="#a3a3a3"
            width={72}
            tickFormatter={(v) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`)}
          />
          <Tooltip content={<TooltipContent />} />
          <Legend />
          <Line type="monotone" dataKey="baselineCash" name="Baseline Net Cash" stroke="#8884d8" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="scenarioCash" name="Scenario Net Cash" stroke="#00e396" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>

      <div className="mt-4 rounded-lg border border-white/10 bg-zinc-800 p-4 text-sm">
        <p className="text-white/80">
          💡 If this scenario plays out, your total projected <span className="font-semibold">net cash</span> over the next period would change by
          <span className={`ml-1 font-bold ${deltaNet >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {deltaNet >= 0 ? ' +' : ' –'}${Math.abs(deltaNet).toLocaleString()}
          </span>
          {typeof deltaPct === 'string' ? '' : ` (${deltaPct}%)`} compared to baseline.
        </p>
      </div>
    </div>
  );
}
