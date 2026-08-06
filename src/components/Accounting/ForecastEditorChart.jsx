// File: /components/Accounting/ForecastEditorChart.jsx
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceDot,
} from 'recharts';
import { Loader2, Save, Undo2, Info, AlertTriangle } from 'lucide-react';
import { safeFetch } from '../../utils/safeFetch';
import { getDemoData, shouldUseDemoData } from '../../services/demo/demoClient.js';

const currency = (n) =>
  typeof n === 'number'
    ? n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '-';

const clampNonNegative = (v) => Math.max(0, Number.isFinite(+v) ? Math.floor(+v) : 0);

const MONTH_ABBREVIATIONS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const formatNumericMonthLabel = (value) => {
  if (!value) return '';
  const text = String(value).trim();

  const iso = text.match(/^(\d{4})-(\d{1,2})/);
  if (iso) return `${Number(iso[2])}/${iso[1]}`;

  const named = text.match(/^([A-Za-z]{3,})\s+(\d{4})$/);
  if (named) {
    const month = MONTH_ABBREVIATIONS[named[1].slice(0, 3).toLowerCase()];
    if (month) return `${month}/${named[2]}`;
  }

  const parsed = new Date(`${text} 1`);
  if (!Number.isNaN(parsed.getTime())) return `${parsed.getMonth() + 1}/${parsed.getFullYear()}`;

  return text;
};

