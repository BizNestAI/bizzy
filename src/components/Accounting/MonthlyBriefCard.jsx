// File: /src/components/Accounting/MonthlyBriefCard.jsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import CardHeader from "../UI/CardHeader";
import { RefreshCw, RotateCw } from "lucide-react";
import useFinancialPeriod from "../../hooks/useFinancialPeriod.js";
import { apiFetch } from "../../utils/apiBase.js";
import { getDemoData, shouldUseDemoData } from "../../services/demo/demoClient.js";

const TF_STYLES = {
  Immediate: {
    chip: "bg-rose-500/15 text-rose-300 border-rose-400/30",
    stripe: "from-rose-500/60 to-rose-400/20",
  },
  "This Week": {
    chip: "bg-amber-500/15 text-amber-300 border-amber-400/30",
    stripe: "from-amber-500/60 to-amber-400/20",
  },
  "This Month": {
    chip: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
    stripe: "from-emerald-500/60 to-emerald-400/20",
  },
  default: {
    chip: "bg-white/10 text-white/70 border-white/20",
    stripe: "from-white/30 to-white/10",
  },
};

const TF_PRIORITY = {
  Immediate: 0,
  "This Week": 1,
  "This Month": 2,
  default: 3,
};

function monthLabel(y, m) {
  if (!y || !m) return "";
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "short", year: "numeric" });
}
function timeAgo(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

// normalize either camelCase or snake_case into a consistent shape
function normalizePulse(pulse) {
  if (!pulse) return null;
  return {
    revenueSummary:        pulse.revenueSummary ?? pulse.revenue_summary ?? "",
    spendingTrend:         pulse.spendingTrend ?? pulse.spending_trend ?? "",
    varianceFromForecast:  pulse.varianceFromForecast ?? pulse.variance_from_forecast ?? "",
    businessInsights:      Array.isArray(pulse.businessInsights)
                              ? pulse.businessInsights
                              : Array.isArray(pulse.business_insights)
                                ? pulse.business_insights
                                : [],
    motivationalMessage:   pulse.motivationalMessage ?? pulse.motivational_message ?? "",
    forecast:              pulse.forecast ?? pulse.forecast_summary ?? null,
    month:                 pulse.month ?? null,
    createdAt:             pulse.created_at ?? pulse.createdAt ?? null,
  };
}

function normalizeMoves(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.moves)) return raw.moves;
  return [];
}

