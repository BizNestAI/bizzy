// /src/components/Tax/TaxSnapshotMini.jsx
import React from "react";
import { useMonthlySnapshot } from "../../hooks/useMonthlySnapshot";
import { AlertTriangle, CheckCircle2, MinusCircle } from "lucide-react";
import CardHeader from "../UI/CardHeader";

const GOLD_MUTED = "rgba(227, 194, 92, 1)"; // softer gold accent

export default function TaxSnapshotMini({
  businessId,
  year,
  month,
  onAskBizzy,
  onOpen,
  title = "MONTHLY TAX SNAPSHOT",
  /** Optional: lock the card to a shared min height so it aligns with the chart */
  height, // e.g., 200
}) {
  const { snapshot, loading, error } = useMonthlySnapshot({ businessId, year, month });
  const m = snapshot?.metrics;

  // decide the minHeight (fallback to previous 236)
  const minH = typeof height === "number" ? height : 236;

  return (
    <div className="w-full min-w-0">
      {/* Consistent compact header like other dashboards */}
      <CardHeader
        title={title}
        size="sm"
        dense
        className="mb-2"
        titleClassName="text-[13px]"
        right={
          onOpen ? (
            <button
              onClick={onOpen}
              className="text-[12px] px-2 py-1 rounded-md ring-1 ring-inset ring-white/12 hover:bg-white/10"
              type="button"
            >
              Open full snapshot
            </button>
          ) : null
        }
      />

      <div
        className="
          relative rounded-xl w-full min-w-0
          bg-white/5 backdrop-blur-sm
          ring-1 ring-inset ring-white/10
          p-3 sm:p-4
        "
        style={{ minHeight: minH }}
      >
        {loading ? (
          <MiniSkeleton />
        ) : error ? (
          <div className="text-xs text-rose-300">{error}</div>
        ) : snapshot ? (
          <div className="flex flex-col gap-3">
            {/* KPIs — responsive so they don’t squish when the rail is open */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <MiniKPI
                label="Estimated YTD Tax Due"
                value={fmtUSD(m?.estimatedTaxDue)}
                severity={severity(m?.estimatedTaxDue)}
              />
              <MiniKPI
                label="Profit YTD"
                value={fmtUSD(m?.profitYTD)}
                severity="ok"
              />
              <MiniKPIList
                title="Top Deduction"
                itemLabel={m?.topDeductions?.[0]?.category}
                itemValue={fmtUSD(m?.topDeductions?.[0]?.amount)}
              />
            </div>

            {/* Summary text – clamp to two lines to avoid overflow */}
            <p className="text-[12px] text-white/75 leading-relaxed line-clamp-2">
              {snapshot.summary}
            </p>
          </div>
        ) : (
          <div className="text-xs text-white/70">No snapshot available.</div>
        )}
      </div>
    </div>
  );
}

/* ---------- Atoms (muted, glass-friendly) ---------- */

function MiniKPI({ label, value, severity = "ok" }) {
  const color =
    severity === "high" ? "text-rose-300"
    : severity === "med" ? "text-[rgba(227,194,92,.95)]"
    : "text-emerald-400";

  const Icon =
    severity === "high" ? AlertTriangle
    : severity === "med"  ? MinusCircle
    : CheckCircle2;

  return (
    <div className="rounded-lg p-3 bg-white/4 ring-1 ring-inset ring-white/10 min-h-[84px] flex flex-col justify-between">
      <div className="text-[11px] uppercase tracking-wide" style={{ color: "rgba(227,194,92,.85)" }}>
        {label}
      </div>
      <div className={`mt-1 flex items-center justify-end gap-1 ${color}`}>
        <Icon className="h-2.5 w-2.5 shrink-0" />
        {/* slightly smaller numbers so they fit reliably */}
        <div className="text-[13px] md:text-[14px] font-semibold font-mono tabular-nums whitespace-nowrap">
          {value ?? "—"}
        </div>
      </div>
    </div>
  );
}

function MiniKPIList({ title, itemLabel, itemValue }) {
  return (
    <div className="rounded-lg p-3 bg-white/4 ring-1 ring-inset ring-white/10 min-h-[84px] flex flex-col justify-between">
      <div className="text-[11px] uppercase tracking-wide" style={{ color: "rgba(227,194,92,.85)" }}>
        {title}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <div className="text-xs text-white/85 truncate max-w-[60%]" title={itemLabel || ""}>
          {itemLabel || "—"}
        </div>
        {/* slightly smaller money text */}
        <div className="text-[10px] md:text-[12px] font-mono tabular-nums whitespace-nowrap" style={{ color: GOLD_MUTED }}>
          {itemValue ?? "—"}
        </div>
      </div>
    </div>
  );
}

function MiniSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div className="h-[84px] w-full animate-pulse rounded-md bg-white/8" />
      <div className="h-[84px] w-full animate-pulse rounded-md bg-white/8" />
      <div className="h-[84px] w-full animate-pulse rounded-md bg-white/8" />
    </div>
  );
}

/* ---------- utils ---------- */
function fmtUSD(n) {
  if (typeof n !== "number") return "—";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
function severity(n) {
  if (typeof n !== "number") return "ok";
  return n > 25000 ? "high" : n > 12000 ? "med" : "ok";
}
