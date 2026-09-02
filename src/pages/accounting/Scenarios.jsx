// File: /src/pages/accounting/Scenarios.jsx
import React, { useEffect, useState } from "react";
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Loader2, ShieldAlert, RefreshCw } from "lucide-react";
import ScenarioModeler from "../../components/Accounting/ScenarioModeler.jsx";
import AgendaWidget from '../Calendar/AgendaWidget.jsx';
import { useRightExtras } from '../../insights/RightExtrasContext';
import { shouldUseDemoData } from "../../services/demo/demoClient.js";

/* ---------------------------- helpers ---------------------------- */
const MOCK_BASELINE = Array.from({ length: 12 }, (_, i) => {
  const d = new Date(); d.setMonth(d.getMonth() + i, 1);
  const label = d.toLocaleString("default", { month: "short", year: "numeric" });
  const net = 12000 - i * 500;
  return { month_label: label, net_cash: net, ending_cash: 30000 + (i + 1) * net };
});

async function fetchBaselineForecast({ userId, businessId, months = 12, isDemo = false }) {
  if (isDemo) {
    return { rows: MOCK_BASELINE, status: "available", isSample: true, message: "Using sample scenario baseline." };
  }
  const params = new URLSearchParams({
    businessId,
    months: String(months),
  });
  if (userId) params.set("userId", userId);
  const url = `/api/accounting/forecast?${params.toString()}`;
  const res = await fetch(url, { cache: "no-store" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  const rows = Array.isArray(json?.forecast?.months)
    ? json.forecast.months
    : (Array.isArray(json?.forecast_rows) ? json.forecast_rows : []);
  return {
    rows: json?.data_status === "available" ? rows : [],
    status: json?.data_status || "generation_failed",
    isSample: json?.is_sample === true,
    message: forecastStatusMessage(json),
  };
}

function forecastStatusMessage(payload) {
  if (payload?.data_status === "generation_required") return "Generate an operating forecast before modeling scenarios.";
  if (payload?.data_status === "generation_in_progress") return "Bizzi is generating the operating forecast.";
  if (payload?.data_status === "insufficient_history") return "Scenario modeling needs 12 contiguous Cash-basis QuickBooks months.";
  if (payload?.data_status === "qbo_disconnected") return "Connect QuickBooks to use Live Mode scenario modeling.";
  if (payload?.data_status === "generation_failed") return "Live forecast generation failed. No sample baseline is used in Live Mode.";
  return "No live operating forecast is available yet.";
}

/* ------------------------------ page ------------------------------ */

export default function Scenarios({ businessId: propBusinessId, userId: propUserId }) {
  const [userId, setUserId] = useState(propUserId || null);
  const [businessId, setBusinessId] = useState(propBusinessId || null);

  const [baseline, setBaseline] = useState([]);
  const [baselineStatus, setBaselineStatus] = useState("loading");
  const [baselineMessage, setBaselineMessage] = useState("");
  const [baselineIsSample, setBaselineIsSample] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingNote, setLoadingNote] = useState("");
  const [error, setError] = useState("");
  const { setRightExtras } = useRightExtras();
  const navigate = useNavigate();

  // Resolve ids from localStorage if wrapper didn't pass them
  useEffect(() => {
    if (!propUserId) setUserId(localStorage.getItem("user_id") || null);
    if (!propBusinessId) {
      const id = localStorage.getItem("currentBusinessId");
      if (id && id !== "null" && id !== "undefined") setBusinessId(id);
    }
  }, [propUserId, propBusinessId]);

  useEffect(() => {
      if (!businessId) return;
  
      const el = (
        <AgendaWidget
          businessId={businessId}
          module="financials"
          onOpenCalendar={() => navigate('/dashboard/calendar')}
        />
      );
  
      setRightExtras(el);
      return () => setRightExtras(null); // cleanup when leaving page
    }, [businessId, navigate, setRightExtras]);

  const isDemo = shouldUseDemoData();
  const noBusiness = !businessId && !isDemo;

  // Load baseline forecast
  const loadBaseline = async () => {
    if (noBusiness) {
      setBaseline([]);
      setBaselineStatus("missing_context");
      setBaselineMessage("");
      setBaselineIsSample(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    setLoadingNote("Loading baseline forecast…");
    try {
      const result = await fetchBaselineForecast({ userId, businessId, months: 12, isDemo });
      setBaseline(result.rows);
      setBaselineStatus(result.status);
      setBaselineMessage(result.message || "");
      setBaselineIsSample(result.isSample);
    } catch (err) {
      setError(err?.message || "Could not load baseline forecast.");
      setBaseline([]);
      setBaselineStatus("generation_failed");
      setBaselineMessage("Live forecast unavailable. No sample baseline is used in Live Mode.");
      setBaselineIsSample(false);
    } finally {
      setLoading(false);
      setLoadingNote("");
    }
  };

  useEffect(() => {
    if (!noBusiness) loadBaseline();
  }, [noBusiness, userId, businessId, isDemo]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-8 p-6 text-white">
      {/* Header */}
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">Scenario Modeling</h1>
        <p className="text-sm text-white/70">
          Create “what-if” plans (price changes, hires, investments) and compare them to your baseline forecast.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/dashboard/accounting/forecasts"
            className="inline-flex items-center gap-1 rounded-xl border border-white/10 px-3 py-1.5 text-sm hover:bg-white/5"
          >
            View Forecasts <ArrowRight size={14} />
          </Link>
          <Link
            to="/dashboard/accounting/affordability"
            className="inline-flex items-center gap-1 rounded-xl border border-white/10 px-3 py-1.5 text-sm hover:bg-white/5"
          >
            Can I afford this? <ArrowRight size={14} />
          </Link>

          <button
            onClick={loadBaseline}
            disabled={noBusiness || loading}
            className="inline-flex items-center gap-1 rounded-xl border border-white/10 px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-50"
            title="Refresh baseline"
          >
            <RefreshCw size={14} /> Refresh baseline
          </button>
        </div>
      </header>

      {/* Business guard */}
      {noBusiness && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          <ShieldAlert size={16} />
          Select a business (top-right) to model scenarios.
        </div>
      )}

      {/* Baseline loader / error */}
      {!noBusiness && loading && (
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-white/70">
          <Loader2 className="h-4 w-4 animate-spin" />
          {loadingNote || "Loading…"}
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-rose-300/30 bg-rose-500/10 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}
      {!noBusiness && !loading && !baseline.length && (baselineMessage || baselineStatus !== "available") && (
        <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-white/70">
          {baselineMessage || "No live operating forecast is available yet."}
        </div>
      )}
      {baselineIsSample && (
        <div className="rounded-xl border border-amber-300/25 bg-amber-500/10 p-3 text-sm text-amber-100">
          Mock Mode sample scenario baseline.
        </div>
      )}

      {/* Modeler (includes the comparison chart internally) */}
      {!noBusiness && !loading && baseline.length > 0 && (
        <ScenarioModeler
          baselineForecast={baseline}
          userId={userId}
          businessId={businessId}
        />
      )}

    </div>
  );
}
