// /src/pages/Bizzy/BizzyPanel.jsx
import React, { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useBusiness } from "../../context/BusinessContext";
import { useRightExtras } from "../../insights/RightExtrasContext";
import AgendaWidget from "../../pages/Calendar/AgendaWidget.jsx";

import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader.jsx";
import BizzyPulse from "../../components/Bizzy/BizzyPulse.jsx";
import BizzyAlerts from "../../components/Bizzy/BizzyAlerts.jsx";
import { getDemoData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";
import useIntegrationManager from "../../hooks/useIntegrationManager.js";

export default function BizzyPanel() {
  const { user } = useAuth();
  const { currentBusiness } = useBusiness?.() || {};
  const navigate = useNavigate();
  const { setRightExtras } = useRightExtras();

  const businessId = localStorage.getItem("currentBusinessId") || "";
  const userId = user?.id || localStorage.getItem("user_id") || "";
  const usingDemo = shouldUseDemoData(currentBusiness);
  const integrationManager = useIntegrationManager({ businessId });
  const qbStatus = integrationManager?.getStatus?.("quickbooks")?.status || "disconnected";
  const allowLive = qbStatus === "connected";
  const demoData = useMemo(() => (usingDemo ? getDemoData() : null), [usingDemo]);
  if (!usingDemo && !allowLive) {
    return <LiveModePlaceholder title="Connect your tools to unlock Bizzi Pulse" />;
  }

  const heroInsight = useMemo(() => {
    if (!usingDemo) return null;
    return {
      id: "demo-pulse-hero",
      title: "Finish QuickBooks setup to unlock live KPIs",
      summary: "Connect QuickBooks and Plaid so Bizzi can replace mock cards with your revenue, expenses, and cashflow.",
      metric: "Finish setup",
      severity: "warn",
    };
  }, [usingDemo]);

  /** Prevent identity loops and “loading layout…” stalls from the right-rail injection */
  const didSetFor = useRef(null);
  useEffect(() => {
    try {
      if (!setRightExtras) return;
      if (didSetFor.current === businessId) return;
      didSetFor.current = businessId;

      setRightExtras(
        <AgendaWidget
          businessId={businessId}
          module="bizzy"
          onOpenCalendar={() => navigate("/dashboard/calendar")}
        />
      );
      return () => setRightExtras?.(null);
    } catch (e) {
      // Don’t let the dashboard crash if the provider isn’t ready.
      console.warn("[BizzyPanel] RightExtras injection skipped:", e);
      return () => {};
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, navigate]);

  return (
    <div className="w-full px-4 pt-2 pb-4">
      {/* Calm, minimal header for Pulse */}
      <ModuleHeader
        module="bizzy"
        hero={heroInsight}
        heroVariant="minimal"
      />

      <div className="grid gap-6 mt-2">
        <section className="space-y-4" aria-label="Pulse overview">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <BizzyPulse businessId={businessId} demoPulse={demoData?.pulse} />
            <BizzyAlerts businessId={businessId} demoAlerts={demoData?.pulse?.alerts} />
          </div>
        </section>
      </div>
    </div>
  );
}
