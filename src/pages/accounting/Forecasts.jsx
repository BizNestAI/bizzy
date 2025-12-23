// File: /src/pages/accounting/Forecasts.jsx

import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import ForecastEditorChart from "../../components/Accounting/ForecastEditorChart";
import ForecastVsActualChart from "../../components/Accounting/ForecastVsActualChart";
import { LifeBuoy } from "lucide-react";
import { useBusiness } from "../../context/BusinessContext";
import AgendaWidget from "../Calendar/AgendaWidget.jsx";
import { useRightExtras } from "../../insights/RightExtrasContext";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader.jsx";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";
import useIntegrationManager from "../../hooks/useIntegrationManager.js";

export default function Forecasts() {
  const { currentBusiness } = useBusiness();
  const [userId, setUserId] = useState(null);
  const [businessId, setBusinessId] = useState(null);
  const integrationManager = useIntegrationManager({ businessId });
  const qbStatus = integrationManager?.getStatus?.("quickbooks")?.status || "disconnected";

  // Page controls
  const [editorMonths, setEditorMonths] = useState(12);  // horizon for forecast editor
  const [compareMonths, setCompareMonths] = useState(6); // window for vs-actual chart

  // ✅ right-rail publisher + router
  const { setRightExtras } = useRightExtras();
  const navigate = useNavigate();

  useEffect(() => {
    setUserId(localStorage.getItem("user_id") || null);
    const id = localStorage.getItem("currentBusinessId");
    if (id && id !== "null" && id !== "undefined") setBusinessId(id);
  }, []);

  // ✅ Publish AgendaWidget to the InsightsRail (like AccountingDashboard.jsx)
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
  const usingDemo = shouldUseDemoData(currentBusiness);
  const canView = usingDemo || qbStatus === "connected";
  const selectStyles =
    "rounded-xl border border-[var(--accent-line)] bg-[var(--panel)] px-3 py-1.5 text-sm text-white/80 focus:outline-none focus:ring-2 focus:ring-emerald-400/40 shadow-[0_8px_24px_rgba(0,0,0,0.35)]";

  return (
    canView ? (
    <div className="p-5 text-white space-y-6">
      <ModuleHeader
        module="financials"
        title="Cash Flow Forecasts"
        subtitle="Bizzi studies your historical cash pulses, then projects the next 12 months so you can edit confidently."
        className="mb-2"
      />

      {/* Small banner if no business selected */}
      {noBusiness && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-amber-200 text-sm">
          Select a business to view and edit forecasts. You can switch businesses from the top-right selector.
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--accent-line)] bg-[var(--panel)] px-4 py-3 text-sm shadow-[0_16px_36px_rgba(0,0,0,0.35)]">
        <div className="inline-flex items-center gap-2">
          <span className="text-white/70">Editor horizon</span>
          <select value={editorMonths} onChange={(e) => setEditorMonths(Number(e.target.value))} className={selectStyles}>
            <option value={6}>6 months</option>
            <option value={9}>9 months</option>
            <option value={12}>12 months</option>
          </select>
        </div>
        <div className="inline-flex items-center gap-2">
          <span className="text-white/70">Compare window</span>
          <select value={compareMonths} onChange={(e) => setCompareMonths(Number(e.target.value))} className={selectStyles}>
            <option value={3}>3 months</option>
            <option value={6}>6 months</option>
            <option value={12}>12 months</option>
          </select>
        </div>
        <div className="inline-flex items-center gap-2 text-white/60">
          <LifeBuoy size={16} />
          Need help forecasting? <Link to="/dashboard/bizzy" className="text-white hover:underline">Ask Bizzi</Link>
        </div>
      </div>

      <section className="rounded-2xl border border-[var(--accent-line)] bg-[var(--panel)] px-4 py-3 shadow-[0_18px_40px_rgba(0,0,0,0.4)]">
        <ForecastEditorChart userId={userId} businessId={businessId} months={editorMonths} />
      </section>

      <section className="rounded-2xl border border-[var(--accent-line)] bg-[var(--panel)] px-4 py-3 shadow-[0_18px_40px_rgba(0,0,0,0.4)]">
        <ForecastVsActualChart userId={userId} businessId={businessId} months={compareMonths} />
      </section>
    </div>
    ) : (
      <LiveModePlaceholder title="Connect QuickBooks to manage forecasts" />
    )
  );
}
