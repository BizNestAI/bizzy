// File: /components/Accounting/ForecastEditorChart.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts';
import { Loader2, RefreshCw, Save, Undo2, Info, Pencil, AlertTriangle } from 'lucide-react';
import AskBizzyInsightButton from '../Bizzy/AskBizzyInsightButton';
import { safeFetch } from '../../utils/safeFetch';
import { getDemoData, shouldUseDemoData } from '../../services/demo/demoClient.js';

const currency = (n) =>
  typeof n === 'number'
    ? n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '-';

const clampNonNegative = (v) => Math.max(0, Number.isFinite(+v) ? Math.floor(+v) : 0);

export default function ForecastEditorChart({ userId, businessId, months = 12 }) {
  const [rows, setRows] = useState([]);
  const [draft, setDraft] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [usingMock, setUsingMock] = useState(false);
  const [edited, setEdited] = useState(new Set());
  const mounted = useRef(false);
  const isDemo = !businessId || shouldUseDemoData();
  const demoFinancials = useMemo(() => (isDemo ? getDemoData()?.financials || null : null), [isDemo]);
  const demoForecast = useMemo(() => buildDemoForecastFromFinancials(demoFinancials, months), [demoFinancials, months]);

  const noBusinessSelected = !userId || !businessId;

  const fetchForecast = useCallback(
    async (opts = { forceModel: false }) => {
      if (isDemo) {
        const fallback = alignForecastHorizon(
          demoForecast && demoForecast.length ? demoForecast : buildMockForecast(months),
          months
        );
        setRows(fallback);
        setDraft(fallback);
        setEdited(new Set());
        setUsingMock(true);
        setLoading(false);
        setError('');
        return;
      }

      if (!userId || !businessId) {
        setRows([]);
        setDraft([]);
        setEdited(new Set());
        setUsingMock(false);
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
        setEdited(new Set());
        setUsingMock(data.some((r) => r.source === 'mock'));
      } catch (err) {
        const fallback = alignForecastHorizon(buildMockForecast(months), months);
        setRows(fallback);
        setDraft(fallback);
        setEdited(new Set());
        setUsingMock(true);
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

  const headerStats = useMemo(() => {
    if (!draft.length) return null;
    const last = draft[draft.length - 1];
    const avgRevenue = Math.round(draft.reduce((s, r) => s + (r.revenue || 0), 0) / draft.length);
    const avgExpenses = Math.round(draft.reduce((s, r) => s + (r.expenses || 0), 0) / draft.length);
    return {
      avgRevenue,
      avgExpenses,
      endingCash: last?.ending_cash ?? 0,
      monthlyNet: Math.round(draft.reduce((s, r) => s + (r.net_cash || 0), 0) / draft.length),
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

  const revertChanges = () => {
    setDraft(rows);
    setEdited(new Set());
  };

  const resetToModel = () => fetchForecast({ forceModel: true });

  const saveAll = async () => {
    if (isDemo) {
      if (!hasEdits) return;
      setRows(draft);
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
      setRows(draft);
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

  return (
    <div className="rounded-[32px] border border-white/10 bg-gradient-to-b from-white/6 via-white/2 to-transparent px-5 py-6 text-white shadow-[0_35px_100px_rgba(0,0,0,0.55)]">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.4em] text-white/60">Projection editor</p>
          <h2 className="mt-2 text-2xl font-semibold text-white">Cash flow runway</h2>
          {error && (
            <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-rose-400/40 bg-rose-500/10 px-3 py-1 text-xs text-rose-200">
              <AlertTriangle size={14} /> {error}
            </div>
          )}
          {usingMock && !error && (
            <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-xs text-amber-200">
              Mock data — connect accounting to see live
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AskBizzyInsightButton
            metric="Cash Flow Forecast"
            value="forecast editor"
            previousValue="last month's forecast"
            disabled={noBusinessSelected}
          />
          <Button icon={RefreshCw} label="Reset" onClick={resetToModel} disabled={noBusinessSelected || loading} />
          <Button icon={Undo2} label="Revert" onClick={revertChanges} disabled={!hasEdits} />
          <Button
            icon={saving ? Loader2 : Save}
            spinning={saving}
            label="Save all"
            onClick={saveAll}
            disabled={!hasEdits || saving || noBusinessSelected}
            variant="primary"
          />
        </div>
      </div>

      {headerStats && !noBusinessSelected && (
        <div className="mt-5 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <Stat label="Avg monthly revenue" value={currency(headerStats.avgRevenue)} />
          <Stat label="Avg monthly expenses" value={currency(headerStats.avgExpenses)} />
          <Stat label="Avg monthly net" value={currency(headerStats.monthlyNet)} />
          <Stat label={`Ending cash (${months} mo)`} value={currency(headerStats.endingCash)} />
        </div>
      )}

      <div className="mt-6 rounded-3xl border border-white/10 bg-black/30 p-4">
        {loading ? (
          <div className="flex h-64 items-center justify-center text-white/70">
            <Loader2 className="mr-2 animate-spin" /> Loading forecast…
          </div>
        ) : noBusinessSelected ? (
          <div className="flex h-64 items-center justify-center text-white/60">Choose a business to view forecasts.</div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={chartData} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 4" stroke="#1f2228" />
              <XAxis dataKey="month_label" stroke="#cbd5f5" tickMargin={8} />
              <YAxis stroke="#cbd5f5" width={72} tickFormatter={(v) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`)} />
              <Tooltip content={<TooltipContent />} />
              <Line type="monotone" dataKey="revenue" name="Revenue" stroke="#22e3b0" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="expenses" name="Expenses" stroke="#fbbf24" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="net_cash" name="Net Cash" stroke="#60a5fa" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-6 rounded-3xl border border-white/10 bg-black/20">
        <div className="sticky top-0 rounded-t-3xl bg-white/10 px-4 py-3 text-xs uppercase tracking-wide text-white/60">
          Editable table
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-white/5 text-left text-white/70">
                <Th>Month</Th>
                <Th>Revenue</Th>
                <Th>Expenses</Th>
                <Th>Cash In</Th>
                <Th>Cash Out</Th>
                <Th>Net Cash</Th>
                <Th>Ending Cash</Th>
                <Th className="text-right">Status</Th>
              </tr>
            </thead>
            <tbody>
              {draft.map((r, idx) => {
                const isEdited = edited.has(idx);
                return (
                  <tr key={r.month || idx} className="border-b border-white/10">
                    <Td className="whitespace-nowrap text-white/80">{r.month_label || r.month}</Td>
                    <Td>
                      <NumberInput value={r.revenue} onChange={(v) => handleCellChange(idx, 'revenue', v)} ariaLabel="Revenue" />
                    </Td>
                    <Td>
                      <NumberInput value={r.expenses} onChange={(v) => handleCellChange(idx, 'expenses', v)} ariaLabel="Expenses" />
                    </Td>
                    <Td className="tabular-nums text-white/80">{currency(r.cash_in)}</Td>
                    <Td className="tabular-nums text-white/80">{currency(r.cash_out)}</Td>
                    <Td className="tabular-nums text-white/80">{currency(r.net_cash)}</Td>
                    <Td className="tabular-nums text-white/80">{currency(r.ending_cash)}</Td>
                    <Td className="text-right">
                      {isEdited && (
                        <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 px-2 py-1 text-emerald-300">
                          <Pencil size={14} /> edited
                        </span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-2 px-4 py-3 text-xs text-white/55">
          <Info size={14} /> Edits persist only after clicking
          <span className="mx-1 rounded bg-white/10 px-1 py-0.5 text-white">Save all</span>.
        </div>
      </div>
    </div>
  );
}

/* ---------- UI atoms ---------- */

function Button({ icon: Icon, label, onClick, disabled, variant = 'ghost', spinning }) {
  const base =
    'inline-flex items-center gap-1 rounded-xl px-3 py-1.5 text-sm transition border';
  const styles = {
    primary: disabled
      ? 'bg-emerald-600/30 text-white/60 border-transparent'
      : 'bg-emerald-500/80 text-white border-emerald-300/40 hover:bg-emerald-500',
    ghost: disabled
      ? 'border-white/5 text-white/40'
      : 'border-white/10 text-white/90 hover:bg-white/5',
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${styles[variant === 'primary' ? 'primary' : 'ghost']}`}>
      {Icon && <Icon size={16} className={spinning ? 'animate-spin' : ''} />}
      {label}
    </button>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
      <div className="text-[11px] uppercase tracking-wide text-white/50">{label}</div>
      <div className="mt-1 text-lg font-semibold text-white">{value}</div>
    </div>
  );
}

function Th({ children, className = '' }) {
  return <th className={`px-3 py-2 ${className}`}>{children}</th>;
}
function Td({ children, className = '' }) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}

function NumberInput({ value, onChange, ariaLabel }) {
  const handleKey = (e) => {
    if (e.key === 'ArrowUp') onChange((+value || 0) + 100);
    if (e.key === 'ArrowDown') onChange(Math.max(0, (+value || 0) - 100));
  };
  return (
    <input
      type="number"
      inputMode="numeric"
      value={value ?? 0}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={handleKey}
      className="w-28 rounded-xl border border-white/15 bg-[#050608]/60 px-2 py-1.5 text-white outline-none ring-emerald-500/30 focus:border-emerald-300/40 focus:ring"
    />
  );
}

/* ---------- mock helpers ---------- */

function alignForecastHorizon(rows = [], months = 12) {
  if (rows && rows.length) {
    const normalized = rows
      .slice(0, months)
      .map((row) => {
        const key = monthKey(row.month, row.month_label);
        return {
          ...row,
          month: `${key}-01`,
          month_label: row.month_label || labelFromKey(key),
        };
      });
    if (normalized.length >= months) return normalized;
  }

  const timeline = buildForwardMonths(months);
  const map = new Map(
    (rows || []).map((row) => {
      const key = monthKey(row.month, row.month_label);
      return [key, { ...row, month: `${key}-01` }];
    })
  );
  let last = rows?.[0] || {
    revenue: 20000,
    expenses: 14000,
    cash_in: 20000,
    cash_out: 14000,
    net_cash: 6000,
    ending_cash: 40000,
  };

  return timeline.map(({ key, label }) => {
    const existing = map.get(key);
    if (existing) {
      last = existing;
      return { ...existing, month: `${key}-01`, month_label: label };
    }
    const clone = {
      ...last,
      month: `${key}-01`,
      month_label: label,
      source: last.source || 'generated',
    };
    return clone;
  });
}

function buildForwardMonths(count) {
  const out = [];
  const cursor = new Date();
  cursor.setUTCDate(1);
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
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
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }
  }
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function labelFromKey(key) {
  const [y, m] = key.split('-');
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return d.toLocaleString('default', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function buildMockForecast(months = 12) {
  const now = new Date();
  let ending = 42000;
  const out = [];
  for (let i = 0; i < months; i++) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const month = date.toISOString().slice(0, 7);
    const label = date.toLocaleString('default', { month: 'short', year: 'numeric' });
    const revenue = 18000 + Math.round(Math.random() * 6000);
    const expenses = 11000 + Math.round(Math.random() * 4000);
    const cash_in = revenue + Math.round(Math.random() * 2000);
    const cash_out = expenses + Math.round(Math.random() * 1500);
    const net_cash = cash_in - cash_out;
    ending += net_cash;
    out.push({
      month,
      month_label: label,
      revenue,
      expenses,
      cash_in,
      cash_out,
      net_cash,
      ending_cash: Math.max(0, ending),
      source: 'mock',
    });
  }
  return out;
}

function buildDemoForecastFromFinancials(financials = {}, months = 12) {
  const revenueRows = Array.isArray(financials?.monthlyRevenue) ? financials.monthlyRevenue.slice(-months) : [];
  const profitMap = new Map(
    (financials?.monthlyProfit || []).map((row) => [row.month, Number(row.profit || 0)])
  );
  const marginPct = Number(financials?.profitMarginPct || 0) / 100;
  if (!revenueRows.length) return buildMockForecast(months);

  let ending = Number(financials?.cashOnHand || 0) - Number(profitMap.get(revenueRows[0]?.month) || 0);
  return revenueRows.map((row) => {
    const month = row.month;
    const revenue = Number(row.revenue || 0);
    const profit =
      profitMap.get(month) ??
      (marginPct ? revenue * marginPct : revenue * 0.32);
    const expenses = Math.max(0, revenue - profit);
    const cash_in = revenue;
    const cash_out = expenses;
    const net_cash = profit;
    ending += net_cash;
    const label = new Date(`${month}-01T00:00:00Z`).toLocaleString('default', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    return {
      month,
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
