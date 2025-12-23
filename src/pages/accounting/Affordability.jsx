// File: /src/pages/accounting/Affordability.jsx
import React, { useMemo, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { ArrowRight, Loader2, ShieldAlert } from "lucide-react";

import AffordabilityInputForm from "../../components/Accounting/AffordabilityInputForm.jsx";
import AffordabilityInsightCard from "../../components/Accounting/AffordabilityInsightCard.jsx"; 
import { useRightExtras } from "../../insights/RightExtrasContext";
import AgendaWidget from "../../pages/Calendar/AgendaWidget.jsx";

/* ---------------------------- helpers ---------------------------- */

/** Convert a repeating expense definition into a monthly cash impact */
function monthlyImpact(amount, frequency) {
  const a = Number(amount) || 0;
  switch ((frequency || "one-time").toLowerCase()) {
    case "monthly":
      return a;
    case "weekly":
      return (a * 52) / 12;
    case "bi-weekly":
    case "biweekly":
      return (a * 26) / 12;
    case "quarterly":
      return a / 3;
    case "annually":
    case "yearly":
      return a / 12;
    case "one-time":
    default:
      return 0; // treat one-time separately when we check the chosen month
  }
}

/** Very small deterministic fallback model if API is unavailable */
const MOCK_FORECAST = Array.from({ length: 12 }, (_, i) => {
  const baseRev = 20000 + i * 500;
  const baseExp = 15000 + i * 400;
  const cash_in = baseRev;
  const cash_out = baseExp;
  const net_cash = cash_in - cash_out;
  return {
    month_label: new Date(new Date().getFullYear(), new Date().getMonth() + i, 1).toLocaleString(
      "default",
      { month: "short", year: "numeric" }
    ),
    net_cash,
    ending_cash: 30000 + (i + 1) * net_cash,
  };
});

/** Pull forecast from your API for fallback logic */
async function fetchForecast({ userId, businessId, months = 12 }) {
  const url = `/api/accounting/forecast?userId=${encodeURIComponent(
    userId
  )}&businessId=${encodeURIComponent(businessId)}&months=${months}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rows = Array.isArray(json.forecast) ? json.forecast : [];
    if (!rows.length) return MOCK_FORECAST;
    // normalize to what we need locally
    return rows.map((r) => ({
      month_label: r.month_label || r.month,
      net_cash: Number(r.net_cash || 0),
      ending_cash: Number(r.ending_cash || 0),
    }));
  } catch {
    return MOCK_FORECAST;
  }
}

/** Local affordability calculator used only when backend check fails */
function localAffordability({ forecastRows, amount, frequency }) {
  const monthly = monthlyImpact(amount, frequency);
  const startIdx = 0; // simple: treat the first month as the start horizon
  const horizon = forecastRows.slice(startIdx, startIdx + 6); // look at next 6 months

  // One-time impact: subtract from first month only
  const oneTime = (frequency || "").toLowerCase() === "one-time" ? Number(amount) || 0 : 0;

  let okayMonths = 0;
  let projectedEnding = 0;

  horizon.forEach((m, i) => {
    const impact = (i === 0 ? oneTime : 0) + monthly;
    const postNet = m.net_cash - impact;
    const postEnd = (i === 0 ? m.ending_cash : projectedEnding) + (i === 0 ? -oneTime : 0) - monthly;
    if (postNet >= 0) okayMonths += 1;
    projectedEnding = postEnd;
  });

  let verdict = "Depends";
  if (okayMonths >= horizon.length - 1 && projectedEnding > 0) verdict = "Yes";
  else if (okayMonths <= Math.floor(horizon.length / 2) || projectedEnding < 0) verdict = "No";

  const rationale =
    verdict === "Yes"
      ? "Projected cash stays positive across the near-term horizon."
      : verdict === "No"
      ? "The expense pushes monthly cash flow negative or depletes ending cash below zero."
      : "Cash is tight in some months; timing or splitting the expense would reduce risk.";

  const recommendations = [];
  if (verdict !== "Yes") {
    recommendations.push(
      "Delay the start date by 30–60 days to align with stronger cash months.",
      "Reduce scope or break the expense into installments if possible.",
      "Add a temporary price increase or promo to boost near-term cash in."
    );
  } else {
    recommendations.push("Proceed, but monitor AR collections and large outgoing payments.");
  }

  return {
    verdict,
    rationale,
    impactSummary: {
      monthlyExpenseImpact: monthly,
      oneTimeImpact: oneTime,
      monthsReviewed: horizon.length,
      endCashAfterHorizon: Math.round(projectedEnding),
    },
    recommendations,
    caveats: [
      "This quick check uses forecasted cash flow only; it does not include credit lines or reserves outside the forecast.",
    ],
  };
}

/* ------------------------------ page ------------------------------ */

export default function Affordability({ businessId: propBusinessId, userId: propUserId }) {
  const [userId, setUserId] = useState(propUserId || null);
  const [businessId, setBusinessId] = useState(propBusinessId || null);
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [backendUsed, setBackendUsed] = useState(false);
  const [error, setError] = useState("");

// publish AgendaWidget into right rail
   const { setRightExtras } = useRightExtras();
   useEffect(() => {
     if (!businessId) {
       setRightExtras(null);
       return;
     }
     setRightExtras(
       <AgendaWidget
         key={`financials-agenda-${businessId}`}          // remount on business change
         businessId={businessId}
         module="financials"
         onOpenCalendar={() => navigate("/dashboard/calendar")}
       />
     );
     return () => setRightExtras(null);
   }, [businessId, navigate, setRightExtras]);

  useEffect(() => {
    if (!propUserId) setUserId(localStorage.getItem("user_id") || null);
    if (!propBusinessId) {
      const id = localStorage.getItem("currentBusinessId");
      if (id && id !== "null" && id !== "undefined") setBusinessId(id);
    }
  }, [propUserId, propBusinessId]);

  const noBusiness = !userId || !businessId;

  const headerNote = useMemo(() => {
    if (backendUsed) return "Calculated using server model";
    if (result) return "Calculated using local model (mock)";
    return "";
  }, [backendUsed, result]);

  const handleSubmit = async (formData) => {
    setIsLoading(true);
    setError("");
    setBackendUsed(false);
    setResult(null);

    // 1) First try the backend engine
    try {
      const res = await fetch("/api/accounting/affordabilityCheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          businessId,
          ...formData, // { expenseName, amount, frequency, startDate, notes }
        }),
      });

      if (res.ok) {
        const json = await res.json();
        if (json?.result) {
          setResult(json.result);
          setBackendUsed(true);
          setIsLoading(false);
          return;
        }
      }
      // If backend returns non-OK or no result, fall through to local calc
    } catch (e) {
      // ignore and fall back
    }

    // 2) Local fallback (uses forecast endpoint or mock)
    try {
      const horizon = await fetchForecast({ userId, businessId, months: 12 });
      const local = localAffordability({
        forecastRows: horizon,
        amount: formData.amount,
        frequency: formData.frequency,
        startDate: formData.startDate,
      });
      setResult({
        ...local,
        engine: "fallback",
        expenseName: formData.expenseName,
        amount: Number(formData.amount) || 0,
        frequency: formData.frequency,
        startDate: formData.startDate,
        notes: formData.notes || "",
      });
    } catch (e) {
      setError("Could not evaluate affordability. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="p-6 text-white space-y-8">
      {/* Header */}
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">Affordability Check</h1>
        <p className="text-white/70 text-sm">
          Thinking about a new hire or big purchase? Use this tool to see if your business can afford it
          based on projected cash flow.
        </p>

        <div className="flex flex-wrap gap-2">
          <Link
            to="/dashboard/accounting/forecasts"
            className="inline-flex items-center gap-1 rounded-xl border border-white/10 px-3 py-1.5 text-sm hover:bg-white/5"
          >
            View Forecasts <ArrowRight size={14} />
          </Link>
          <Link
            to="/dashboard/accounting/scenarios"
            className="inline-flex items-center gap-1 rounded-xl border border-white/10 px-3 py-1.5 text-sm hover:bg-white/5"
          >
            Model Scenarios <ArrowRight size={14} />
          </Link>
        </div>
      </header>

      {/* Business guard */}
      {noBusiness && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-amber-200 text-sm flex items-center gap-2">
          <ShieldAlert size={16} />
          Select a business (top-right) to run an affordability check.
        </div>
      )}

      {/* Form */}
      <section className="bg-zinc-900 border border-white/10 rounded-xl p-6">
        <h2 className="text-xl font-semibold mb-1">💵 Can I afford this?</h2>
        <p className="text-sm text-white/60 mb-4">
          Enter the expense details and Bizzy will assess affordability using your forecast.
        </p>

        <AffordabilityInputForm onSubmit={handleSubmit} isLoading={isLoading || noBusiness} disabled={noBusiness} />
        {isLoading && (
          <div className="mt-4 flex items-center text-white/70 text-sm">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Evaluating affordability…
          </div>
        )}
        {error && <div className="mt-3 text-sm text-rose-300">{error}</div>}
      </section>

      {/* Insight result */}
      {result && (
        <section className="bg-zinc-900 border border-white/10 rounded-xl p-6">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-lg font-semibold">🧠 Bizzy’s Assessment</h3>
          </div>

          <AffordabilityInsightCard
            result={result}
            metaLabel={headerNote || undefined}
          />
        </section>
      )}

      {/* Disclaimer */}
      <p className="text-xs text-white/40">
        This tool provides guidance based on forecasted cash flow and assumptions. It’s not financial or legal advice.
      </p>
    </div>
  );
}
