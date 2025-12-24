// File: /src/components/Accounting/FinancialPulseCard.jsx
import React, { useEffect, useMemo, useState } from "react";
import { usePeriod } from "../../context/PeriodContext";
import { RefreshCw, MessageCircle } from "lucide-react";
import CardHeader from "../UI/CardHeader"; // ⬅️ unify header style
import { getDemoData, shouldUseDemoData } from "../../services/demo/demoClient.js";

const API_BASE = import.meta.env?.VITE_API_BASE || "";

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
    month:                 pulse.month ?? null,
    createdAt:             pulse.created_at ?? pulse.createdAt ?? null,
  };
}

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

export default function FinancialPulseCard({ userId, businessId }) {
  const { period } = usePeriod(); // { year, month }
  const [pulse, setPulse] = useState(null);
  const [loading, setLoading] = useState(!!(userId && businessId));
  const [error, setError] = useState(null);
  const [generating, setGenerating] = useState(false);
  const usingDemo = shouldUseDemoData();
  const demoPulse = useMemo(() => {
    if (!usingDemo) return null;
    const demo = getDemoData();
    return normalizePulse(demo?.financials?.pulse || null);
  }, [usingDemo]);

  const label = useMemo(
    () => monthLabel(period?.year, period?.month),
    [period?.year, period?.month]
  );

  async function fetchPulse(signal) {
    if (demoPulse) {
      setPulse(demoPulse);
      setLoading(false);
      return;
    }
    if (!userId || !businessId || !period?.year || !period?.month) {
      setPulse(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const url =
        `${API_BASE}/api/accounting/pulse` +
        `?user_id=${encodeURIComponent(userId)}` +
        `&business_id=${encodeURIComponent(businessId)}` +
        `&year=${encodeURIComponent(period.year)}` +
        `&month=${encodeURIComponent(period.month)}`;

      const res = await fetch(url, {
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
      if (!ct.includes("application/json"))
        throw new Error(`Non-JSON response (${ct}): ${raw.slice(0, 160)}`);

      const data = JSON.parse(raw);
      setPulse(normalizePulse(data?.pulse ?? null));
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("[FinancialPulseCard] fetch failed:", err);
        setError(err.message || "Failed to load financial pulse.");
        setPulse(null);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleGenerate() {
    if (demoPulse) {
      setPulse(demoPulse);
      setError(null);
      return;
    }
    if (!userId || !businessId || !period?.year || !period?.month) return;
    setGenerating(true);
    setError(null);
    try {
      await fetch(`${API_BASE}/api/accounting/pulse/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
          "x-business-id": businessId,
        },
        body: JSON.stringify({
          user_id: userId,
          business_id: businessId,
          year: period.year,
          month: period.month,
        }),
      });
      await fetchPulse(); // refresh after generation
    } catch (e) {
      console.error("[FinancialPulseCard] generate failed:", e);
      setError("Could not generate pulse snapshot.");
    } finally {
      setGenerating(false);
    }
  }

  useEffect(() => {
    const ac = new AbortController();
    fetchPulse(ac.signal);
    return () => ac.abort();
  }, [userId, businessId, period?.year, period?.month, demoPulse]);

  // UI
  const monthPill = (
    <span className="text-xs px-2 py-0.5 rounded-full border border-emerald-400/30 text-emerald-300">
      {label || ""}
    </span>
  );

  const rightControls = (
    <div className="flex items-center gap-2">
      {monthPill}
      {pulse?.createdAt && (
        <span className="text-[11px] text-white/40">Updated {timeAgo(pulse.createdAt)}</span>
      )}
      <button
        onClick={pulse ? () => fetchPulse() : handleGenerate}
        disabled={generating || loading}
        className={[
          "text-xs px-2 py-1 rounded-md border flex items-center gap-1",
          "hover:bg-white/10 transition-colors",
          generating || loading ? "opacity-50 cursor-not-allowed" : "",
        ].join(" ")}
        title={pulse ? "Refresh snapshot" : "Generate snapshot"}
      >
        {pulse ? (
          <>
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </>
        ) : (
          <>
            <MessageCircle className="w-3.5 h-3.5" />
            Generate
          </>
        )}
      </button>
    </div>
  );

  return (
    <div className="bg-zinc-900 border border-white/10 rounded-xl p-4 text-white shadow-lg">
      {/* Compact CardHeader to match Pulse/Financials card titles */}
      <CardHeader
        title="MONTHLY FINANCIAL PULSE"
        right={rightControls}
        size="sm"
        dense
        className="mb-2"
        titleClassName="text-[13px]" // safe override if supported
      />

      {loading ? (
        <div className="space-y-3 animate-pulse">
          <div className="h-4 bg-white/10 rounded w-2/3" />
          <div className="h-3 bg-white/10 rounded w-5/6" />
          <div className="h-3 bg-white/10 rounded w-1/2" />
          <div className="h-3 bg-white/10 rounded w-4/6" />
        </div>
      ) : error ? (
        <div className="text-red-400 text-sm">
          Could not load pulse.&nbsp;
          <button className="underline hover:no-underline" onClick={() => fetchPulse()}>
            Retry
          </button>
          <div className="opacity-70 mt-1">{error}</div>
        </div>
      ) : !pulse ? (
        <div className="text-white/70 text-sm">
          No financial pulse for {label}.&nbsp;
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="inline-flex items-center gap-1 text-emerald-300 underline hover:no-underline disabled:opacity-50"
          >
            <MessageCircle className="w-4 h-4" />
            Generate now
          </button>
        </div>
      ) : (
        <>
          {/* Defensive reads */}
          <div className="space-y-3 text-sm">
            <p>
              <span className="font-medium text-emerald-400">Revenue:</span>{" "}
              <span className="text-white/90">{pulse.revenueSummary || "—"}</span>
            </p>
            <p>
              <span className="font-medium text-yellow-400">Spending:</span>{" "}
              <span className="text-white/90">{pulse.spendingTrend || "—"}</span>
            </p>
            <p>
              <span className="font-medium text-red-400">Forecast:</span>{" "}
              <span className="text-white/90">{pulse.varianceFromForecast || "—"}</span>
            </p>

            {!!(pulse.businessInsights || []).length && (
              <div className="mt-2">
                <p className="text-white/80 font-medium mb-1">💡 Insights:</p>
                <ul className="list-disc list-inside text-white/70 space-y-1">
                  {pulse.businessInsights.map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {pulse.motivationalMessage && (
              <div className="mt-3 border-t border-white/10 pt-3">
                <p className="italic text-white/80">{pulse.motivationalMessage}</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
