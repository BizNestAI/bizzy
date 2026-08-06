// File: /src/components/Accounting/MonthlyBriefCard.jsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import CardHeader from "../UI/CardHeader";
import useFinancialPeriod from "../../hooks/useFinancialPeriod.js";
import { apiFetch } from "../../utils/apiBase.js";
import { getDemoData, shouldUseDemoData } from "../../services/demo/demoClient.js";

function monthLabel(y, m) {
  if (!y || !m) return "";
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "short", year: "numeric" });
}
function monthName(y, m) {
  if (!y || !m) return "";
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "long" });
}
function previousMonthName(y, m) {
  if (!y || !m) return "";
  return new Date(y, m - 2, 1).toLocaleString(undefined, { month: "long" });
}
function demoGeneratedAt(y, m) {
  if (!y || !m) return null;
  return new Date(y, m - 1, 15, 9, 0, 0).toISOString();
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
function generatedDateLabel(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
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

function adaptDemoPulseToPeriod(pulse, year, month) {
  if (!pulse) return null;
  const current = monthName(year, month) || "this month";
  const prior = previousMonthName(year, month) || "last month";
  return {
    ...pulse,
    revenueSummary: `Revenue is pacing $48.2k for ${current}, +15% vs ${prior} from two kitchen projects.`,
    spendingTrend: "Labor is elevated the next 10 days while both crews overlap; materials are normalizing after the Elm St delivery.",
    varianceFromForecast: "Cash is ~$7k ahead of forecast thanks to a $12k invoice that landed early.",
    createdAt: pulse.createdAt || demoGeneratedAt(year, month),
  };
}

export default function MonthlyBriefCard({ userId, businessId }) {
  const { year, month } = useFinancialPeriod(businessId);
  const [pulse, setPulse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const usingDemo = shouldUseDemoData();

  const demoPulse = useMemo(() => {
    if (!usingDemo) return null;
    const demo = getDemoData();
    return adaptDemoPulseToPeriod(normalizePulse(demo?.financials?.pulse || null), year, month);
  }, [month, usingDemo, year]);

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
    <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-xs font-semibold text-emerald-200">
      {label || ""}
    </span>
  );

  const rightControls = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {monthPill}
      {pulse?.createdAt && (
        <span className="rounded-full bg-white/[0.045] px-2.5 py-1 text-[11px] font-medium text-white/55" title={`Generated ${timeAgo(pulse.createdAt)}`}>
          Generated {generatedDateLabel(pulse.createdAt)}
        </span>
      )}
    </div>
  );

  const briefContent = useMemo(() => {
    if (!pulse) return [];
    const lead = [pulse.revenueSummary, pulse.spendingTrend, pulse.varianceFromForecast]
      .filter(Boolean)
      .join(" ");
    const insightParts = Array.isArray(pulse.businessInsights) ? pulse.businessInsights : [];
    const forecastPart =
      pulse.forecast && !lead.includes(pulse.forecast) ? [pulse.forecast] : [];
    return {
      lead,
      observations: [...insightParts, ...forecastPart].filter(Boolean),
    };
  }, [pulse]);

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-[linear-gradient(180deg,rgba(16,20,18,0.96),rgba(10,13,12,0.96))] text-white shadow-[0_22px_60px_rgba(0,0,0,0.36)]">
      <div className="p-5">
      <CardHeader
        title="MONTHLY BRIEF"
        right={rightControls}
        size="sm"
        dense
        className="mb-4"
        titleClassName="text-[13px] tracking-[0.16em]"
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
          Could not load brief.{" "}
          <button className="underline hover:no-underline" onClick={handleRefresh}>
            Retry
          </button>
          <div className="opacity-70 mt-1">{error}</div>
        </div>
      ) : null}

      <div className="space-y-4">
        {briefContent?.lead ? (
          <p className="max-w-4xl text-sm leading-6 text-white/82">
            {briefContent.lead}
          </p>
        ) : null}

        {briefContent?.observations?.length > 0 ? (
          <div className="grid gap-2 md:grid-cols-2">
            {briefContent.observations.map((s, idx) => (
              <div key={idx} className="rounded-xl bg-white/[0.035] px-3 py-2.5 ring-1 ring-white/[0.045]">
                <p className="text-sm leading-5 text-white/76">{s}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-white/60">No data recorded for this period.</p>
        )}
      </div>
      </div>

      <div className="border-t border-white/[0.06] bg-black/12 px-5 py-2.5">
        <p className="text-[11px] font-medium text-white/45">
          Calculated on the 15th and 1st of every month.
        </p>
      </div>
    </div>
  );
}
