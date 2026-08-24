// File: /src/pages/accounting/Forecasts.jsx

import React, { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import ForecastEditorChart from "../../components/Accounting/ForecastEditorChart";
import ForecastVsActualChart from "../../components/Accounting/ForecastVsActualChart";
import { ChevronDown } from "lucide-react";
import { Listbox } from "@headlessui/react";
import { useBusiness } from "../../context/BusinessContext";
import { useAuth } from "../../context/AuthContext.jsx";
import { useAdminView } from "../../context/AdminViewContext.jsx";
import AgendaWidget from "../Calendar/AgendaWidget.jsx";
import { useRightExtras } from "../../insights/RightExtrasContext";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader.jsx";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";
import useIntegrationManager from "../../hooks/useIntegrationManager.js";
import useDemoMode from "../../hooks/useDemoMode.js";

export default function Forecasts() {
  const { businessId: contextBusinessId, currentBusiness } = useBusiness();
  const { user } = useAuth() || {};
  const adminView = useAdminView();
  const [storedUserId, setStoredUserId] = useState(null);
  const [storedBusinessId, setStoredBusinessId] = useState(null);
  const userId = adminView.active ? "admin_view" : (user?.id || storedUserId);
  const businessId = adminView.active ? adminView.businessId : (currentBusiness?.id || contextBusinessId || storedBusinessId);
  const integrationManager = useIntegrationManager({ businessId });
  const qbStatus = integrationManager?.getStatus?.("quickbooks")?.status || (adminView.active ? "loading" : "disconnected");
  const qbStatusLoading = adminView.active && ["loading", "connecting"].includes(qbStatus);

  // Page controls
  const [editorMonths, setEditorMonths] = useState(12);  // horizon for forecast editor
  const [compareMonths, setCompareMonths] = useState(6); // window for vs-actual chart
  const demoMode = useDemoMode();

  // ✅ right-rail publisher + router
  const { setRightExtras } = useRightExtras();
  const navigate = useNavigate();

  useEffect(() => {
    setStoredUserId(localStorage.getItem("user_id") || null);
    const id = localStorage.getItem("currentBusinessId") || localStorage.getItem("business_id");
    if (id && id !== "null" && id !== "undefined") setStoredBusinessId(id);
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

  const usingDemo = useMemo(() => shouldUseDemoData(currentBusiness), [currentBusiness, demoMode]);
  const canView = usingDemo || qbStatus === "connected";
  const horizonOptions = useMemo(
    () => [
      { value: 6, label: "6 months" },
      { value: 9, label: "9 months" },
      { value: 12, label: "12 months" },
    ],
    []
  );
  const compareOptions = useMemo(
    () => [
      { value: 3, label: "3 months" },
      { value: 6, label: "6 months" },
      { value: 12, label: "12 months" },
    ],
    []
  );

  const DarkListbox = ({ value, onChange, options }) => {
    const current = options.find((o) => o.value === value) || options[0];
    return (
      <Listbox value={current} onChange={(opt) => onChange(opt.value)}>
        <div className="relative min-w-[112px]">
          <Listbox.Button
            className="flex w-full items-center justify-between gap-2 rounded-full border border-white/10 bg-black/24 px-2.5 py-1 text-xs font-semibold text-white/82 shadow-[0_10px_24px_rgba(0,0,0,0.28)] transition hover:border-white/18 hover:bg-white/[0.055] focus:outline-none focus:ring-2 focus:ring-emerald-400/35"
          >
            <span className="truncate">{current?.label}</span>
            <ChevronDown size={14} className="text-white/60 shrink-0" />
          </Listbox.Button>
          <Listbox.Options className="absolute z-30 mt-1 w-full rounded-xl border border-white/10 bg-[rgba(10,12,16,0.96)] backdrop-blur-sm shadow-[0_18px_40px_rgba(0,0,0,0.55)] overflow-hidden">
            {options.map((opt) => (
              <Listbox.Option
                key={opt.value}
                value={opt}
                className={({ active, selected }) =>
                  [
                    "px-3 py-2 text-sm cursor-pointer",
                    active ? "bg-white/8 text-white" : "text-white/85",
                    selected ? "bg-[rgba(var(--accent-rgb),0.12)] text-white" : "",
                  ].join(" ")
                }
              >
                {opt.label}
              </Listbox.Option>
            ))}
          </Listbox.Options>
        </div>
      </Listbox>
    );
  };

  const forecastControls = (
    <div className="flex flex-wrap items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.035] px-2 py-1 shadow-[0_12px_28px_rgba(0,0,0,0.22)]">
      <span className="pl-1 text-[11px] font-semibold text-white/48">Horizon</span>
      <DarkListbox
        value={editorMonths}
        onChange={(v) => setEditorMonths(Number(v))}
        options={horizonOptions}
      />
      <span className="hidden h-4 w-px bg-white/10 sm:inline-block" />
      <span className="text-[11px] font-semibold text-white/48">Compare</span>
      <DarkListbox
        value={compareMonths}
        onChange={(v) => setCompareMonths(Number(v))}
        options={compareOptions}
      />
    </div>
  );

  return (
    qbStatusLoading ? (
      <div className="px-3 md:px-4 pt-0 pb-8 text-white space-y-5">
        <ModuleHeader
          module="financials"
          title="Cash Flow Forecasts"
          subtitle="Loading QuickBooks connection state for Admin View."
          className="mb-2"
        />
        <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-sm text-white/55">
          Loading persisted customer forecast state...
        </div>
      </div>
    ) : canView ? (
    <div className="px-3 md:px-4 pt-0 pb-8 text-white space-y-5">
      <ModuleHeader
        module="financials"
        title="Cash Flow Forecasts"
        subtitle="Bizzi studies your historical cash pulses, then projects the next 12 months so you can edit confidently."
        className="mb-2"
      />

      <section>
        <ForecastEditorChart
          userId={userId}
          businessId={businessId}
          months={editorMonths}
          useDemoData={usingDemo}
          readOnly={adminView.active && adminView.readOnly}
          controls={forecastControls}
        />
      </section>

      <section>
        <ForecastVsActualChart
          userId={userId}
          businessId={businessId}
          months={compareMonths}
          useDemoData={usingDemo}
          readOnly={adminView.active && adminView.readOnly}
        />
      </section>
    </div>
    ) : (
      <LiveModePlaceholder title="Connect QuickBooks to manage forecasts" />
    )
  );
}
