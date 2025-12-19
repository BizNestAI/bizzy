// File: /src/pages/Investments/RetirementSimulatorPage.jsx
import React, { useMemo, useEffect } from "react";
import { Bot, ArrowUpRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useRightExtras } from "../../insights/RightExtrasContext";
import AgendaWidget from "../calendar/AgendaWidget.jsx";

import RetirementSimulator from "../../components/Investments/RetirementSimulator";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";

const HERO_GLOW = "radial-gradient(circle at 10% -20%, rgba(192,132,252,0.28), transparent 55%)";
const HERO_GRADIENT = "linear-gradient(145deg, rgba(19,21,29,0.96), rgba(11,12,18,0.92))";
const HERO_BORDER = "rgba(192,132,252,0.25)";

export default function RetirementSimulatorPage({
  data = {},
  onAskBizzy = () => {},
}) {
  const navigate = useNavigate();
  const { setRightExtras } = useRightExtras();

  const businessId = useMemo(
    () => data?.businessId || localStorage.getItem("currentBusinessId") || "",
    [data?.businessId]
  );
  const userId = useMemo(
    () => data?.user?.id || localStorage.getItem("user_id") || "",
    [data?.user?.id]
  );
  if (!shouldUseDemoData()) {
    return <LiveModePlaceholder title="Connect investment accounts to run retirement projections" />;
  }

  // Right sidebar: Agenda
  useEffect(() => {
    if (!businessId) return;
    setRightExtras(
      <AgendaWidget
        businessId={businessId}
        module="investments"
        onOpenCalendar={() => navigate("/dashboard/calendar")}
      />
    );
    return () => setRightExtras(null);
  }, [businessId, navigate, setRightExtras]);

  return (
    <div className="relative w-full min-h-screen bg-app text-white overflow-hidden">
      <div className="pointer-events-none absolute inset-0 opacity-70" style={{ background: HERO_GLOW }} />

      <div className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 lg:px-10 py-6 pb-24 space-y-5">
        {/* Header */}
        <header
          className="rounded-[26px] border px-5 sm:px-7 py-5 shadow-[0_18px_55px_rgba(0,0,0,0.55)]"
          style={{ background: HERO_GRADIENT, borderColor: HERO_BORDER }}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.35em] text-white/60">
                <span>Investments · Retirement</span>
              </div>
              <h1 className="mt-2 text-[28px] sm:text-[32px] font-semibold tracking-tight">
                Retirement Simulator
              </h1>
              <p className="mt-1.5 text-[13px] sm:text-sm text-white/70 max-w-2xl">
                Model your retirement trajectory, test scenarios, and turn insights into a plan Bizzi can action.
              </p>
            </div>

    
          </div>
        </header>

        <RetirementSimulator userId={userId || undefined} onAskBizzy={onAskBizzy} className="mt-1" />
      </div>
    </div>
  );
}
