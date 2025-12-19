// File: /src/pages/accounting/Scenarios.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Loader2, ShieldAlert, RefreshCw } from "lucide-react";
import ScenarioModeler from "../../components/Accounting/ScenarioModeler.jsx";
import AgendaWidget from '../calendar/AgendaWidget.jsx';
import { useRightExtras } from '../../insights/RightExtrasContext';

/* ---------------------------- helpers ---------------------------- */
const MOCK_BASELINE = Array.from({ length: 12 }, (_, i) => {
  const d = new Date(); d.setMonth(d.getMonth() + i, 1);
  const label = d.toLocaleString("default", { month: "short", year: "numeric" });
  const net = 12000 - i * 500;
  return { month_label: label, net_cash: net, ending_cash: 30000 + (i + 1) * net };
});

async function fetchBaselineForecast({ userId, businessId, months = 12 }) {
  const url = `/api/accounting/forecast?userId=${encodeURIComponent(
    userId
  )}&businessId=${encodeURIComponent(businessId)}&months=${months}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rows = Array.isArray(json.forecast) ? json.forecast : [];
    return rows.length ? rows : MOCK_BASELINE;
  } catch {
    return MOCK_BASELINE;
  }
}

/* ------------------------------ page ------------------------------ */

export default function Scenarios({ businessId: propBusinessId, userId: propUserId }) {
  const [userId, setUserId] = useState(propUserId || null);
  const [businessId, setBusinessId] = useState(propBusinessId || null);

  const [baseline, setBaseline] = useState([]);
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

  const noBusiness = !userId || !businessId;

  // Load baseline forecast
  const loadBaseline = async () => {
    if (noBusiness) {
      setBaseline([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    setLoadingNote("Loading baseline forecast…");
    try {
      const rows = await fetchBaselineForecast({ userId, businessId, months: 12 });
      setBaseline(rows);
    } catch (e) {
      setError("Could not load baseline forecast.");
      setBaseline(MOCK_BASELINE);
    } finally {
      setLoading(false);
      setLoadingNote("");
    }
  };

  useEffect(() => {
    if (!noBusiness) loadBaseline();
  }, [noBusiness, userId, businessId]);

  const isMock = useMemo(() => {
    // crude: if rows don't have business_id we assume mock; harmless flag
    return Array.isArray(baseline) && baseline.length && !("business_id" in (baseline[0] || {}));
  }, [baseline]);

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

      {/* Modeler (includes the comparison chart internally) */}
      {!noBusiness && !loading && (
        <ScenarioModeler
          baselineForecast={baseline}
          userId={userId}
          businessId={businessId}
        />
      )}

      {/* Footnote */}
      {isMock && !noBusiness && (
        <p className="text-xs text-amber-300">
          Using mock baseline — connect accounting to preview with live data.
        </p>
      )}
    </div>
  );
}
