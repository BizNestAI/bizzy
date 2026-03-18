// File: /src/pages/accounting/Forecasts.jsx

import React, { useEffect, useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import ForecastEditorChart from "../../components/Accounting/ForecastEditorChart";
import ForecastVsActualChart from "../../components/Accounting/ForecastVsActualChart";
import { LifeBuoy, ChevronDown } from "lucide-react";
import { Listbox } from "@headlessui/react";
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
        <div className="relative min-w-[130px]">
          <Listbox.Button
            className="w-full rounded-xl border border-white/12 bg-[rgba(13,15,20,0.92)] px-3 py-1.5 text-sm text-white/90 shadow-[0_10px_30px_rgba(0,0,0,0.45)] focus:outline-none focus:ring-2 focus:ring-emerald-400/35 flex items-center justify-between gap-2"
          >
            <span className="truncate">{current?.label}</span>
            <ChevronDown size={16} className="text-white/70 shrink-0" />
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

  return (
    canView ? (
    <div className="px-3 md:px-4 pt-0 pb-8 text-white space-y-6">
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
          <DarkListbox
            value={editorMonths}
            onChange={(v) => setEditorMonths(Number(v))}
            options={horizonOptions}
          />
        </div>
        <div className="inline-flex items-center gap-2">
          <span className="text-white/70">Compare window</span>
          <DarkListbox
            value={compareMonths}
            onChange={(v) => setCompareMonths(Number(v))}
            options={compareOptions}
          />
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
