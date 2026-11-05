import { useCallback, useEffect, useMemo, useState, useRef, useId } from 'react';
import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip as ChartTooltip, Legend, ReferenceLine } from 'recharts';
import { safeFetch } from '../../utils/safeFetch';
import { getDemoData, shouldUseDemoData } from '../../services/demo/demoClient.js';
import { canonicalRows, sparseChanges, displayStats, asCents } from '../../utils/forecast/operatingForecastDisplay.js';
import { RefreshCw, Save, Undo2, Loader2, Info, ChevronDown, CheckCircle2, AlertCircle } from 'lucide-react';
import Tooltip from '../common/Tooltip.jsx';
import ForecastChartTooltip from './ForecastChartTooltip.jsx';
import { formatForecastCurrency as currency, formatForecastMonth as label, FORECAST_SERIES, formatForecastAxis, forecastTotals, formatForecastInput, parseForecastInput } from '../../utils/forecast/forecastPresentation.js';
import './OperatingForecast.css';
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
    [error, setError] = useState(''),
    [operation, setOperation] = useState(null),
    [chartWidth, setChartWidth] = useState(0),
    [inputResetKey, setInputResetKey] = useState(0),
    [invalidInputs, setInvalidInputs] = useState(new Set());
  const requestEpoch = useRef(0);
  const refreshRequest = useRef(null);
  const isDemo = useDemoData || shouldUseDemoData();
  const apply = useCallback(resp => {
    const next = canonicalRows(resp?.forecast?.months || []);
    setMeta(resp);
    setRows(next);
    setDraft(next);
    setInvalidInputs(new Set());
    setInputResetKey(key => key + 1);
  }, []);
  const load = useCallback(async (refresh = false) => {
    if (refresh && refreshRequest.current !== null) return;
    const epoch = ++requestEpoch.current;
    if (refresh) refreshRequest.current = epoch;
    const accept = resp => {
      if (epoch === requestEpoch.current) apply(resp);
    };
    if (!businessId && !isDemo) return;
    setBusy(true);
    setOperation(refresh ? 'refresh' : 'load');
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
      if (refreshRequest.current === epoch) refreshRequest.current = null;
      if (epoch === requestEpoch.current) { setBusy(false); setOperation(null); }
    }
  }, [businessId, isDemo, readOnly, apply]);
  useEffect(() => {
    setRows([]);
    setDraft([]);
    setMeta(null);
    setInvalidInputs(new Set());
    refreshRequest.current = null;
    load();
    return () => {
      requestEpoch.current += 1;
    };
  }, [load]);
  const visible = useMemo(() => draft.slice(0, months), [draft, months]);
  const totals = useMemo(() => forecastTotals(visible), [visible]);
  const stats = useMemo(() => displayStats(visible), [visible]);
  const changes = useMemo(() => sparseChanges(rows, draft), [rows, draft]);
  const dirty = changes.length > 0 || invalidInputs.size > 0;
  const setInputValidity = useCallback((key, valid) => setInvalidInputs(previous => {
    if (previous.has(key) === !valid) return previous;
    const next = new Set(previous); if (valid) next.delete(key); else next.add(key); return next;
  }), []);
  const save = async () => {
    if (readOnly || busy || invalidInputs.size || !changes.length || !isDemo && !meta?.run_id) return;
    const epoch = requestEpoch.current;
    setBusy(true);
    setOperation('save');
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
      if (epoch === requestEpoch.current) { setBusy(false); setOperation(null); }
    }
  };
  const reset = async (month, metric) => {
    if (readOnly || busy || dirty || !meta?.run_id) return;
    const epoch = requestEpoch.current;
    setBusy(true);
    setOperation('reset');
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
      if (epoch === requestEpoch.current) { setBusy(false); setOperation(null); }
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
  const blocked = meta?.freshness === 'missing_history' || !!meta?.blocking?.length;
  const stale = !isDemo && !!meta && meta.freshness !== 'current';
  const refreshing = busy && (operation === 'refresh' || operation === 'load');
  const canRefresh = !readOnly && !isDemo && !!businessId;
  const actionable = canRefresh && stale && !blocked;
  const narrowChart = chartWidth > 0 && chartWidth < 360;
  const netNegative = (stats?.operating_net_cash_flow ?? 0) < 0;
  const discard = () => { setDraft(rows); setInvalidInputs(new Set()); setInputResetKey(key => key + 1); };
  const updated = meta?.generated_at ? new Date(meta.generated_at) : null;
  return <article className="operating-forecast" aria-labelledby="forecast-overview-heading">
    <header className="forecast-header">
      <div className="forecast-heading">
        <p className="forecast-eyebrow">Projection editor</p>
        <h2 id="forecast-overview-heading">Forecast overview</h2>
      </div>
      <div className="forecast-header-controls">
        {controls}
        {canRefresh && <Tooltip content="Refresh forecast"><button type="button" className="forecast-icon-button" aria-label="Refresh forecast" aria-busy={refreshing} disabled={busy || dirty} onClick={() => load(true)}>
          <RefreshCw size={17} aria-hidden="true" className={refreshing ? 'forecast-spinning' : ''} />
        </button></Tooltip>}
      </div>
    </header>

    <div className="forecast-metadata">
      <div className="forecast-metadata-line">
        {updated && <Tooltip align="start" content={updated.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}><time dateTime={meta.generated_at} aria-label={`Updated ${updated.toLocaleString()}`}>Updated {updated.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</time></Tooltip>}
        <span className={`forecast-badge ${stale ? 'forecast-badge-amber' : 'forecast-badge-green'}`}><span aria-hidden="true" className="forecast-status-dot" />{isDemo ? 'Demo forecast' : !meta ? 'Loading' : blocked ? 'Needs attention' : stale ? 'Stale estimate' : 'Current'}</span>
        {meta?.assumptions_preserved && <span className="forecast-badge forecast-badge-green"><CheckCircle2 size={12} aria-hidden="true" />Saved assumptions preserved</span>}
      </div>
      {meta?.history?.start && <p>Based on {label(meta.history.start)}–{label(meta.history.end)} cash-basis QuickBooks activity</p>}
      {meta?.forecast?.start && <p className="forecast-coverage">Coverage: {label(meta.forecast.start)}–{label(meta.forecast.end)}<span aria-hidden="true"> · </span>{['operating_accounts_launch_v1', 'operating_accounts_monthly_v2'].includes(meta.model_version) ? 'Account-based estimates' : isDemo ? 'Demo estimates' : 'Previous forecast method'}</p>}
      <details className="forecast-method"><summary><Info size={13} aria-hidden="true" />How this forecast works<ChevronDown size={12} aria-hidden="true" /></summary>
        <p>{meta?.model_version === 'forecast_v1' ? 'This saved version uses the previous forecast method. Refresh with complete QuickBooks history to use account-based estimates.' : meta?.model_version === 'operating_accounts_launch_v1' ? 'This saved account-based version uses flat monthly estimates. Refresh to use modest historical monthly patterns.' : 'Fixed recurring accounts stay level. Variable accounts reflect recent performance and modest historical monthly patterns. Occasional expenses are smoothed.'} Your saved assumptions are preserved.</p>
      </details>
    </div>

    {stale && <div className="forecast-status-banner" role="status">
      <AlertCircle size={16} aria-hidden="true" />
      <div><strong>{blocked ? 'More verified history is needed' : 'This estimate uses an older forecast version'}</strong>
        {blocked ? <><p>Update the affected QuickBooks reports, then check again. Previous coverage is shown when available.</p><ul>{meta?.blocking?.length ? meta.blocking.map((item, i) => <li key={item.month || i}>{item.month ? `${label(item.month)}: ` : ''}{reasonText(item.reason)}</li>) : <li>Twelve verified completed cash-basis months are required.</li>}</ul></> : <p>{actionable ? 'Refresh to use the latest completed months. Saved assumptions will be preserved.' : 'Previous persisted coverage is shown. Refresh is unavailable in this view.'}</p>}
      </div>
      {actionable && <button type="button" className="forecast-button forecast-button-secondary" disabled={busy || dirty} onClick={() => load(true)}><RefreshCw size={14} aria-hidden="true" className={refreshing ? 'forecast-spinning' : ''} />Refresh forecast</button>}
    </div>}
    {error && <p role="alert" className="forecast-error">{error}</p>}

    {stats && <div className="forecast-kpis">{[['Average monthly revenue', 'revenue', 'cyan'], ['Average monthly operating costs', 'expenses', 'amber'], ['Average monthly operating net', 'operating_net_cash_flow', 'green']].map(([title, key, tone]) => <div key={key} className={`forecast-kpi forecast-tone-${tone}`}>
      <div className="forecast-kpi-label"><span>{title}</span><span className="forecast-kpi-accent" aria-hidden="true" /></div>
      <p className={`forecast-kpi-value ${key === 'operating_net_cash_flow' && netNegative ? 'forecast-negative' : ''}`}>{currency(stats[key])}</p>
      <p className="forecast-kpi-note">{key === 'operating_net_cash_flow' ? netNegative ? 'Operating deficit' : 'Operating surplus' : `${visible.length} displayed months`}</p>
    </div>)}</div>}

    <section className="forecast-chart-surface" aria-label="Monthly operating forecast chart">
      {visible.length ? <div className="forecast-chart"><ResponsiveContainer width="100%" height="100%" onResize={width => setChartWidth(width)}><LineChart data={visible} margin={{ top: 18, right: narrowChart ? 24 : 40, left: 12, bottom: 12 }} accessibilityLayer>
        <CartesianGrid stroke="rgba(148,163,184,0.12)" strokeDasharray="3 6" vertical={false} />
        <ReferenceLine y={0} stroke="rgba(251,191,36,0.35)" strokeDasharray="5 5" />
        <XAxis dataKey="month" tickFormatter={label} interval={narrowChart ? 0 : 'preserveStartEnd'} ticks={narrowChart ? [visible[0].month, ...(visible.length > 1 ? [visible.at(-1).month] : [])] : undefined} minTickGap={16} axisLine={false} tickLine={false} tickMargin={12} padding={{ left: 6, right: 12 }} tick={{ fill: '#a4adaa', fontSize: 11 }} />
        <YAxis width={86} tickFormatter={formatForecastAxis} axisLine={false} tickLine={false} tickMargin={10} tick={{ fill: '#a4adaa', fontSize: 11 }} />
        <ChartTooltip content={<ForecastChartTooltip />} allowEscapeViewBox={{ x: false, y: false }} offset={12} cursor={{ stroke: 'rgba(247,250,248,0.3)', strokeWidth: 1 }} wrapperStyle={{ outline: 'none', zIndex: 10, maxWidth: 'calc(100vw - 48px)' }} />
        <Legend itemSorter={item => FORECAST_SERIES.findIndex(series => series.key === item.dataKey)} iconType="plainline" iconSize={18} wrapperStyle={{ paddingTop: 20, fontSize: 11, color: '#a4adaa' }} />
        {FORECAST_SERIES.map(series => <Line key={series.key} dataKey={series.key} name={series.label} stroke={series.color} type="monotone" strokeWidth={2.5} dot={false} isAnimationActive={false} activeDot={{ r: 4.5, strokeWidth: 2, stroke: '#0c100e', fill: series.color }} />)}
      </LineChart></ResponsiveContainer></div> : <div className="forecast-empty" role="status">{busy ? <><Loader2 className="forecast-spinning" size={20} aria-hidden="true" />Loading forecast…</> : 'Twelve verified completed months are required before a new operating forecast can be generated.'}</div>}
    </section>

    <section className="forecast-table-surface" aria-labelledby="forecast-table-heading">
      <div className="forecast-table-toolbar">
        <div><h3 id="forecast-table-heading" className="forecast-eyebrow">{readOnly ? 'Read-only table' : 'Editable forecast'}</h3><p>{readOnly ? 'Assumptions cannot be edited in this view.' : dirty ? 'Unsaved assumptions · Changes are shown in the chart and totals.' : 'Edit an amount to add your own assumption.'}</p></div>
        <div className="forecast-table-actions">
          <button type="button" className="forecast-button forecast-button-primary" disabled={busy || readOnly || !changes.length || !!invalidInputs.size} onClick={save} aria-busy={operation === 'save'}>{operation === 'save' ? <Loader2 size={14} className="forecast-spinning" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}Save changes</button>
          <button type="button" className="forecast-button forecast-button-secondary" disabled={busy || readOnly || !dirty} onClick={discard}><Undo2 size={14} aria-hidden="true" />Discard</button>
        </div>
      </div>
      <div className="forecast-table-scroll" tabIndex={0} role="region" aria-label="Forecast amounts, scroll to view all months">
        <table className="forecast-table"><thead><tr>{['Month', 'Revenue', 'Operating costs', 'Operating net'].map(title => <th key={title} scope="col">{title}</th>)}</tr></thead>
          <tbody>{visible.map(row => <tr key={row.month} className={changes.some(change => change.month === row.month) ? 'forecast-edited-row' : ''}>
            <th scope="row">{label(row.month)}</th>
            {['revenue', 'expenses'].map(key => <td key={key}><MoneyInput key={`${businessId}:${row.month}:${key}:${inputResetKey}`} inputKey={`${row.month}:${key}`} aria-label={`${label(row.month)} ${key === 'expenses' ? 'Operating costs' : 'Revenue'}`} value={row[key]} disabled={readOnly || busy} onValidityChange={setInputValidity} onChange={value => update(row.month, key, value)} />
              {row[key === 'revenue' ? 'revenue_override' : 'expense_override'] != null && <button type="button" className="forecast-reset" aria-label={`Reset ${label(row.month)} ${key === 'expenses' ? 'Operating costs' : 'Revenue'} assumption`} disabled={busy || readOnly || dirty} onClick={() => reset(row.month, key)}>Reset assumption</button>}
            </td>)}
            <td className={`forecast-net ${row.operating_net_cash_flow < 0 ? 'forecast-negative' : ''}`}>{currency(row.operating_net_cash_flow)}</td>
          </tr>)}</tbody>
          {!!visible.length && <tfoot><tr><th scope="row">{visible.length}-month total</th><td>{currency(totals.revenue)}</td><td>{currency(totals.expenses)}</td><td className={`forecast-net ${totals.operating_net_cash_flow < 0 ? 'forecast-negative' : ''}`}>{currency(totals.operating_net_cash_flow)}<span className="forecast-total-note">{totals.operating_net_cash_flow < 0 ? 'Operating deficit' : 'Operating surplus'}</span></td></tr></tfoot>}
        </table>
      </div>
    </section>
  </article>;
}
function MoneyInput({ value, onChange, onValidityChange, inputKey, ...props }) {
  const [text, setText] = useState(formatForecastInput(value));
  const [invalid, setInvalid] = useState(false);
  const editing = useRef(false);
  const errorId = useId();
  useEffect(() => { if (!editing.current) setText(formatForecastInput(value)); }, [value]);
  useEffect(() => () => onValidityChange(inputKey, true), [inputKey, onValidityChange]);
  return <div className="forecast-money-cell"><div className={`forecast-money-input ${invalid ? 'forecast-input-invalid' : ''}`}><span aria-hidden="true">$</span><input {...props} type="text" inputMode="decimal" autoComplete="off" spellCheck={false} value={text} aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined} onFocus={() => { editing.current = true; }} onChange={event => {
    const next = event.target.value;
    setText(next);
    const parsed = parseForecastInput(next);
    setInvalid(parsed === null);
    onValidityChange(inputKey, parsed !== null);
    if (parsed !== null) onChange(parsed);
  }} onBlur={() => {
    editing.current = false;
    setText(formatForecastInput(value));
    setInvalid(false);
    onValidityChange(inputKey, true);
  }} /></div>{invalid && <span id={errorId} className="forecast-input-error">Enter a signed amount with up to two decimal places.</span>}</div>;
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
