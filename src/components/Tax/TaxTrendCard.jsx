// src/components/Tax/TaxTrendCard.jsx
import React, { useMemo } from "react";
import { TrendingUp, TrendingDown, Radio, RefreshCw } from "lucide-react";
import TaxLiabilityChart from "./TaxLiabilityChart";

export default function TaxTrendCard({
  data = [],
  quarterly = [],
  lastRefreshed,
  loading,
  error,
  onRefresh,
  source,
}) {
  const insight = useMemo(() => buildInsight(data), [data]);
  const trendingDown = useMemo(() => isTrendingDown(data), [data]);
  const quarters = useMemo(() => buildQuarterMarkers(data, quarterly), [data, quarterly]);

  return (
    <div className="rounded-[20px] border border-white/10 bg-gradient-to-br from-white/[0.06] via-white/[0.03] to-black/60 shadow-[0_18px_50px_rgba(0,0,0,0.35)] p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-[12px] uppercase tracking-[0.14em] text-white/65">Tax liability trend</div>
          <div className="text-xl font-semibold text-white">Trajectory</div>
          {insight ? (
            <div className="inline-flex items-center gap-1.5 text-[13px] text-white/75">
              {trendingDown ? (
                <TrendingDown className="h-4 w-4 text-rose-300" />
              ) : (
                <TrendingUp className="h-4 w-4 text-[rgba(var(--accent-rgb),0.9)]" />
              )}
              {insight}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-[12px]">
          <Pill label={source === "mock" ? "Demo" : "Live"} tone={source === "mock" ? "muted" : "accent"} />
          <Pill label={lastRefreshed ? `Updated ${lastRefreshed}` : "Updated just now"} tone="muted" icon={<Radio className="h-3.5 w-3.5" />} />
          {onRefresh ? (
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 border border-white/12 text-white/80 hover:text-white hover:bg-white/10 transition"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-3">
        {error ? <div className="text-xs text-rose-300 mb-2">{error}</div> : null}
        <TaxLiabilityChart
          data={data}
          quarters={quarters}
          height={260}
          source={source}
          loading={loading}
          onRefresh={onRefresh}
          title="TAX LIABILITY TREND"
          showHeader={false}
        />
      </div>
    </div>
  );
}

function Pill({ label, icon = null, tone = "muted" }) {
  const cls =
    tone === "accent"
      ? "text-[rgba(var(--accent-rgb),0.95)] bg-[rgba(var(--accent-rgb),0.12)] ring-[rgba(var(--accent-rgb),0.35)]"
      : "text-white/75 bg-white/8 ring-white/12";
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] ring-1 ring-inset ${cls}`}>
      {icon}
      {label}
    </span>
  );
}

function buildInsight(data = []) {
  if (!data.length) return "";
  const numeric = data.map((d) => Number(d.estTax ?? d.tax ?? 0));
  const first = numeric[0];
  const last = numeric[numeric.length - 1];
  if (Number.isNaN(first) || Number.isNaN(last)) return "";
  const delta = last - first;
  if (Math.abs(delta) < 25) return "Liability is holding steady.";
  return delta > 0 ? "Liability trending up; plan cash for the next quarter." : "Liability easing; stay on cadence.";
}

function isTrendingDown(data = []) {
  if (!data.length) return false;
  const numeric = data.map((d) => Number(d.estTax ?? d.tax ?? 0)).filter((n) => !Number.isNaN(n));
  if (!numeric.length) return false;
  const first = numeric[0];
  const last = numeric[numeric.length - 1];
  return last < first - 25;
}

function buildQuarterMarkers(data = [], quarterly = []) {
  if (quarterly?.length) return quarterly;
  return (data || [])
    .map((d, idx) => {
      const label = d.month || d.period || d.label;
      const month = monthFromIso(label);
      return month && month % 3 === 0 ? { quarter: `Q${Math.ceil(month / 3)}`, index: idx, label: d.label || label } : null;
    })
    .filter(Boolean);
}

function monthFromIso(str = "") {
  if (!str) return null;
  const match = String(str).match(/-(\d{2})/);
  if (match) return Number(match[1]);
  const monthNames = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const lower = str.toLowerCase();
  const idx = monthNames.findIndex((m) => lower.startsWith(m));
  return idx >= 0 ? idx + 1 : null;
}
