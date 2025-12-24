// Monthly Wealth Pulse — full report inline (no slide-over)
// -----------------------------------------------------------------------------
import React, { useEffect, useMemo, useState } from "react";
import {
  Bot, RefreshCcw,
  ArrowUpRight, CalendarPlus, CalendarClock, Route as RouteIcon, MessageSquare,
} from "lucide-react";
import CardHeader from "../UI/CardHeader";

// ✅ use API helpers so Authorization + ids are always attached via safeFetch
import {
  getWealthPulse,
  refreshWealthPulse,
} from "../../services/investmentsApi";

const NEON = "#C084FC";
const CARD_BG = "bg-[#0B0E13]";
const CARD_BORDER = "border border-white/5";
const GLOW = "shadow-[0_0_24px_#c084fc33]";
const fmtPct1 = (n) => `${(Math.round(Number(n || 0) * 10) / 10).toFixed(1)}%`;

export default function WealthPulseCard({
  userId,
  year = new Date().getFullYear(),
  month = new Date().getMonth() + 1,
  className = "",
  onAskBizzy,
  onSchedule,
  onNavigate,
}) {
  const [pulse, setPulse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const monthLabel = useMemo(() => {
    const d = new Date(year, month - 1, 1);
    return d.toLocaleString(undefined, { month: "long", year: "numeric" });
  }, [year, month]);

  async function fetchPulse({ force = false } = {}) {
    setError(null);
    if (!force) setLoading(true);
    try {
      const json = await getWealthPulse(year, month); // ✅ helper
      setPulse(json || null);
    } catch (e) {
      setError(e?.message || "Failed to load Wealth Pulse");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchPulse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, year, month]);

  async function onRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const json = await refreshWealthPulse(year, month); // ✅ helper
      setPulse(json || null);
    } catch (e) {
      setError(e?.message || "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  // ── CTA helpers ───────────────────────────────────────────────
  const ctaLabel = (c) => (typeof c === "string" ? c : c?.text || "");
  const ctaKind  = (c) => (typeof c === "string" ? "insights" : c?.kind || "insights");
  const ctaDue   = (c) => (typeof c === "object" && c?.due_at ? String(c.due_at) : undefined);

  function kindSubtext(c) {
    const kind = ctaKind(c);
    const due  = ctaDue(c);
    if (kind === "calendar" && due) {
      const dt = new Date(due);
      const label = isNaN(dt)
        ? due
        : dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      return `Due ${label}`;
    }
    if (kind === "link")      return "Open page";
    if (kind === "simulator") return "Open simulator";
    return "Ask Bizzi";
  }

  const handleCTA = (c) => {
    const kind = ctaKind(c);
    const text = ctaLabel(c);
    const due  = ctaDue(c);
    if (kind === "calendar" && due && onSchedule) return onSchedule(text, due);
    if (kind === "link" && c?.route && onNavigate) return onNavigate(c.route, c.params || {});
    return onAskBizzy?.(text);
  };

  const kindIcon = (kind) =>
    kind === "calendar" ? <CalendarClock size={14} className="text-amber-300" /> :
    kind === "link"      ? <RouteIcon size={14} className="text-sky-300" /> :
    kind === "simulator" ? <MessageSquare size={14} className="text-[#C084FC]" /> :
                           <MessageSquare size={14} className="text-white/70" />;

  // Pull bits for headline chip
  const headline   = pulse?.headline || "";
  const netChange  = pulse?.metrics?.net_worth_change_usd ?? 0;
  const netPct     = pulse?.metrics?.net_worth_change_pct ?? 0;
  const trendUp    = Number(netChange) >= 0;

  return (
    <div className={`${CARD_BG} ${CARD_BORDER} ${GLOW} rounded-2xl p-3 sm:p-4 ${className}`}>
      {/* CardHeader (compact) */}
      <CardHeader
        title="MONTHLY WEALTH PULSE"
        size="sm"
        dense
        className="mb-2"
        titleClassName="text-[13px]"
        right={
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline text-[12px] text-white/55">{monthLabel}</span>
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded-md ring-1 ring-inset ring-white/12 hover:bg-white/10 text-white/80"
              title="Recompute & update"
              aria-label="Refresh Wealth Pulse"
            >
              <RefreshCcw size={14} className={refreshing ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        }
      />

      {/* Body */}
      {loading ? (
        <Skeleton />
      ) : error ? (
        <div className="text-rose-400 text-sm">{error}</div>
      ) : !pulse ? (
        <div className="text-sm text-white/60">No Wealth Pulse available.</div>
      ) : (
        <div className="space-y-3 sm:space-y-4">
          {/* Headline + chip — slightly condensed */}
          <div className="relative rounded-xl border border-white/5 bg-black/30 p-3 sm:p-4">
            <div
              className="absolute -inset-0.5 rounded-xl opacity-30 blur-lg pointer-events-none"
              style={{ background: "radial-gradient(600px circle at 20% 0%, rgba(192,132,252,0.10), transparent 40%)" }}
            />
            <div className="relative">
              <div className="text-[13px] leading-relaxed text-white/90">{headline}</div>
              <div className="mt-2 inline-flex items-center gap-2 text-[12px] px-2.5 py-1.5 rounded-full border border-white/10 bg-white/5 text-white/80">
                <ArrowUpRight
                  size={14}
                  className={trendUp ? "text-emerald-300 rotate-0" : "text-rose-300 rotate-180"}
                />
                <span className={trendUp ? "text-emerald-300" : "text-rose-300"}>
                  {trendUp ? "+" : "-"}${Math.abs(Number(netChange)).toLocaleString()}
                </span>
                <span className="text-white/60">({fmtPct1(netPct)})</span>
              </div>
            </div>
          </div>

          {/* Strategic observations */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-3 sm:p-4">
            <div className="text-[11px] text-white/60 mb-2">Strategic observations</div>
            {pulse.observations?.length ? (
              <ul className="space-y-2.5">
                {pulse.observations.map((o, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <ObservationBadge category={o.category} />
                    <div className="text-[13px] sm:text-sm text-white/90">{o.text}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-sm text-white/60">No observations recorded.</div>
            )}
          </div>

          {/* Quick actions (CTAs) */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-3 sm:p-4">
            <div className="text-[11px] text-white/60 mb-2">Quick actions</div>
            {pulse.ctas?.length ? (
              <div className="flex flex-col gap-2">
                {pulse.ctas.map((c, idx) => {
                  const label = ctaLabel(c);
                  const kind  = ctaKind(c);
                  const sub   = kindSubtext(c);
                  return (
                    <div key={idx} className="flex items-center gap-2">
                      <button
                        onClick={() => handleCTA(c)}
                        className="text-left flex-1 inline-flex items-center gap-2 text-[12px] px-3 py-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-white/90 outline-none focus:ring-2 focus:ring-[#C084FC]/30"
                      >
                        {kindIcon(kind)}
                        <span className="truncate">{label}</span>
                        {sub && <span className="ml-auto text-[11px] text-white/50">{sub}</span>}
                      </button>
                      {ctaKind(c) === "calendar" && ctaDue(c) && onSchedule && (
                        <button
                          onClick={() => handleCTA(c)}
                          title="Add to calendar"
                          className="text-[12px] px-2 py-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-white/80 outline-none focus:ring-2 focus:ring-[#C084FC]/30"
                          aria-label="Add to calendar"
                        >
                          <CalendarPlus size={14} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm text-white/60">No actions suggested.</div>
            )}
          </div>

          {/* Snapshot metrics */}
          <MetricsPanel pulse={pulse} />
        </div>
      )}
    </div>
  );
}

/* ---- Subcomponents / utils ---- */
function ObservationBadge({ category }) {
  const c = String(category || "").toLowerCase();
  const map = { tax: "Tax", growth: "Growth", diversification: "Diversification", contributions: "Contributions" };
  const label = map[c] || "Observation";
  const color =
    c === "tax" ? "text-amber-300 border-amber-400/30" :
    c === "growth" ? "text-emerald-300 border-emerald-400/30" :
    c === "diversification" ? "text-sky-300 border-sky-400/30" :
    c === "contributions" ? "text-fuchsia-300 border-fuchsia-400/30" :
    "text-white/70 border-white/20";
  return <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full border ${color}`}>{label}</span>;
}

function Metric({ label, value, highlight }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-2">
      <div className="text-[11px] text-white/60">{label}</div>
      <div className={`text-sm ${highlight || "text-white/90"}`}>{value}</div>
    </div>
  );
}
function MetricsPanel({ pulse }) {
  const netChange = pulse?.metrics?.net_worth_change_usd ?? 0;
  const netPct = pulse?.metrics?.net_worth_change_pct ?? 0;
  const trendUp = Number(netChange) >= 0;
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3 sm:p-4">
      <div className="text-[11px] text-white/60 mb-2">Snapshot metrics</div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <Metric label="Net worth Δ" value={`${trendUp ? "+" : "-"}$${Math.abs(Number(netChange)).toLocaleString()}`} highlight={trendUp ? "text-emerald-300" : "text-rose-300"} />
        <Metric label="Net worth % Δ" value={fmtPct1(netPct)} />
        {pulse.metrics?.contribution_total_month != null && (
          <Metric label="Contrib this month" value={`$${Math.round(Number(pulse.metrics.contribution_total_month)).toLocaleString()}`} />
        )}
        {pulse.metrics?.retirement_status && (
          <Metric label="Retirement status" value={prettyStatus(pulse.metrics.retirement_status)} />
        )}
        {pulse.metrics?.retirement_probability != null && (
          <Metric label="Success probability" value={`${Math.round(pulse.metrics.retirement_probability * 100)}%`} />
        )}
        {Number.isFinite(pulse.metrics?.retirement_change_prob_pp) && (
          <Metric label="Prob Δ (pp)" value={`${Number(pulse.metrics.retirement_change_prob_pp) >= 0 ? "+" : ""}${pulse.metrics.retirement_change_prob_pp} pp`} />
        )}
      </div>
      {pulse.metrics?.top_account_movers?.length ? (
        <div className="mt-3">
          <div className="text-[11px] text-white/60 mb-1">Top account movers</div>
          <ul className="space-y-1 text-sm">
            {pulse.metrics.top_account_movers.map((m, i) => (
              <li key={i} className="flex items-center justify-between">
                <span className="text-white/80 truncate pr-2">{m.account}</span>
                <span className={`${(m.change_usd || 0) >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                  {(m.change_usd || 0) >= 0 ? "+" : "-"}${Math.abs(Number(m.change_usd || 0)).toLocaleString()}
                  {Number.isFinite(m.change_pct) && <span className="text-white/60"> ({fmtPct1(m.change_pct)})</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
function Skeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="rounded-xl border border-white/10 bg-white/5 p-4">
        <div className="h-4 w-3/4 bg-white/10 rounded" />
        <div className="h-4 w-2/5 bg-white/10 rounded mt-3" />
      </div>
      <div className="rounded-xl border border-white/10 bg-white/5 p-4">
        <div className="h-4 w-1/3 bg-white/10 rounded mb-2" />
        <div className="h-3 w-full bg-white/10 rounded" />
      </div>
    </div>
  );
}
function prettyStatus(s) {
  const v = String(s || "").replace("_", " ");
  if (v === "surplus") return "Surplus";
  if (v === "at risk") return "At risk";
  if (v === "shortfall") return "Shortfall";
  return "Unknown";
}