export default function MonthlyBriefCard({ userId, businessId }) {
  const { year, month } = useFinancialPeriod(businessId);
  const [pulse, setPulse] = useState(null);
  const [moves, setMoves] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMoves, setLoadingMoves] = useState(false);
  const [error, setError] = useState(null);
  const [errorMoves, setErrorMoves] = useState(null);
  const [generatingPulse, setGeneratingPulse] = useState(false);
  const [regenCooldownUntil, setRegenCooldownUntil] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const usingDemo = shouldUseDemoData();

  const demoPulse = useMemo(() => {
    if (!usingDemo) return null;
    const demo = getDemoData();
    return normalizePulse(demo?.financials?.pulse || null);
  }, [usingDemo]);
  const demoMoves = useMemo(() => {
    if (!usingDemo) return null;
    const demo = getDemoData();
    return normalizeMoves(demo?.financials?.suggestedMoves || []);
  }, [usingDemo]);

  const label = useMemo(() => monthLabel(year, month), [year, month]);

  const fetchPulse = useCallback(async (signal) => {
    if (demoPulse) {
      setPulse(demoPulse);
      setError(null);
      return;
    }
    if (!userId || !businessId || !year || !month) {
      setPulse(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const url =
        `/api/accounting/pulse` +
        `?user_id=${encodeURIComponent(userId)}` +
        `&business_id=${encodeURIComponent(businessId)}` +
        `&year=${encodeURIComponent(year)}` +
        `&month=${encodeURIComponent(month)}`;

      const res = await apiFetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
          "x-business-id": businessId,
        },
        signal,
      });
      const ct = res.headers.get("content-type") || "";
      const raw = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 160)}`);
      if (!ct.includes("application/json")) throw new Error(`Non-JSON response (${ct})`);
      const data = JSON.parse(raw);
      setPulse(normalizePulse(data?.pulse ?? null));
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("[MonthlyBrief] pulse fetch failed:", err);
        setError(err.message || "Failed to load monthly pulse.");
        setPulse(null);
      }
    } finally {
      setLoading(false);
    }
  }, [businessId, demoPulse, month, userId, year]);

  const fetchMoves = useCallback(async (signal) => {
    if (demoMoves) {
      setMoves(demoMoves.slice(0, 3));
      setErrorMoves(null);
      return;
    }
    if (!userId || !businessId || !year || !month) {
      setMoves([]);
      return;
    }
    setLoadingMoves(true);
    setErrorMoves(null);
    try {
      const url =
        `/api/accounting/moves` +
        `?user_id=${encodeURIComponent(userId)}` +
        `&business_id=${encodeURIComponent(businessId)}` +
        `&year=${encodeURIComponent(year)}` +
        `&month=${encodeURIComponent(month)}`;
      const res = await apiFetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
          "x-business-id": businessId,
        },
        signal,
      });
      const ct = res.headers.get("content-type") || "";
      const raw = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
      if (!ct.includes("application/json")) throw new Error(`Non-JSON response (${ct}): ${raw.slice(0, 200)}`);
      const parsed = JSON.parse(raw);
      const list = normalizeMoves(parsed);
      const sorted = list
        .map((m, i) => ({ ...m, _idx: i }))
        .sort((a, b) => (TF_PRIORITY[a.timeframe] ?? TF_PRIORITY.default) - (TF_PRIORITY[b.timeframe] ?? TF_PRIORITY.default));
      setMoves(sorted.slice(0, 3));
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("[MonthlyBrief] moves fetch failed:", err);
        setErrorMoves(err.message || "Failed to load suggested moves.");
        setMoves(demoMoves ? demoMoves.slice(0, 3) : []);
      }
    } finally {
      setLoadingMoves(false);
    }
  }, [businessId, demoMoves, month, userId, year]);

  const handleRefresh = useCallback(async () => {
    const ac = new AbortController();
    await Promise.all([fetchPulse(ac.signal), fetchMoves(ac.signal)]);
  }, [fetchPulse, fetchMoves]);

  const handleGeneratePulse = useCallback(async () => {
    if (demoPulse) {
      setPulse(demoPulse);
      setError(null);
      return;
    }
    if (!userId || !businessId || !year || !month) return;
    setGeneratingPulse(true);
    setError(null);
    try {
      await apiFetch(`/api/accounting/pulse/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
          "x-business-id": businessId,
        },
        body: JSON.stringify({ user_id: userId, business_id: businessId, year, month }),
      });
      await fetchPulse();
    } catch (err) {
      console.error("[MonthlyBrief] generate pulse failed:", err);
      setError(err.message || "Could not generate pulse snapshot.");
    } finally {
      setGeneratingPulse(false);
    }
  }, [businessId, demoPulse, fetchPulse, month, userId, year]);

  const handleRegenerateMoves = useCallback(async () => {
    if (demoMoves) return;
    if (!userId || !businessId || !year || !month) return;
    if (regenCooldownUntil && Date.now() < regenCooldownUntil) return;
    setRegenCooldownUntil(Date.now() + 60_000);
    setLoadingMoves(true);
    try {
      await apiFetch(`/api/accounting/moves/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
          "x-business-id": businessId,
        },
        body: JSON.stringify({ user_id: userId, business_id: businessId, year, month }),
      });
      await fetchMoves();
    } catch (err) {
      console.error("[MonthlyBrief] regenerate moves failed:", err);
      setErrorMoves("Could not regenerate moves.");
    } finally {
      setLoadingMoves(false);
    }
  }, [businessId, demoMoves, fetchMoves, month, regenCooldownUntil, userId, year]);

  useEffect(() => {
    const ac = new AbortController();
    if (demoPulse) {
      setPulse(demoPulse);
      setError(null);
    } else {
      fetchPulse(ac.signal);
    }
    return () => ac.abort();
  }, [demoPulse, fetchPulse]);

  useEffect(() => {
    const ac = new AbortController();
    if (demoMoves) {
      setMoves(demoMoves.slice(0, 3));
      setErrorMoves(null);
    } else {
      fetchMoves(ac.signal);
    }
    return () => ac.abort();
  }, [demoMoves, fetchMoves]);

  const monthPill = (
    <span className="text-xs px-2 py-0.5 rounded-full border border-emerald-400/30 text-emerald-300">
      {label || ""}
    </span>
  );

  const rightControls = (
    <div className="flex flex-wrap items-center gap-2">
      {monthPill}
      {pulse?.createdAt && (
        <span className="text-[11px] text-white/40">Updated {timeAgo(pulse.createdAt)}</span>
      )}
      {pulse ? (
        <button
          onClick={handleRefresh}
          disabled={loading || loadingMoves}
          className="text-xs px-2 py-1 rounded-md border flex items-center gap-1 hover:bg-white/10 disabled:opacity-50"
          title="Refresh pulse and moves"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      ) : (
        <button
          onClick={handleGeneratePulse}
          disabled={generatingPulse}
          className="text-xs px-2 py-1 rounded-md border flex items-center gap-1 hover:bg-white/10 disabled:opacity-50"
          title="Generate pulse snapshot"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {generatingPulse ? "Generating…" : "Generate pulse"}
        </button>
      )}
      <button
        onClick={handleRegenerateMoves}
        disabled={loadingMoves || (regenCooldownUntil && Date.now() < regenCooldownUntil)}
        className="text-xs px-2 py-1 rounded-md border flex items-center gap-1 hover:bg-white/10 disabled:opacity-50"
        title="Regenerate suggested moves"
      >
        <RotateCw className="w-3.5 h-3.5" />
        {regenCooldownUntil && Date.now() < regenCooldownUntil ? "Cooldown…" : "Regenerate"}
      </button>
    </div>
  );

  const summaryParts = useMemo(() => {
    if (!pulse) return [];
    const parts = [pulse.revenueSummary, pulse.spendingTrend, pulse.varianceFromForecast].filter(Boolean);
    return parts;
  }, [pulse]);

  const movesToRender = moves
    .map((m) => ({ ...m, timeframe: m.timeframe || "This Month" }))
    .sort((a, b) => (TF_PRIORITY[a.timeframe] ?? TF_PRIORITY.default) - (TF_PRIORITY[b.timeframe] ?? TF_PRIORITY.default))
    .slice(0, 3);

  const hasDetails =
    (pulse?.businessInsights && pulse.businessInsights.length > 0) ||
    Boolean(pulse?.motivationalMessage) ||
    Boolean(pulse?.forecast);

  return (
    <div className="bg-zinc-900 border border-white/10 rounded-xl p-4 text-white shadow-lg">
      <CardHeader
        title="MONTHLY BRIEF"
        right={rightControls}
        size="sm"
        dense
        className="mb-2"
        titleClassName="text-[13px]"
      />

      {(loading || loadingMoves) && !pulse && moves.length === 0 ? (
        <div className="space-y-3 animate-pulse">
          <div className="h-4 bg-white/10 rounded w-2/3" />
          <div className="h-3 bg-white/10 rounded w-5/6" />
          <div className="h-3 bg-white/10 rounded w-1/2" />
        </div>
      ) : null}

      {error ? (
        <div className="text-red-400 text-sm mb-3">
          Could not load pulse.{" "}
          <button className="underline hover:no-underline" onClick={handleRefresh}>
            Retry
          </button>
          <div className="opacity-70 mt-1">{error}</div>
        </div>
      ) : null}

      {errorMoves ? (
        <div className="text-amber-300 text-xs mb-3">{errorMoves}</div>
      ) : null}

      {/* Summary */}
      <div className="mb-4">
        <p className="text-sm font-semibold text-white/85 mb-1">Summary</p>
        {summaryParts.length > 0 ? (
          <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-white/80">
            {summaryParts.slice(0, 5).map((s, idx) => (
              <li key={idx}>{s}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-white/60">No data recorded for this period.</p>
        )}
      </div>

      {/* Moves */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-semibold text-white/85">Suggested moves</p>
        </div>
        {movesToRender.length === 0 ? (
          <p className="text-sm text-white/60">No suggested moves yet — regenerate.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {movesToRender.map((move, idx) => {
              const tf = move.timeframe || "This Month";
              const style = TF_STYLES[tf] || TF_STYLES.default;
              return (
                <div
                  key={`${move.title || "move"}-${idx}`}
                  className="relative overflow-hidden rounded-md border border-white/10 bg-white/5 px-3 py-3"
                >
                  <div className={`pointer-events-none absolute left-0 top-0 h-full w-1 bg-gradient-to-b ${style.stripe}`} />
                  <div className="pl-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-[11px] px-2 py-0.5 rounded-full border ${style.chip}`}>
                        {tf}
                      </span>
                      {move.month ? (
                        <span className="text-[11px] text-white/45">for {move.month}</span>
                      ) : null}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-white/90 leading-tight">
                      {move.title || "Suggested move"}
                    </div>
                    <div className="text-xs text-white/70 line-clamp-2">
                      {move.rationale || move.description || "—"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Details accordion */}
      {hasDetails ? (
        <div className="border-t border-white/10 pt-3 mt-3">
          <button
            type="button"
            onClick={() => setDetailsOpen((p) => !p)}
            className="text-xs inline-flex items-center gap-2 text-white/80 hover:text-white focus:outline-none"
          >
            <span>{detailsOpen ? "Hide details" : "Show details"}</span>
          </button>
          {detailsOpen && (
            <div className="mt-2 space-y-2 text-sm text-white/80">
              {pulse?.businessInsights?.length ? (
                <ul className="list-disc pl-5 space-y-1">
                  {pulse.businessInsights.map((ins, idx) => (
                    <li key={idx}>{ins}</li>
                  ))}
                </ul>
              ) : null}
              {pulse?.forecast ? (
                <div className="text-white/75">{pulse.forecast}</div>
              ) : null}
              {pulse?.motivationalMessage ? (
                <div className="text-white/60 italic">{pulse.motivationalMessage}</div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
