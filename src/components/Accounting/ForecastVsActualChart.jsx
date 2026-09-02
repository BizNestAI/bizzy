// File: /components/Accounting/ForecastVsActualChart.jsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  CartesianGrid,
  LabelList,
} from 'recharts';
import { safeFetch } from '../../utils/safeFetch';
import { getDemoData, shouldUseDemoData } from '../../services/demo/demoClient.js';
import { Loader2, AlertTriangle } from 'lucide-react';
import KpiCard from '../UI/KpiCard.jsx';

const currency = (n) =>
  typeof n === 'number'
    ? n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '-';

function mape(rows, actualKey, forecastKey) {
  const pts = rows.filter((r) => r[actualKey] > 0 && r[forecastKey] >= 0);
  if (!pts.length) return 0;
  const s = pts.reduce((acc, r) => acc + Math.abs((r[actualKey] - r[forecastKey]) / r[actualKey]), 0);
  return Math.round((s / pts.length) * 1000) / 10;
}

export default function ForecastVsActualChart({ userId, businessId, months = 6, useDemoData = false, readOnly = false }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [metric, setMetric] = useState('Revenue');
  const [error, setError] = useState('');
  const isDemo = useDemoData || !businessId || shouldUseDemoData();
  const demoFinancials = useMemo(() => (isDemo ? getDemoData()?.financials || null : null), [isDemo]);
  const demoAccuracy = useMemo(() => buildAccuracyFromFinancials(demoFinancials, months), [demoFinancials, months]);

  useEffect(() => {
    let ignore = false;

    async function load() {
      setLoading(true);
      setError('');
      if (isDemo) {
        if (ignore) return;
        const base =
          demoAccuracy && demoAccuracy.length
            ? demoAccuracy
            : buildAccuracyFromFinancials(demoFinancials, months);
        setRows(alignToRollingWindow(base, months));
        setLoading(false);
        return;
      }
      if (!businessId) {
        setRows([]);
        setLoading(false);
        return;
      }
      try {
        const params = new URLSearchParams({
          businessId,
          months: String(Math.max(3, Math.min(12, Number(months) || 6))),
        });
        if (userId) params.set('userId', userId);
        const resp = await safeFetch(`/api/accounting/forecast-accuracy?${params.toString()}`);
        const data = Array.isArray(resp?.rows) ? resp.rows : [];
        if (ignore) return;
        if (!data.length) {
          setRows([]);
          setError(resp?.message || 'Forecast accuracy will appear after forecasted months have completed.');
          return;
        }
        setRows(alignToRollingWindow(data, months));
      } catch (err) {
        if (ignore) return;
        if (readOnly) {
          setRows([]);
          setError('No persisted forecast accuracy is available for this business.');
          return;
        }
        setRows([]);
        setError('Unable to load live forecast accuracy.');
        console.warn('[ForecastVsActualChart] live accuracy error:', err?.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    load();
    return () => {
      ignore = true;
    };
  }, [userId, businessId, months, isDemo, demoAccuracy, demoFinancials, readOnly]);

  const keys = useMemo(() => {
    const base = metric;
    return {
      actual: `actual${base}`,
      forecast: `forecast${base}`,
    };
  }, [metric]);

  const stats = useMemo(() => {
    const value = mape(rows, keys.actual, keys.forecast);
    return { mapePct: value, accuracyPct: Math.max(0, Math.min(100, Math.round(1000 - value * 10) / 10)) };
  }, [rows, keys]);

  const TooltipContent = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const p = payload.reduce((a, b) => ({ ...a, [b.dataKey]: b.value }), {});
    const actual = p[keys.actual] ?? 0;
    const forecast = p[keys.forecast] ?? 0;
    const delta = actual - forecast;
    const pct = forecast ? (delta / forecast) * 100 : 0;
    return (
      <div className="rounded-lg border border-white/10 bg-[#0c0d12]/95 px-3 py-2 text-xs shadow-lg">
        <div className="text-white/70">{label}</div>
        <div className="mt-1 space-y-0.5">
          <div><span className="text-white/60">Actual:</span> <span className="font-medium">{currency(actual)}</span></div>
          <div><span className="text-white/60">Forecast:</span> <span className="font-medium">{currency(forecast)}</span></div>
          <div>
            <span className="text-white/60">Δ:</span>{' '}
            <span className="font-medium">
              {currency(delta)} ({delta >= 0 ? '+' : ''}{pct.toFixed(1)}%)
            </span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="rounded-[28px] bg-[linear-gradient(180deg,rgba(11,14,13,0.96)_0%,rgba(6,9,8,0.92)_100%)] px-5 py-6 text-white shadow-[0_30px_82px_rgba(0,0,0,0.42)] ring-1 ring-white/[0.045]">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.4em] text-white/60">Accuracy radar</p>
          <h2 className="mt-2 text-2xl font-semibold text-white">Forecast vs actual (last {months} completed months)</h2>
          {error && (
            <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-rose-400/40 bg-rose-500/10 px-3 py-1 text-xs text-rose-200">
              <AlertTriangle size={14} /> {error}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-full bg-black/25 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_14px_30px_rgba(0,0,0,0.24)] ring-1 ring-white/[0.055] backdrop-blur">
            {['Revenue', 'Expenses', 'Profit'].map((m) => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={`px-3 py-1.5 text-sm rounded-full transition ${
                  metric === m ? 'bg-emerald-300/18 font-semibold text-emerald-50 shadow-[0_0_18px_rgba(16,185,129,0.13)]' : 'text-white/72 hover:bg-white/8 hover:text-white'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          compact
          label="MAPE"
          value={`${stats.mapePct.toFixed(1)}%`}
          detail="Lower is better"
          tone={stats.mapePct <= 5 ? 'emerald' : stats.mapePct <= 10 ? 'amber' : 'rose'}
          className="min-h-[108px]"
        />
        <KpiCard
          compact
          label="Approx. accuracy"
          value={`${stats.accuracyPct.toFixed(1)}%`}
          detail="Forecast fit"
          tone={stats.accuracyPct >= 90 ? 'emerald' : stats.accuracyPct >= 75 ? 'amber' : 'rose'}
          className="min-h-[108px]"
        />
        <KpiCard compact label="Series" value={metric} detail="Active comparison" tone="neutral" className="min-h-[108px]" />
        <KpiCard compact label="Samples" value={rows.length ? `${rows.length} mo` : '—'} detail="Rolling window" tone="neutral" className="min-h-[108px]" />
      </div>

      <div className="mt-6 rounded-2xl bg-[#070b0a]/72 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.025),0_18px_44px_rgba(0,0,0,0.26)]">
        {loading ? (
          <div className="h-64 w-full rounded-2xl bg-white/[0.05] shadow-[0_18px_40px_rgba(0,0,0,0.28)] ring-1 ring-white/[0.05] backdrop-blur-xl p-4 animate-pulse">
            <div className="space-y-3">
              <div className="h-3 w-32 bg-white/15 rounded-full" />
              <div className="h-5 w-48 bg-white/18 rounded-md" />
              <div className="h-[140px] w-full bg-white/8 rounded-lg" />
            </div>
          </div>
        ) : !rows.length ? (
          <div className="flex h-64 items-center justify-center text-white/60">No data available yet.</div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={rows} margin={{ top: 12, right: 16, left: 0, bottom: 0 }} barCategoryGap={20}>
              <defs>
                <linearGradient id="actualBar" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#a9c7ff" />
                  <stop offset="100%" stopColor="#6e8fff" />
                </linearGradient>
                <linearGradient id="forecastBar" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#9ef2cf" />
                  <stop offset="100%" stopColor="#56c8aa" />
                </linearGradient>
                <filter id="glow" x="-20%" y="-20%" width="140%" height="160%">
                  <feGaussianBlur stdDeviation="8" result="coloredBlur" />
                  <feMerge>
                    <feMergeNode in="coloredBlur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>
              <CartesianGrid strokeDasharray="3 6" vertical={false} stroke="rgba(148,163,184,0.12)" />
              <XAxis dataKey="month_label" tick={{ fill: '#dbe2ff', fontSize: 12 }} stroke="#9ca8c8" />
              <YAxis
                stroke="#9ca8c8"
                tick={{ fill: '#dbe2ff', fontSize: 12 }}
                width={72}
                tickFormatter={(v) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`)}
              />
              <Tooltip content={<TooltipContent />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
              <Legend wrapperStyle={{ color: '#e3e8ff', fontWeight: 600 }} iconType="circle" />
              <Bar dataKey={keys.actual} name={`Actual ${metric}`} fill="url(#actualBar)" radius={[10, 10, 4, 4]} filter="url(#glow)">
                <LabelList
                  dataKey={(r) => formatDelta(r[keys.actual], r[keys.forecast])}
                  position="top"
                  className="text-[10px] fill-[#dbe2ff]"
                />
              </Bar>
              <Bar dataKey={keys.forecast} name={`Forecast ${metric}`} fill="url(#forecastBar)" radius={[10, 10, 4, 4]} opacity={0.9} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function formatDelta(actual = 0, forecast = 0) {
  const delta = (actual ?? 0) - (forecast ?? 0);
  if (!delta) return '+0';
  const k = Math.abs(delta) >= 1000 ? `${(Math.abs(delta) / 1000).toFixed(1)}k` : `${Math.abs(delta)}`;
  return `${delta >= 0 ? '+' : '-'}${k}`;
}

function alignToRollingWindow(rows, months = 6) {
  const count = Math.max(3, Math.min(12, Number(months) || 6));
  const timeline = buildTrailingMonths(count);
  const normalizedRows = (rows || []).map((row) => {
    const key = monthKey(row.month, row.month_label);
    return {
      ...row,
      month: `${key}-01`,
      month_label: row.month_label || labelFromKey(key),
    };
  });
  const map = new Map(
    normalizedRows.map((row) => [monthKey(row.month, row.month_label), row])
  );

  const defaults = averageRow(normalizedRows);

  return timeline.map(({ key, label }, index) => {
    const existing = map.get(key) || normalizedRows[index];
    if (existing) {
      return {
        ...existing,
        month: `${key}-01`,
        month_label: label,
      };
    }
    return {
      month: `${key}-01`,
      month_label: label,
      forecastRevenue: defaults.forecastRevenue,
      actualRevenue: defaults.actualRevenue,
      forecastExpenses: defaults.forecastExpenses,
      actualExpenses: defaults.actualExpenses,
      forecastProfit: defaults.forecastProfit,
      actualProfit: defaults.actualProfit,
      source: 'generated',
    };
  });
}

function buildTrailingMonths(count) {
  const result = [];
  const anchor = new Date();
  anchor.setDate(1);
  anchor.setHours(12, 0, 0, 0);
  anchor.setMonth(anchor.getMonth() - 1); // end at last completed month
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1, 12);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    result.push({ key, label: d.toLocaleString('default', { month: 'short', year: 'numeric' }) });
  }
  return result;
}

function monthKey(month, label) {
  if (typeof month === 'string' && month.length >= 7) return month.slice(0, 7);
  if (label) {
    const parsed = Date.parse(label);
    if (!Number.isNaN(parsed)) {
      const d = new Date(parsed);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
  }
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function labelFromKey(key) {
  const [y, m] = key.split('-');
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return d.toLocaleString('default', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function averageRow(rows) {
  const totals = rows.reduce(
    (acc, row) => {
      acc.forecastRevenue += row.forecastRevenue || 0;
      acc.actualRevenue += row.actualRevenue || 0;
      acc.forecastExpenses += row.forecastExpenses || 0;
      acc.actualExpenses += row.actualExpenses || 0;
      acc.forecastProfit += row.forecastProfit || 0;
      acc.actualProfit += row.actualProfit || 0;
      return acc;
    },
    { forecastRevenue: 0, actualRevenue: 0, forecastExpenses: 0, actualExpenses: 0, forecastProfit: 0, actualProfit: 0 }
  );
  const count = rows.length || 1;
  return {
    forecastRevenue: Math.round(totals.forecastRevenue / count) || 0,
    actualRevenue: Math.round(totals.actualRevenue / count) || 0,
    forecastExpenses: Math.round(totals.forecastExpenses / count) || 0,
    actualExpenses: Math.round(totals.actualExpenses / count) || 0,
    forecastProfit: Math.round(totals.forecastProfit / count) || 0,
    actualProfit: Math.round(totals.actualProfit / count) || 0,
  };
}

function buildAccuracyFromFinancials(financials = {}, months = 6) {
  if (!financials || typeof financials !== "object") return [];
  const revenueRows = Array.isArray(financials.monthlyRevenue) ? financials.monthlyRevenue : [];
  const profitMap = new Map(
    (Array.isArray(financials.monthlyProfit) ? financials.monthlyProfit : []).map((row) => [
      row.month,
      Number(row.profit || 0),
    ])
  );
  const timeline = buildTrailingMonths(months);
  const recent = revenueRows.slice(-timeline.length);
  return timeline.map(({ key, label }, idx) => {
    const row = recent[idx] || recent.at(-1) || {};
    const month = row.month;
    const actualRevenue = Number(row.revenue || 0);
    const actualProfit = Number(profitMap.get(month) || 0);
    const actualExpenses = Math.max(0, actualRevenue - actualProfit);
    const variance = ((idx % 3) - 1) * 0.04; // gentle +/- 4% oscillation
    const forecastRevenue = Math.round(actualRevenue * (1 + variance));
    const forecastExpenses = Math.round(actualExpenses * (1 - variance / 2));
    return {
      month: `${key}-01`,
      month_label: label,
      actualRevenue,
      forecastRevenue,
      actualExpenses,
      forecastExpenses,
      actualProfit: actualRevenue - actualExpenses,
      forecastProfit: forecastRevenue - forecastExpenses,
    };
  });
}
