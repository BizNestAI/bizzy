// /src/components/Investments/HoldingsTable.jsx
import React, { useMemo, useState, useEffect } from "react";
import CardHeader from "../ui/CardHeader";
import Portal from "./Portal";

const NEON = "#C084FC";
const fmtUSD = (n) => `$${(Number(n || 0)).toLocaleString()}`;
const fmtPct2 = (n) => `${(Math.round(Number(n || 0) * 100) / 100).toFixed(2)}%`;

export default function HoldingsTable({
  positions = [],
  asOf,
  onRefresh = () => {},
  onConnect = () => {},
  onImportCSV = () => {},
  onAddManual = () => {},
  onAskBizzy = () => {},
}) {
  const [query, setQuery] = useState("");
  const [accountFilter, setAccountFilter] = useState([]); // multi-select
  const [classFilter, setClassFilter] = useState("");
  const [sortKey, setSortKey] = useState("value"); // value | pl_pct | ticker
  const [sortDir, setSortDir] = useState("desc");
  const [drawerRow, setDrawerRow] = useState(null);

  // Keyboard close for drawer
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && setDrawerRow(null);
    if (drawerRow) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerRow]);

  const rows = useMemo(
    () =>
      (positions || []).map((p, idx) => ({
        id: `${p.ticker || "sym"}-${idx}`,
        ticker: p.ticker || "",
        name: p.name || "",
        account: p.account || "",
        asset_class: p.asset_class || "",
        quantity: Number(p.quantity ?? 0),
        price: p.price != null ? Number(p.price) : null,
        value: Number(p.market_value || 0),
        cost: p.cost_basis_total != null ? Number(p.cost_basis_total) : null,
        pl: p.unrealized_pl != null ? Number(p.unrealized_pl) : 0,
        pl_pct: p.unrealized_pl_pct != null ? Number(p.unrealized_pl_pct) : 0,
        weight_pct: p.weight_pct != null ? Number(p.weight_pct) : null,
        currency: p.currency || "USD",
        price_as_of: p.price_as_of,
      })),
    [positions]
  );

  const accounts = useMemo(
    () => Array.from(new Set(rows.map((r) => r.account))).filter(Boolean),
    [rows]
  );
  const classes = useMemo(
    () => Array.from(new Set(rows.map((r) => r.asset_class))).filter(Boolean),
    [rows]
  );

  const filtered = useMemo(() => {
    let r = rows;
    if (query) {
      const q = query.toLowerCase();
      r = r.filter(
        (x) =>
          x.ticker.toLowerCase().includes(q) ||
          (x.name || "").toLowerCase().includes(q)
      );
    }
    if (accountFilter.length) r = r.filter((x) => accountFilter.includes(x.account));
    if (classFilter) r = r.filter((x) => x.asset_class === classFilter);

    const dir = sortDir === "asc" ? 1 : -1;
    return r.slice().sort((a, b) => {
      if (sortKey === "ticker") return a.ticker.localeCompare(b.ticker) * dir;
      if (sortKey === "pl_pct")
        return ((a.pl_pct ?? -Infinity) - (b.pl_pct ?? -Infinity)) * dir;
      return ((a.value || 0) - (b.value || 0)) * dir;
    });
  }, [rows, query, accountFilter, classFilter, sortKey, sortDir]);

  const totals = useMemo(() => {
    const tv = filtered.reduce((s, x) => s + (x.value || 0), 0);
    const tpl = filtered.reduce((s, x) => s + (x.pl || 0), 0);
    return { tv, tpl };
  }, [filtered]);

  const asOfLabel = asOf ? new Date(asOf).toLocaleString() : null;

  return (
    <div aria-label="Holdings table">
      {/* Card header — consistent across dashboards */}
      <CardHeader
        title="HOLDINGS"
        size="sm"
        dense
        className="mb-2"
        titleClassName="text-[13px]"
        right={
          <div className="flex items-center gap-1.5">
            <MenuButton
              label="Add"
              items={[
                { label: "Connect account", onClick: onConnect },
                { label: "Import CSV", onClick: onImportCSV },
                { label: "Add manual", onClick: onAddManual },
              ]}
            />
            <button
              onClick={onRefresh}
              className="text-[12px] px-2 py-1 rounded-md ring-1 ring-inset ring-white/12 hover:bg-white/10"
              aria-label="Refresh holdings"
            >
              Refresh
            </button>
          </div>
        }
      />
      {asOfLabel && (
        <div className="mb-2 text-[11px] text-white/55">As of {asOfLabel}</div>
      )}

      {/* Controls — condensed to fit when rail is open */}
      <div className="flex flex-col lg:flex-row lg:items-center gap-2 lg:gap-3 mb-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search symbol or name"
          className="w-full lg:w-64 text-sm px-3 py-2 rounded-xl bg-white/5 ring-1 ring-inset ring-white/12 outline-none focus:ring-white/25"
          aria-label="Search holdings"
        />
        {/* Account chips */}
        <div className="flex flex-wrap gap-2">
          {accounts.map((a) => {
            const active = accountFilter.includes(a);
            return (
              <button
                key={a}
                onClick={() =>
                  setAccountFilter((prev) =>
                    active ? prev.filter((x) => x !== a) : [...prev, a]
                  )
                }
                className={`text-[12px] px-2.5 py-1.5 rounded-full outline-none ring-1 ring-inset ${
                  active
                    ? "ring-[#B388FF]/50 text-[#B388FF] bg-[#B388FF]/10"
                    : "ring-white/12 text-white/70 bg-white/5 hover:bg-white/10"
                }`}
                aria-pressed={active}
                aria-label={`Filter by ${a}`}
              >
                {a}
              </button>
            );
          })}
        </div>

        <div className="lg:ml-auto flex items-center gap-2">
          <select
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
            className="text-sm px-3 py-2 rounded-xl bg-white/5 ring-1 ring-inset ring-white/12 outline-none focus:ring-white/25"
            aria-label="Filter by asset class"
          >
            <option value="">All classes</option>
            {classes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value)}
            className="text-sm px-3 py-2 rounded-xl bg-white/5 ring-1 ring-inset ring-white/12 outline-none focus:ring-white/25"
            aria-label="Sort key"
          >
            <option value="value">Sort: Value</option>
            <option value="pl_pct">Sort: P/L %</option>
            <option value="ticker">Sort: Ticker A–Z</option>
          </select>
          <button
            onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
            className="px-3 py-2 rounded-xl bg-white/5 ring-1 ring-inset ring-white/12 text-sm outline-none focus:ring-white/25"
            aria-label={`Sort ${sortDir === "asc" ? "descending" : "ascending"}`}
          >
            {sortDir === "asc" ? "↑" : "↓"}
          </button>
        </div>
      </div>

      {/* Table / Empty states */}
      {rows.length === 0 ? (
        <EmptyState
          onConnect={onConnect}
          onImportCSV={onImportCSV}
          onAddManual={onAddManual}
        />
      ) : filtered.length === 0 ? (
        <div className="text-sm text-white/60 p-6 ring-1 ring-inset ring-white/12 rounded-xl bg-white/5">
          No matches. Clear filters.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-white/60 border-b border-white/10">
                  <th className="py-2 pr-2 text-left">Symbol</th>
                  <th className="py-2 pr-2 text-left hidden md:table-cell">Company</th>
                  <th className="py-2 pr-2 text-left hidden lg:table-cell">Account</th>
                  <th className="py-2 pr-2 text-right">Shares</th>
                  <th className="py-2 pr-2 text-right hidden sm:table-cell">
                    Price <span className="text-white/40">(as of)</span>
                  </th>
                  <th className="py-2 pr-2 text-right">Value</th>
                  <th className="py-2 pl-2 text-right">Unrealized P/L</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-white/5 hover:bg-white/[0.04] cursor-pointer"
                    onClick={() => setDrawerRow(r)}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && setDrawerRow(r)}
                    aria-label={`Open details for ${r.ticker}`}
                  >
                    <td className="py-2 pr-2">
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="px-2 py-0.5 rounded-md ring-1 ring-inset ring-[#B388FF]/40 bg-[#B388FF]/10 text-[#B388FF] font-medium"
                          aria-label="Ticker"
                        >
                          {r.ticker}
                        </span>
                      </span>
                      <div className="md:hidden text-xs text-white/50 mt-1">
                        {r.name} • {r.account}
                      </div>
                    </td>
                    <td className="py-2 pr-2 hidden md:table-cell text-white/85">{r.name}</td>
                    <td className="py-2 pr-2 hidden lg:table-cell">
                      <span className="px-2 py-0.5 rounded-full ring-1 ring-inset ring-white/12 bg-white/5 text-white/70">
                        {r.account}
                      </span>
                    </td>
                    <td className="py-2 pr-2 text-right text-white/85">
                      {(r.quantity ?? 0).toLocaleString()}
                    </td>
                    <td className="py-2 pr-2 text-right hidden sm:table-cell text-white/65">
                      {r.price ? fmtUSD(r.price) : "—"}
                    </td>
                    <td className="py-2 pr-2 text-right font-medium">
                      {fmtUSD(r.value)}
                    </td>
                    <td className="py-2 pl-2 text-right">
                      <span className={`${(r.pl || 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {(r.pl || 0) >= 0 ? "▲" : "▼"} {fmtUSD(Math.abs(r.pl))} ({fmtPct2(r.pl_pct)})
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              {/* Totals */}
              <tfoot>
                <tr className="border-t border-white/10">
                  <td colSpan={5} className="py-2 pr-2 text-right text-white/60">
                    Total (filtered):
                  </td>
                  <td className="py-2 pr-2 text-right font-semibold">{fmtUSD(totals.tv)}</td>
                  <td className="py-2 pl-2 text-right">
                    <span className={`${totals.tpl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {totals.tpl >= 0 ? "▲" : "▼"} {fmtUSD(Math.abs(totals.tpl))}
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      {drawerRow ? (
    <Portal>
      <PositionDrawer
        row={drawerRow}
        onClose={() => setDrawerRow(null)}
        onAskBizzy={onAskBizzy}
      />
    </Portal>
  ) : null}
    </div>
  );
}

/* ---------------- UI pieces ---------------- */

function MenuButton({ label, items }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="text-[12px] px-2 py-1 rounded-md ring-1 ring-inset ring-white/12 hover:bg-white/10"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {label} ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-44 rounded-xl ring-1 ring-inset ring-white/12 bg-[#0B0E13] p-1 z-10"
        >
          {items.map((it, i) => (
            <button
              key={i}
              onMouseDown={(e) => e.preventDefault()}
              onClick={it.onClick}
              className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/5 text-[13px]"
              role="menuitem"
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onConnect, onImportCSV, onAddManual }) {
  return (
    <div className="text-sm text-white/60 p-6 ring-1 ring-inset ring-white/12 rounded-xl bg-white/5">
      Not connected yet. Connect a brokerage or Import CSV.
      <div className="mt-3 flex gap-2">
        <button onClick={onConnect} className="text-[12px] px-2 py-1 rounded-md ring-1 ring-inset ring-white/12 hover:bg-white/10">
          Connect
        </button>
        <button onClick={onImportCSV} className="text-[12px] px-2 py-1 rounded-md ring-1 ring-inset ring-white/12 hover:bg-white/10">
          Import CSV
        </button>
        <button onClick={onAddManual} className="text-[12px] px-2 py-1 rounded-md ring-1 ring-inset ring-white/12 hover:bg-white/10">
          Add Manual
        </button>
      </div>
    </div>
  );
}

function PositionDrawer({ row, onClose, onAskBizzy }) {
  const series = useMemo(
    () =>
      Array.from({ length: 30 }, (_, i) => ({
        d: i + 1,
        p: (row.price || 100) * (0.95 + Math.random() * 0.1),
      })),
    [row]
  );
  const min = Math.min(...series.map((d) => d.p));
  const max = Math.max(...series.map((d) => d.p));
  const points = series
    .map((d, i) => {
      const x = (i / (series.length - 1)) * 300;
      const y = 80 - ((d.p - min) / Math.max(1, max - min)) * 80;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div className="fixed inset-0 z-[2000]">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full sm:w-[420px] bg-[#0B0E13] ring-1 ring-inset ring-white/12 p-4 sm:p-5 overflow-y-auto">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-white/60 text-xs">{row.account}</div>
            <div className="text-lg font-semibold">
              {row.ticker} <span className="text-white/50 text-sm">{row.name}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[12px] px-2 py-1 rounded-md ring-1 ring-inset ring-white/12 hover:bg-white/10"
            aria-label="Close details"
          >
            Close
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <Stat label="Shares" value={(row.quantity ?? 0).toLocaleString()} />
          <Stat label="Price" value={row.price ? fmtUSD(row.price) : "—"} />
          <Stat label="Value" value={fmtUSD(row.value)} />
          <Stat
            label="Unrealized P/L"
            value={`${row.pl >= 0 ? "+" : "-"}${fmtUSD(Math.abs(row.pl || 0))} (${fmtPct2(row.pl_pct)})`}
            className={row.pl >= 0 ? "text-emerald-400" : "text-rose-400"}
          />
        </div>

        <div className="mt-5">
          <div className="text-sm text-white/70 mb-2">Mini chart (30D)</div>
          <div className="h-32 rounded-xl ring-1 ring-inset ring-white/12 bg-white/5 overflow-hidden">
            <svg viewBox="0 0 300 80" className="w-full h-full" role="img" aria-label="30 day price preview">
              <polyline points={points} fill="none" stroke={NEON} strokeWidth="2" />
            </svg>
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            onClick={() => onAskBizzy?.(`Explain my P/L on ${row.ticker}`)}
            className="text-[12px] px-2 py-1 rounded-md ring-1 ring-inset ring-white/12 hover:bg-white/10"
          >
            Ask Bizzi about this
          </button>
          <button className="text-[12px] px-2 py-1 rounded-md ring-1 ring-inset ring-white/12 hover:bg-white/10">
            Edit cost basis
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, className }) {
  return (
    <div className={`rounded-xl ring-1 ring-inset ring-white/12 bg-white/5 p-3 ${className || ""}`}>
      <div className="text-white/50 text-xs">{label}</div>
      <div className="text-white/90 mt-1">{value}</div>
    </div>
  );
}
