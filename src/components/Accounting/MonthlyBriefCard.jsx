// File: /src/components/Accounting/MonthlyBriefCard.jsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import CardHeader from "../UI/CardHeader";
import { apiFetch } from "../../utils/apiBase.js";
import { getDemoData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import { useAdminView } from "../../context/AdminViewContext.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { useBusiness } from "../../context/BusinessContext.jsx";
import {
  MONTHLY_BRIEF_STATES,
  fetchMonthlyBriefLookup,
  monthlyBriefErrorState,
} from "./monthlyBriefState.js";

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
	    generatedAt:           pulse.generated_at ?? pulse.generatedAt ?? pulse.created_at ?? pulse.createdAt ?? null,
	    cadence:               pulse.cadence ?? null,
	    status:                pulse.status ?? null,
	    accountingMethod:      pulse.accountingMethod ?? pulse.accounting_method ?? null,
	    dataThroughDate:       pulse.dataThroughDate ?? pulse.data_through_date ?? null,
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

export default function MonthlyBriefCard() {
  const adminView = useAdminView();
  const { user, loading: authLoading } = useAuth() || {};
  const { businessId: contextBusinessId, loading: businessLoading } = useBusiness();
  const requestIdentityScope = adminView.active
    ? `admin:${adminView.businessId || "pending"}`
    : `customer:${user?.id || "pending"}:${contextBusinessId || "server-resolved"}`;
  const [lookup, setLookup] = useState({
    status: MONTHLY_BRIEF_STATES.AUTHENTICATION_PENDING,
    brief: null,
    error: null,
    requestId: null,
  });
  const requestGeneration = useRef(0);
  const usingDemo = shouldUseDemoData();

  const demoPulse = useMemo(() => {
    if (!usingDemo) return null;
    const demo = getDemoData();
    const now = new Date();
    return adaptDemoPulseToPeriod(normalizePulse(demo?.financials?.pulse || null), now.getFullYear(), now.getMonth() + 1);
  }, [usingDemo]);

  const pulsePeriod = useMemo(() => {
    const [year, month] = String(lookup.brief?.month || "").split("-").map(Number);
    return { year, month };
  }, [lookup.brief?.month]);
  const label = useMemo(() => monthLabel(pulsePeriod.year, pulsePeriod.month), [pulsePeriod.month, pulsePeriod.year]);

  const fetchPulse = useCallback(async (signal) => {
    // This scope is only a stale-response boundary. Tenant authority remains server-side.
    const identityScopeAtRequest = requestIdentityScope;
    const generation = ++requestGeneration.current;
    if (demoPulse) {
      setLookup({ status: MONTHLY_BRIEF_STATES.AVAILABLE, brief: demoPulse, error: null, requestId: "demo" });
      return;
    }
    const authenticationPending = authLoading || adminView.loading || (!adminView.active && businessLoading);
    if (authenticationPending || (!adminView.active && !user)) {
      setLookup({ status: MONTHLY_BRIEF_STATES.AUTHENTICATION_PENDING, brief: null, error: null, requestId: null });
      return;
    }
    setLookup({ status: MONTHLY_BRIEF_STATES.LOADING, brief: null, error: null, requestId: null });
    try {
      const url = "/api/accounting/pulse/latest";

      const next = await fetchMonthlyBriefLookup({ apiFetch, url, signal });
      if (generation === requestGeneration.current && identityScopeAtRequest === requestIdentityScope && !signal?.aborted) {
        setLookup({ ...next, error: null });
      }
    } catch (err) {
      if (err.name !== "AbortError" && generation === requestGeneration.current) {
        setLookup(monthlyBriefErrorState(err.requestId || null));
      }
    }
  }, [adminView.active, adminView.loading, authLoading, businessLoading, demoPulse, requestIdentityScope, user]);

  const handleRefresh = useCallback(async () => {
    const ac = new AbortController();
    await fetchPulse(ac.signal);
  }, [fetchPulse]);

  useEffect(() => {
    const ac = new AbortController();
    if (demoPulse) {
      setLookup({ status: MONTHLY_BRIEF_STATES.AVAILABLE, brief: demoPulse, error: null, requestId: "demo" });
    } else {
      fetchPulse(ac.signal);
    }
    return () => ac.abort();
  }, [demoPulse, fetchPulse]);

  const pulse = lookup.brief;

  const monthPill = (
    <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-xs font-semibold text-emerald-200">
      {label || ""}
    </span>
  );

  const rightControls = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {monthPill}
	      {lookup.status === MONTHLY_BRIEF_STATES.AVAILABLE && pulse?.generatedAt && (
	        <span className="rounded-full bg-white/[0.045] px-2.5 py-1 text-[11px] font-medium text-white/55" title={`Generated ${timeAgo(pulse.generatedAt)}`}>
	          Generated {generatedDateLabel(pulse.generatedAt)}
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

      {lookup.status === MONTHLY_BRIEF_STATES.LOADING ? (
        <div className="space-y-3 animate-pulse">
          <div className="h-4 bg-white/10 rounded w-2/3" />
          <div className="h-3 bg-white/10 rounded w-5/6" />
          <div className="h-3 bg-white/10 rounded w-1/2" />
        </div>
      ) : null}

      {lookup.status === MONTHLY_BRIEF_STATES.REQUEST_FAILED ? (
        <div className="mb-3 text-sm text-amber-100" role="alert">
          {lookup.error}{" "}
          <button className="underline hover:no-underline" onClick={handleRefresh}>
            Retry
          </button>
          {lookup.requestId ? <div className="mt-1 opacity-60">Request {lookup.requestId}</div> : null}
        </div>
      ) : null}

      <div className="space-y-4">
        {lookup.status === MONTHLY_BRIEF_STATES.AVAILABLE && briefContent?.lead ? (
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
	        ) : lookup.status === MONTHLY_BRIEF_STATES.NOT_GENERATED ? (
	          <p className="text-sm text-white/60">Your first monthly brief will appear automatically after the next eligible 1st or 15th processing cycle.</p>
	        ) : lookup.status === MONTHLY_BRIEF_STATES.AUTHENTICATION_PENDING ? (
	          <p className="text-sm text-white/60">Loading your latest monthly brief...</p>
	        ) : null}

        {lookup.status === MONTHLY_BRIEF_STATES.AVAILABLE ? (
          <div className="flex flex-wrap gap-2 text-[11px] font-medium text-white/50">
            <span>{pulse.cadence === "final" ? "Final monthly brief" : "Mid-month brief"}</span>
            {pulse.accountingMethod ? <span>{pulse.accountingMethod} basis</span> : null}
            {pulse.dataThroughDate && !String(pulse.dataThroughDate).endsWith("-01") ? (
              <span>Data through {generatedDateLabel(pulse.dataThroughDate)}</span>
            ) : null}
          </div>
        ) : null}
      </div>
      </div>

      <div className="border-t border-white/[0.06] bg-black/12 px-5 py-2.5">
        <p className="text-[11px] font-medium text-white/45">
	          Calculated on the 15th and 1st of every month from Cash-basis QuickBooks snapshots.
	        </p>
      </div>
    </div>
  );
}