export default function ForecastEditorChart({ userId, businessId, months = 12, useDemoData = false, controls = null }) {
  const gradientId = useId().replace(/:/g, '');
  const [rows, setRows] = useState([]);
  const [draft, setDraft] = useState([]);
  const [previousRows, setPreviousRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [asOfLabel, setAsOfLabel] = useState(formatAsOfDate(new Date()));
  const [error, setError] = useState('');
  const [edited, setEdited] = useState(new Set());
  const mounted = useRef(false);
  const isDemo = useDemoData || !businessId || shouldUseDemoData();
  const demoFinancials = useMemo(() => (isDemo ? getDemoData()?.financials || null : null), [isDemo]);
  const demoForecast = useMemo(() => buildDemoForecastFromFinancials(demoFinancials, months), [demoFinancials, months]);

  const missingLiveBusiness = !isDemo && (!userId || !businessId);

  const fetchForecast = useCallback(
    async (opts = { forceModel: false }) => {
      if (isDemo) {
        const fallback = alignForecastHorizon(
          demoForecast && demoForecast.length ? demoForecast : buildMockForecast(months),
          months
        );
        setRows(fallback);
        setDraft(fallback);
        setPreviousRows(null);
        setLastSavedAt(null);
        setEdited(new Set());
        setLoading(false);
        setError('');
        return;
      }

      if (!userId || !businessId) {
        setRows([]);
        setDraft([]);
        setPreviousRows(null);
        setLastSavedAt(null);
        setEdited(new Set());
        setLoading(false);
        return;
      }

      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams({
          userId,
          businessId,
          months: String(Math.max(2, Math.min(12, Number(months) || 12))),
          mockOnly: opts.forceModel ? 'false' : undefined,
        });
        const resp = await safeFetch(`/api/accounting/forecast?${params.toString()}`);
        const data = Array.isArray(resp?.forecast) ? resp.forecast : [];
        if (!data.length) throw new Error('no-data');
        const normalized = alignForecastHorizon(data, months);
        setRows(normalized);
        setDraft(normalized);
        setPreviousRows(null);
        setLastSavedAt(null);
        setEdited(new Set());
      } catch (err) {
        const fallback = alignForecastHorizon(buildMockForecast(months), months);
        setRows(fallback);
        setDraft(fallback);
        setPreviousRows(null);
        setLastSavedAt(null);
        setEdited(new Set());
        setError('Live forecast unavailable. Showing Bizzi sample data.');
        console.warn('[ForecastEditorChart] falling back to mock data:', err?.message);
      } finally {
        setLoading(false);
      }
    },
    [userId, businessId, months, isDemo, demoForecast]
  );

  useEffect(() => {
    mounted.current = true;
    fetchForecast();
    return () => {
      mounted.current = false;
    };
  }, [fetchForecast]);

  useEffect(() => {
    const tick = () => setAsOfLabel(formatAsOfDate(new Date()));
    tick();
    const id = setInterval(tick, 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const headerStats = useMemo(() => {
    if (!draft.length) return null;
    const first = draft[0];
    const last = draft[draft.length - 1];
    const avgRevenue = Math.round(draft.reduce((s, r) => s + (r.revenue || 0), 0) / draft.length);
    const avgExpenses = Math.round(draft.reduce((s, r) => s + (r.expenses || 0), 0) / draft.length);
    const monthlyNet = Math.round(draft.reduce((s, r) => s + (r.net_cash || 0), 0) / draft.length);
    return {
      avgRevenue,
      avgExpenses,
      endingCash: last?.ending_cash ?? 0,
      monthlyNet,
      startingCash: Math.round((first?.ending_cash ?? 0) - (first?.net_cash ?? 0)),
      firstRevenue: first?.revenue ?? 0,
      lastRevenue: last?.revenue ?? 0,
      firstExpenses: first?.expenses ?? 0,
      lastExpenses: last?.expenses ?? 0,
      lowCash: Math.min(...draft.map((r) => Number(r.ending_cash) || 0)),
    };
  }, [draft]);

  const recalc = (row) => {
    const cash_in = clampNonNegative(row.revenue) + clampNonNegative(row.cash_in - row.revenue);
    const baseOut = clampNonNegative(row.cash_out - row.expenses);
    const cash_out = clampNonNegative(row.expenses) + clampNonNegative(baseOut);
    const net_cash = cash_in - cash_out;
    return {
      ...row,
      revenue: clampNonNegative(row.revenue),
      expenses: clampNonNegative(row.expenses),
      cash_in,
      cash_out,
      net_cash,
    };
  };

  const handleCellChange = (idx, key, val) => {
    setDraft((prev) => {
      const next = [...prev];
      const updated = { ...next[idx], [key]: clampNonNegative(val) };
      const recalced = recalc(updated);
      let rolling = idx > 0 ? next[idx - 1].ending_cash : (rows[0]?.ending_cash ?? 0) - (rows[0]?.net_cash ?? 0);
      for (let i = 0; i < next.length; i++) {
        if (i === idx) {
          rolling = (i === 0 ? (rows[0]?.ending_cash ?? recalced.net_cash) - recalced.net_cash : next[i - 1].ending_cash) + recalced.net_cash;
          next[i] = { ...recalced, ending_cash: rolling };
        } else if (i > idx) {
          const r = next[i];
          rolling = (next[i - 1]?.ending_cash ?? 0) + r.net_cash;
          next[i] = { ...r, ending_cash: rolling };
        }
      }
      return next;
    });
    setEdited((prev) => new Set(prev).add(idx));
  };

  const hasEdits = edited.size > 0 && draft.length > 0 && JSON.stringify(draft) !== JSON.stringify(rows);
  const canRevert = hasEdits || !!previousRows;

  const revertChanges = () => {
    if (previousRows) {
      setRows(previousRows);
      setDraft(previousRows);
      setPreviousRows(null);
      setEdited(new Set());
      return;
    }
    setDraft(rows);
    setEdited(new Set());
  };

  const saveAll = async () => {
    if (isDemo) {
      if (!hasEdits) return;
      setPreviousRows(rows);
      setRows(draft);
      setLastSavedAt(new Date());
      setEdited(new Set());
      return;
    }
    if (!hasEdits || !userId || !businessId) return;
    setSaving(true);
    setError('');
    try {
      const payload = draft.map((r) => ({
        month: r.month,
        revenue: r.revenue,
        expenses: r.expenses,
        cash_in: r.cash_in,
        cash_out: r.cash_out,
        net_cash: r.net_cash,
        ending_cash: r.ending_cash,
      }));
      await safeFetch('/api/accounting/forecast/override', {
        method: 'POST',
        body: { userId, businessId, rows: payload },
      });
      setPreviousRows(rows);
      setRows(draft);
      setLastSavedAt(new Date());
      setEdited(new Set());
    } catch (e) {
      console.error('[ForecastEditorChart] save error', e);
      setError('Save failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const TooltipContent = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const p = payload.reduce((a, b) => ({ ...a, [b.dataKey]: b.value }), {});
    return (
      <div className="rounded-lg border border-white/10 bg-[#0c0d12]/95 px-3 py-2 shadow-lg">
        <div className="text-xs text-white/70">{label}</div>
        <div className="mt-1 space-y-0.5 text-xs">
          <div><span className="text-white/60">Revenue:</span> <span className="font-medium">{currency(p.revenue)}</span></div>
          <div><span className="text-white/60">Expenses:</span> <span className="font-medium">{currency(p.expenses)}</span></div>
          <div><span className="text-white/60">Net Cash:</span> <span className="font-medium">{currency(p.net_cash)}</span></div>
          <div className="pt-1 border-t border-white/10"><span className="text-white/60">Ending Cash:</span> <span className="font-medium">{currency(p.ending_cash)}</span></div>
        </div>
      </div>
    );
  };

  const chartData = useMemo(
    () =>
      draft.map((r) => ({
        month_label: r.month_label || r.month,
        revenue: r.revenue,
        expenses: r.expenses,
        net_cash: r.net_cash,
        ending_cash: r.ending_cash,
      })),
    [draft]
  );

  const lastSavedLabel = useMemo(() => (lastSavedAt ? formatTimeAgo(lastSavedAt) : null), [lastSavedAt]);
  const latestPoint = chartData[chartData.length - 1];
  const netLineColor = (headerStats?.monthlyNet ?? 0) >= 0 ? '#34d399' : '#f59e0b';

  return (
    <div className="rounded-[28px] bg-[linear-gradient(180deg,rgba(11,14,13,0.96)_0%,rgba(6,9,8,0.92)_100%)] px-5 py-6 text-white shadow-[0_30px_82px_rgba(0,0,0,0.42)] ring-1 ring-white/[0.045]">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[0.4em] text-white/60">Projection editor</p>
          <h2 className="mt-2 text-2xl font-semibold text-white">Monthly Cash Flow</h2>
        </div>
        <div className="flex flex-col items-start gap-2 lg:items-end lg:text-right">
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            {controls}
            <p className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs font-semibold text-white/62">
              As of {asOfLabel}
            </p>
          </div>
          {error && (
            <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-rose-400/40 bg-rose-500/10 px-3 py-1 text-xs text-rose-200">
              <AlertTriangle size={14} /> {error}
            </div>
          )}
        </div>
      </div>

      {headerStats && !missingLiveBusiness && (
        <div className="mt-5 grid grid-cols-1 gap-px overflow-hidden rounded-2xl bg-white/[0.055] shadow-[0_18px_44px_rgba(0,0,0,0.22)] sm:grid-cols-2 xl:grid-cols-4">
          <ForecastMetric
            label="Avg monthly revenue"
            value={currency(headerStats.avgRevenue)}
            note={`${currency(headerStats.firstRevenue)} now → ${currency(headerStats.lastRevenue)} by month ${months}`}
            tone="emerald"
          />
          <ForecastMetric
            label="Avg monthly expenses"
            value={currency(headerStats.avgExpenses)}
            note={`${currency(headerStats.firstExpenses)} now → ${currency(headerStats.lastExpenses)} by month ${months}`}
            tone="amber"
          />
          <ForecastMetric
            label="Avg monthly net"
            value={currency(headerStats.monthlyNet)}
            note={headerStats.monthlyNet >= 0 ? 'Average monthly cash surplus' : 'Average monthly cash shortfall'}
            tone={headerStats.monthlyNet >= 0 ? 'emerald' : 'rose'}
          />
          <ForecastMetric
            label={`Ending cash (${months} mo)`}
            value={currency(headerStats.endingCash)}
            note={`Starts ${currency(headerStats.startingCash)}; low point ${currency(headerStats.lowCash)}`}
            tone={headerStats.endingCash >= 0 ? 'emerald' : 'rose'}
          />
        </div>
      )}

      <div className="mt-6 rounded-2xl bg-[#070b0a]/72 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.025),0_18px_44px_rgba(0,0,0,0.26)]">
        {loading ? (
          <div className="flex h-64 items-center justify-center text-white/70">
            <Loader2 className="mr-2 animate-spin" /> Loading forecast…
          </div>
        ) : missingLiveBusiness ? (
          <div className="flex h-64 items-center justify-center text-white/60">Choose a business to view forecasts.</div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
                      <ComposedChart data={chartData} margin={{ top: 14, right: 18, left: 0, bottom: 14 }}>
              <defs>
                <linearGradient id={`endingCashArea-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#34d399" stopOpacity={0.22} />
                  <stop offset="64%" stopColor="#34d399" stopOpacity={0.06} />
                  <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 6" vertical={false} stroke="rgba(148,163,184,0.12)" />
              <ReferenceLine y={0} stroke="rgba(251,191,36,0.28)" strokeDasharray="5 6" />
                        <XAxis
                          dataKey="month_label"
                          interval={0}
                          minTickGap={0}
                          tickFormatter={formatNumericMonthLabel}
                          axisLine={false}
                          tickLine={false}
                          tickMargin={12}
                          tick={{ fill: 'rgba(226,232,240,0.72)', fontSize: 11, fontWeight: 600 }}
                        />
              <YAxis
                axisLine={false}
                tickLine={false}
                tickMargin={10}
                tick={{ fill: 'rgba(226,232,240,0.72)', fontSize: 12, fontWeight: 600 }}
                width={72}
                tickFormatter={(v) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`)}
              />
              <Tooltip content={<TooltipContent />} />
              <Area
                type="monotone"
                dataKey="ending_cash"
                name="Ending Cash"
                stroke="none"
                fill={`url(#endingCashArea-${gradientId})`}
                activeDot={false}
              />
              <Line type="monotone" dataKey="revenue" name="Revenue" stroke="#2dd4bf" strokeWidth={2.5} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: '#0f172a', fill: '#5eead4' }} />
              <Line type="monotone" dataKey="expenses" name="Expenses" stroke="#fbbf24" strokeWidth={2.5} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: '#0f172a', fill: '#fde68a' }} />
              <Line type="monotone" dataKey="net_cash" name="Net Cash" stroke={netLineColor} strokeWidth={2.5} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: '#0f172a', fill: netLineColor }} />
              <Line type="monotone" dataKey="ending_cash" name="Ending Cash" stroke="#86efac" strokeWidth={2.25} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: '#0f172a', fill: '#bbf7d0' }} />
              {latestPoint ? (
                <ReferenceDot
                  x={latestPoint.month_label}
                  y={latestPoint.ending_cash}
                  r={5}
                  fill="#bbf7d0"
                  stroke="#052e1a"
                  strokeWidth={2}
                />
              ) : null}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-6 overflow-hidden rounded-2xl bg-[#080d0b]/84 shadow-[0_18px_44px_rgba(0,0,0,0.28)] ring-1 ring-white/[0.04]">
        <div className="flex flex-col gap-3 bg-white/[0.025] px-4 py-3 text-xs uppercase tracking-wide text-white/60 md:flex-row md:items-center md:justify-between md:gap-4">
          <div className="flex items-center gap-3">
            <div className="font-semibold tracking-[0.22em] text-white/72">Editable table</div>
            <div className="rounded-full border border-white/10 bg-black/20 px-2 py-1 text-[11px] uppercase text-white/50">As of {asOfLabel}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] normal-case text-white/70 md:justify-end">
            <div className="inline-flex items-center gap-2">
              <Info size={14} />
              <span>Edits persist only after clicking</span>
              <Button
                icon={saving ? Loader2 : Save}
                spinning={saving}
                size="sm"
                label="Save all"
                onClick={saveAll}
                disabled={!hasEdits || saving || missingLiveBusiness}
                variant="primary"
              />
              {hasEdits && (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/20 bg-amber-300/10 px-2 py-1 text-[10px] font-semibold text-amber-100">
                  Unsaved changes
                </span>
              )}
              {lastSavedLabel && (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2 py-1 text-[10px] font-semibold text-emerald-100">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span>Saved · Updated {lastSavedLabel}</span>
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button icon={Undo2} label="Revert" size="sm" onClick={revertChanges} disabled={!canRevert} />
            </div>
          </div>
        </div>
          <div className="custom-scrollbar max-h-[520px] overflow-auto pb-20 md:pb-4">
          <table className="min-w-[980px] w-full text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="bg-[#0d1210] text-left text-white/70 shadow-[0_10px_24px_rgba(0,0,0,0.22)]">
                <Th>Month</Th>
                <Th>Revenue</Th>
                <Th>Expenses</Th>
                <Th>Cash In</Th>
                <Th>Cash Out</Th>
                <Th>Net Cash</Th>
                <Th>Ending Cash</Th>
              </tr>
            </thead>
            <tbody>
              {draft.map((r, idx) => {
                const isEdited = edited.has(idx);
                return (
                  <tr
                    key={r.month || idx}
                    className={`transition-colors hover:bg-white/[0.045] ${isEdited ? 'bg-emerald-300/[0.045]' : ''}`}
                  >
                    <Td className="whitespace-nowrap font-semibold text-white/86">{r.month_label || r.month}</Td>
                    <Td>
                      <NumberInput value={r.revenue} onChange={(v) => handleCellChange(idx, 'revenue', v)} ariaLabel="Revenue" name={`forecast-revenue-${idx}`} />
                    </Td>
                    <Td>
                      <NumberInput value={r.expenses} onChange={(v) => handleCellChange(idx, 'expenses', v)} ariaLabel="Expenses" name={`forecast-expenses-${idx}`} />
                    </Td>
                    <Td className="tabular-nums text-white/78">{currency(r.cash_in)}</Td>
                    <Td className="tabular-nums text-white/78">{currency(r.cash_out)}</Td>
                    <Td className={`font-semibold tabular-nums ${r.net_cash >= 0 ? 'text-emerald-100' : 'text-rose-100'}`}>{currency(r.net_cash)}</Td>
                    <Td className="font-semibold tabular-nums text-white/88">{currency(r.ending_cash)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ---------- UI atoms ---------- */

function Button({ icon: Icon, label, onClick, disabled, variant = 'ghost', spinning, size = 'md' }) {
  const base = 'inline-flex items-center gap-1.5 font-semibold transition-all duration-200 border disabled:cursor-not-allowed';
  const sizes = {
    sm: 'rounded-xl px-3 py-1.5 text-xs',
    md: 'rounded-xl px-3 py-1.5 text-sm',
  };
  const styles = {
    primary: disabled
      ? 'border-emerald-300/10 bg-emerald-600/20 text-white/45'
      : 'border-emerald-300/35 bg-emerald-400/18 text-emerald-50 shadow-[0_0_22px_rgba(16,185,129,0.12)] hover:bg-emerald-400/24 hover:border-emerald-200/45',
    ghost: disabled
      ? 'border-white/5 text-white/34'
      : 'border-white/12 bg-white/[0.035] text-white/82 hover:border-white/22 hover:bg-white/[0.07]',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${sizes[size] ?? sizes.md} ${styles[variant === 'primary' ? 'primary' : 'ghost']}`}
    >
      {Icon && <Icon size={size === 'sm' ? 14 : 16} className={spinning ? 'animate-spin' : ''} />}
      {label}
    </button>
  );
}

function ForecastMetric({ label, value, note, tone = 'neutral' }) {
  const toneStyles = {
    emerald: {
      accent: 'bg-emerald-300',
      value: 'text-emerald-100',
      note: 'text-emerald-100/62',
    },
    amber: {
      accent: 'bg-amber-300',
      value: 'text-amber-100',
      note: 'text-amber-100/62',
    },
    rose: {
      accent: 'bg-rose-300',
      value: 'text-rose-100',
      note: 'text-rose-100/62',
    },
    neutral: {
      accent: 'bg-white/45',
      value: 'text-white',
      note: 'text-white/52',
    },
  };
  const styles = toneStyles[tone] || toneStyles.neutral;

  return (
    <div className="relative min-h-[104px] bg-black/22 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-[10px] font-semibold uppercase leading-snug tracking-[0.16em] text-white/46">
          {label}
        </div>
        <span className={`mt-1 h-1.5 w-8 rounded-full ${styles.accent}`} />
      </div>
      <div className={`mt-3 text-[1.55rem] font-semibold leading-none tracking-normal tabular-nums ${styles.value}`}>
        {value ?? '—'}
      </div>
      <div className={`mt-3 text-[11px] font-medium leading-snug ${styles.note}`}>
        {note}
      </div>
    </div>
  );
}

function Th({ children, className = '' }) {
  return <th className={`px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] ${className}`}>{children}</th>;
}
function Td({ children, className = '' }) {
  return <td className={`px-4 py-3 align-middle ${className}`}>{children}</td>;
}

function NumberInput({ value, onChange, ariaLabel, name }) {
  const handleKey = (e) => {
    if (e.key === 'ArrowUp') onChange((+value || 0) + 100);
    if (e.key === 'ArrowDown') onChange(Math.max(0, (+value || 0) - 100));
  };
  return (
    <input
      type="number"
      inputMode="numeric"
      id={name}
      name={name}
      value={value ?? 0}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={handleKey}
      className="w-32 rounded-xl border border-white/12 bg-black/28 px-3 py-2 font-semibold tabular-nums text-white outline-none ring-emerald-500/30 transition-all hover:border-white/24 hover:bg-black/38 focus:border-emerald-300/45 focus:bg-black/50 focus:ring"
    />
  );
}

function formatTimeAgo(date) {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diff = Math.max(0, now - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatAsOfDate(date) {
  try {
    return new Date(date).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

/* ---------- mock helpers ---------- */

function alignForecastHorizon(rows = [], months = 12) {
  const count = clampMonthCount(months);
  const timeline = buildForwardMonths(count);
  const normalizedRows = (rows || []).map((row) => {
    const key = monthKey(row.month, row.month_label);
    return {
      ...row,
      month: `${key}-01`,
      month_label: row.month_label || labelFromKey(key),
    };
  });
  const map = new Map(normalizedRows.map((row) => [monthKey(row.month, row.month_label), row]));
  let last = normalizedRows[0] || {
    revenue: 20000,
    expenses: 14000,
    cash_in: 20000,
    cash_out: 14000,
    net_cash: 6000,
    ending_cash: 40000,
  };
  const startingCash = Number(last.ending_cash || 0) - Number(last.net_cash || 0);
  let rolling = Number.isFinite(startingCash) ? startingCash : 40000;

  return timeline.map(({ key, label }, index) => {
    const exact = map.get(key);
    const indexed = normalizedRows[index];
    const existing = exact || indexed;
    if (existing) last = existing;
    const source = existing || last;
    const revenue = clampNonNegative(source.revenue);
    const expenses = clampNonNegative(source.expenses);
    const cashIn = clampNonNegative(source.cash_in ?? revenue);
    const cashOut = clampNonNegative(source.cash_out ?? expenses);
    const netCash = cashIn - cashOut;
    rolling += netCash;
    const clone = {
      ...source,
      month: `${key}-01`,
      month_label: label,
      revenue,
      expenses,
      cash_in: cashIn,
      cash_out: cashOut,
      net_cash: netCash,
      ending_cash: rolling,
      source: source.source || 'generated',
    };
    return clone;
  });
}

function clampMonthCount(value) {
  return Math.max(2, Math.min(12, Number(value) || 12));
}

function buildForwardMonths(count) {
  const out = [];
  const cursor = new Date();
  cursor.setDate(1);
  cursor.setHours(12, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    const d = new Date(cursor.getFullYear(), cursor.getMonth() + i, 1, 12);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push({ key, label: d.toLocaleString('default', { month: 'short', year: 'numeric' }) });
  }
  return out;
}

function monthKey(monthString = '', label) {
  if (monthString && monthString.length >= 7) return monthString.slice(0, 7);
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

function buildMockForecast(months = 12) {
  let ending = 42000;
  return buildForwardMonths(clampMonthCount(months)).map(({ key, label }, i) => {
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
      source: 'mock',
    };
  });
}

function buildDemoForecastFromFinancials(financials = {}, months = 12) {
  const revenueRows = Array.isArray(financials?.monthlyRevenue) ? financials.monthlyRevenue : [];
  const profitMap = new Map(
    (financials?.monthlyProfit || []).map((row) => [row.month, Number(row.profit || 0)])
  );
  const marginPct = Number(financials?.profitMarginPct || 0) / 100;
  if (!revenueRows.length) return buildMockForecast(months);

  const recentRows = revenueRows.slice(-Math.min(6, revenueRows.length));
  const avgRevenue = recentRows.reduce((sum, row) => sum + Number(row.revenue || 0), 0) / recentRows.length;
  const lastRevenue = Number(revenueRows.at(-1)?.revenue || avgRevenue || 20000);
  const firstRecent = Number(recentRows[0]?.revenue || lastRevenue);
  const monthlyGrowth = firstRecent > 0
    ? Math.max(-0.08, Math.min(0.08, (lastRevenue - firstRecent) / firstRecent / Math.max(recentRows.length - 1, 1)))
    : 0.015;
  const baseProfit = Number(profitMap.get(revenueRows.at(-1)?.month) || lastRevenue * (marginPct || 0.32));
  const baseMargin = lastRevenue > 0 ? baseProfit / lastRevenue : marginPct || 0.32;

  let ending = Number(financials?.cashOnHand || 0);
  return buildForwardMonths(clampMonthCount(months)).map(({ key, label }, index) => {
    const revenue = Math.round(lastRevenue * Math.pow(1 + monthlyGrowth, index));
    const profit =
      revenue * (baseMargin || marginPct || 0.32);
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
      source: 'demo',
    };
  });
}
