import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { safeFetch } from '../../utils/safeFetch';
import { getDemoData, shouldUseDemoData } from '../../services/demo/demoClient.js';
import { canonicalRows, sparseChanges, displayStats, asCents } from '../../utils/forecast/operatingForecastDisplay.js';
const currency = n => Number(n).toLocaleString('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const label = month => new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC'
});
const reasonText = reason => ({
  missing_cash_snapshot: 'The completed cash-basis report is missing.',
  account_summary_mismatch: 'Account totals do not match the report.',
  financial_fingerprint_mismatch: 'The report needs to be refreshed.',
  reporting_configuration_required: 'Confirm your QuickBooks reporting settings.',
  reporting_timezone_required: 'Confirm your business reporting timezone.',
  account_identity_missing: 'Some accounts need a verified QuickBooks identity.',
  duplicate_account_identity: 'The report contains duplicate account detail.',
  snapshot_identity_mismatch: 'The report is not an eligible completed cash-basis report.',
  snapshot_period_or_realm_mismatch: 'The report does not match this business and period.'
})[reason] || 'The report could not be verified. Refresh QuickBooks activity and try again.';
export default function ForecastEditorChart({
  businessId,
  months = 12,
  useDemoData = false,
  controls = null,
  readOnly = false
}) {
  const [meta, setMeta] = useState(null),
    [rows, setRows] = useState([]),
    [draft, setDraft] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const requestEpoch = useRef(0);
  const isDemo = useDemoData || shouldUseDemoData();
  const apply = useCallback(resp => {
    const next = canonicalRows(resp?.forecast?.months || []);
    setMeta(resp);
    setRows(next);
    setDraft(next);
  }, []);
  const load = useCallback(async (refresh = false) => {
    const epoch = ++requestEpoch.current;
    const accept = resp => {
      if (epoch === requestEpoch.current) apply(resp);
    };
    if (!businessId && !isDemo) return;
    setBusy(true);
    setError('');
    try {
      if (isDemo) {
        const next = buildDemoForecastFromFinancials(getDemoData()?.financials || {}, 12);
        accept({
          forecast: {
            months: next
          },
          is_sample: true,
          freshness: 'current',
          model_version: 'demo'
        });
        return;
      }
      let resp = await safeFetch(`/api/accounting/forecast?${new URLSearchParams({
        businessId,
        ...(readOnly ? {
          admin_view_optional: '1'
        } : {})
      })}`);
      if (epoch !== requestEpoch.current) return;
      if (!readOnly && (refresh || resp.data_status === 'generation_required')) resp = await safeFetch('/api/accounting/forecast/generate', {
        method: 'POST',
        body: {
          businessId
        }
      });
      accept(resp);
    } catch (failure) {
      if (failure?.body?.blocking && epoch === requestEpoch.current) {
        accept(failure.body);
        return;
      }
      if (epoch !== requestEpoch.current) return;
      setError('The forecast could not be loaded or refreshed. Your saved assumptions have not been changed.');
    } finally {
      if (epoch === requestEpoch.current) setBusy(false);
    }
  }, [businessId, isDemo, readOnly, apply]);
  useEffect(() => {
    setRows([]);
    setDraft([]);
    setMeta(null);
    load();
    return () => {
      requestEpoch.current += 1;
    };
  }, [load]);
  const visible = useMemo(() => draft.slice(0, months), [draft, months]);
  const stats = useMemo(() => displayStats(visible), [visible]);
  const changes = useMemo(() => sparseChanges(rows, draft), [rows, draft]);
  const save = async () => {
    if (readOnly || busy || !changes.length || !isDemo && !meta?.run_id) return;
    const epoch = requestEpoch.current;
    setBusy(true);
    setError('');
    try {
      if (isDemo) {
        setRows(draft);
        return;
      }
      const saved = await safeFetch('/api/accounting/forecast/override', {
        method: 'POST',
        body: {
          businessId,
          forecast_run_id: meta.run_id,
          rows: changes
        }
      });
      if (epoch === requestEpoch.current) apply(saved);
    } catch {
      if (epoch !== requestEpoch.current) return;
      setError('Save failed. Your unsaved changes are still shown.');
    } finally {
      if (epoch === requestEpoch.current) setBusy(false);
    }
  };
  const reset = async (month, metric) => {
    if (readOnly || busy || changes.length || !meta?.run_id) return;
    const epoch = requestEpoch.current;
    setBusy(true);
    setError('');
    try {
      const saved = await safeFetch('/api/accounting/forecast/override/reset', {
        method: 'POST',
        body: {
          businessId,
          forecast_run_id: meta.run_id,
          month,
          metric
        }
      });
      if (epoch === requestEpoch.current) apply(saved);
    } catch {
      if (epoch !== requestEpoch.current) return;
      setError('Reset failed. Please try again.');
    } finally {
      if (epoch === requestEpoch.current) setBusy(false);
    }
  };
  const update = (month, key, value) => {
    if (value === '' || !Number.isFinite(Number(value))) return;
    try {
      asCents(value);
    } catch {
      setError('Enter a valid amount in dollars and cents.');
      return;
    }
    setDraft(prev => canonicalRows(prev.map(r => r.month === month ? {
      ...r,
      [key]: asCents(value) / 100
    } : r)));
  };
  return <div className="rounded-[28px] bg-[#0c100e] p-6 text-white ring-1 ring-white/10">
    <div className="flex flex-wrap justify-between gap-4">
      <div><h2 className="text-2xl font-semibold">Operating Forecasts</h2>
        {meta?.generated_at && <p className="mt-2 text-sm text-white/65">Updated {new Date(meta.generated_at).toLocaleString()} · Based on {label(meta.history.start)}–{label(meta.history.end)} cash-basis QuickBooks activity</p>}
        <p className="mt-2 text-sm text-white/65">Recurring accounts use a recent normal amount. Variable accounts blend recent activity; intermittent accounts use their observed average. Projections are flat monthly estimates.</p>
        <p className="mt-2 text-sm">{isDemo ? 'Demo forecast' : meta?.freshness === 'current' ? 'Current' : meta?.freshness === 'missing_history' ? 'Missing verified history · Previous coverage is stale' : 'Stale · Refresh to use the latest completed months'}{meta?.assumptions_preserved ? ' · Saved assumptions preserved' : ''}</p>
        {!!meta?.blocking?.length && <ul className="mt-2 text-sm text-amber-200">{meta.blocking.map((b, i) => <li key={b.month || i}>{b.month ? `${label(b.month)}: ` : ''}{reasonText(b.reason)}</li>)}</ul>}
        {meta?.forecast?.start && <p className="mt-2 text-xs text-white/50">Coverage: {label(meta.forecast.start)}–{label(meta.forecast.end)} · {meta.model_version === 'operating_accounts_launch_v1' ? 'Account-based operating estimates' : 'Previous forecast method'}</p>}
      </div>
      <div>{controls}{!readOnly && !isDemo && <button className="mt-3 rounded-lg border border-white/20 px-3 py-2" disabled={busy || changes.length > 0} onClick={() => load(true)}>{busy ? 'Refreshing…' : 'Refresh forecast'}</button>}</div>
    </div>
    {error && <p role="alert" className="mt-3 text-rose-200">{error}</p>}
    {stats && <div className="my-6 grid gap-4 sm:grid-cols-3">{[['Revenue', 'revenue'], ['Operating costs', 'expenses'], ['Operating net', 'operating_net_cash_flow']].map(([title, key]) => <div key={key} className="rounded-xl bg-black/30 p-4"><p className="text-sm text-white/60">Average monthly {title.toLowerCase()}</p><p className="mt-2 text-2xl">{currency(stats[key])}</p></div>)}</div>}
    {!!visible.length && <div className="mt-6 h-80"><ResponsiveContainer width="100%" height="100%"><LineChart data={visible}><CartesianGrid stroke="#ffffff18" /><XAxis dataKey="month" tickFormatter={label} /><YAxis tickFormatter={currency} /><Tooltip labelFormatter={label} formatter={currency} /><Legend />{[['revenue', 'Revenue', '#2dd4bf'], ['expenses', 'Operating costs', '#fbbf24'], ['operating_net_cash_flow', 'Operating net', '#34d399']].map(([key, name, color]) => <Line key={key} dataKey={key} name={name} stroke={color} dot={false} />)}</LineChart></ResponsiveContainer></div>}
    {!visible.length && <p className="my-8 text-white/65">{busy ? 'Loading forecast…' : 'Twelve verified completed months are required before a new operating forecast can be generated.'}</p>}
    <div className="mt-6 flex gap-3"><button disabled={busy || readOnly || !changes.length} onClick={save} className="rounded-lg border border-emerald-400/30 px-3 py-2">Save all</button><button disabled={busy || !changes.length} onClick={() => setDraft(rows)} className="rounded-lg border border-white/20 px-3 py-2">Discard unsaved edits</button>{changes.length > 0 && <span className="self-center text-sm text-amber-200">Unsaved assumptions</span>}</div>
    <div className="mt-4 overflow-auto"><table className="w-full text-left"><thead><tr>{['Month', 'Revenue', 'Operating costs', 'Operating net'].map(t => <th className="p-3" key={t}>{t}</th>)}</tr></thead><tbody>{visible.map(r => <tr key={r.month}><td className="p-3">{label(r.month)}</td>{['revenue', 'expenses'].map(key => <td className="p-3" key={key}><MoneyInput key={`${businessId}:${r.month}:${key}`} aria-label={`${label(r.month)} ${key === 'expenses' ? 'Operating costs' : 'Revenue'}`} type="number" step="0.01" value={r[key]} disabled={readOnly || busy} onChange={value => update(r.month, key, value)} className="w-36 rounded-lg border border-white/20 bg-black/30 p-2" />{r[key === 'revenue' ? 'revenue_override' : 'expense_override'] != null && <button disabled={busy || readOnly || changes.length > 0} onClick={() => reset(r.month, key)} className="ml-2 text-xs text-emerald-200">Reset assumption</button>}</td>)}<td className="p-3">{currency(r.operating_net_cash_flow)}</td></tr>)}</tbody></table></div>
  </div>;
}
function MoneyInput({
  value,
  onChange,
  ...props
}) {
  const [text, setText] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(String(value));
  }, [value]);
  return <input {...props} value={text} onFocus={() => {
    editing.current = true;
  }} onChange={event => {
    const next = event.target.value;
    setText(next);
    if (/^[+-]?\d+(?:\.\d*)?$/.test(next)) onChange(next);
  }} onBlur={() => {
    editing.current = false;
    setText(String(value));
  }} />;
}
function clampMonthCount(value) {
  return Math.max(2, Math.min(12, Number(value) || 12));
}
function buildForwardMonths(count) {
  const d = new Date();
  return Array.from({
    length: count
  }, (_, i) => {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth() + i, 1));
    return {
      key: t.toISOString().slice(0, 7),
      label: t.toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC'
      })
    };
  });
}
function buildMockForecast(months = 12) {
  let ending = 42000;
  return buildForwardMonths(clampMonthCount(months)).map(({
    key,
    label
  }, i) => {
    const seasonalLift = Math.round(Math.sin(i / 2) * 1200);
    const revenue = 20000 + i * 900 + seasonalLift;
    const expenses = 11800 + i * 500 + Math.round(Math.cos(i / 2) * 750);
    const cash_in = revenue + 850;
    const cash_out = expenses + 650;
    const net_cash = cash_in - cash_out;
    ending += net_cash;
    return {
      month: `${key}-01`,
      month_label: label,
      revenue,
      expenses,
      cash_in,
      cash_out,
      net_cash,
      ending_cash: Math.max(0, ending),
      source: 'mock'
    };
  });
}
function buildDemoForecastFromFinancials(financials = {}, months = 12) {
  const revenueRows = Array.isArray(financials?.monthlyRevenue) ? financials.monthlyRevenue : [];
  const profitMap = new Map((financials?.monthlyProfit || []).map(row => [row.month, Number(row.profit || 0)]));
  const marginPct = Number(financials?.profitMarginPct || 0) / 100;
  if (!revenueRows.length) return buildMockForecast(months);
  const recentRows = revenueRows.slice(-Math.min(6, revenueRows.length));
  const avgRevenue = recentRows.reduce((sum, row) => sum + Number(row.revenue || 0), 0) / recentRows.length;
  const lastRevenue = Number(revenueRows.at(-1)?.revenue || avgRevenue || 20000);
  const firstRecent = Number(recentRows[0]?.revenue || lastRevenue);
  const monthlyGrowth = firstRecent > 0 ? Math.max(-0.08, Math.min(0.08, (lastRevenue - firstRecent) / firstRecent / Math.max(recentRows.length - 1, 1))) : 0.015;
  const baseProfit = Number(profitMap.get(revenueRows.at(-1)?.month) || lastRevenue * (marginPct || 0.32));
  const baseMargin = lastRevenue > 0 ? baseProfit / lastRevenue : marginPct || 0.32;
  let ending = Number(financials?.cashOnHand || 0);
  return buildForwardMonths(clampMonthCount(months)).map(({
    key,
    label
  }, index) => {
    const revenue = Math.round(lastRevenue * Math.pow(1 + monthlyGrowth, index));
    const profit = revenue * (baseMargin || marginPct || 0.32);
    const expenses = Math.max(0, revenue - profit);
    const cash_in = revenue;
    const cash_out = expenses;
    const net_cash = profit;
    ending += net_cash;
    return {
      month: `${key}-01`,
      month_label: label,
      revenue: Math.round(revenue),
      expenses: Math.round(expenses),
      cash_in: Math.round(cash_in),
      cash_out: Math.round(cash_out),
      net_cash: Math.round(net_cash),
      ending_cash: Math.round(ending),
      source: 'demo'
    };
  });
}
