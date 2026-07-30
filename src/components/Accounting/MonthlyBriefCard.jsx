// File: /src/components/Accounting/MonthlyBriefCard.jsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import CardHeader from "../UI/CardHeader";
import { RefreshCw } from "lucide-react";
import useFinancialPeriod from "../../hooks/useFinancialPeriod.js";
import { apiFetch } from "../../utils/apiBase.js";
import { getDemoData, shouldUseDemoData } from "../../services/demo/demoClient.js";

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

export default function MonthlyBriefCard({ userId, businessId }) {
  const { year, month } = useFinancialPeriod(businessId);
  const [pulse, setPulse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [generatingPulse, setGeneratingPulse] = useState(false);
  const usingDemo = shouldUseDemoData();

  const demoPulse = useMemo(() => {
    if (!usingDemo) return null;
    const demo = getDemoData();
    return normalizePulse(demo?.financials?.pulse || null);
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

  const handleRefresh = useCallback(async () => {
    const ac = new AbortController();
    await fetchPulse(ac.signal);
  }, [fetchPulse]);

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
          disabled={loading}
          className="text-xs px-2 py-1 rounded-md border flex items-center gap-1 hover:bg-white/10 disabled:opacity-50"
          title="Refresh pulse"
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
    </div>
  );

  const summaryParts = useMemo(() => {
    if (!pulse) return [];
    const coreParts = [pulse.revenueSummary, pulse.spendingTrend, pulse.varianceFromForecast];
    const insightParts = Array.isArray(pulse.businessInsights) ? pulse.businessInsights : [];
    const forecastPart =
      pulse.forecast && !coreParts.includes(pulse.forecast) ? [pulse.forecast] : [];
    const parts = [...coreParts, ...insightParts, ...forecastPart].filter(Boolean);
    return parts;
  }, [pulse]);

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

      {loading && !pulse ? (
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

      {/* Summary */}
      <div>
        <p className="text-sm font-semibold text-white/85 mb-1">Summary</p>
        {summaryParts.length > 0 ? (
          <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-white/80">
            {summaryParts.map((s, idx) => (
              <li key={idx}>{s}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-white/60">No data recorded for this period.</p>
        )}
        {pulse?.motivationalMessage ? (
          <p className="mt-3 text-sm italic text-white/60">{pulse.motivationalMessage}</p>
        ) : null}
      </div>
    </div>
  );
}
