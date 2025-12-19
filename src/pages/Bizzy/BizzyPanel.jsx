// /src/pages/Bizzy/BizzyPanel.jsx
import React, { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useBusiness } from "../../context/BusinessContext";
import { useRightExtras } from "../../insights/RightExtrasContext";
import AgendaWidget from "../../pages/calendar/AgendaWidget.jsx";

import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader.jsx";
import SyncButton from "../../components/Integrations/SyncButton.jsx";
import BizzySnapshot from "../../components/Bizzy/BizzySnapshot.jsx";
import BizzyPulse from "../../components/Bizzy/BizzyPulse.jsx";
import BizzyAlerts from "../../components/Bizzy/BizzyAlerts.jsx";
import KPIDashboardPanel from "../../components/Accounting/KPIDashboardPanel.jsx";
import RecentCashActivity from "../../components/Bizzy/RecentCashActivity.jsx";
import { getDemoData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";

const panelClass = "rounded-xl bg-app/60 backdrop-blur";
const pad = "px-4 py-4 sm:px-5 sm:py-5";

export default function BizzyPanel() {
  const { user } = useAuth();
  const { currentBusiness } = useBusiness?.() || {};
  const navigate = useNavigate();
  const { setRightExtras } = useRightExtras();

  const businessId = localStorage.getItem("currentBusinessId") || "";
  const userId = user?.id || localStorage.getItem("user_id") || "";
  const usingDemo = shouldUseDemoData(currentBusiness);
  const demoData = useMemo(() => (usingDemo ? getDemoData() : null), [usingDemo]);
  if (!usingDemo) {
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
      cta: { label: "Open Integrations", href: "/dashboard/settings?tab=Integrations" },
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

  const snapshotProps = useMemo(() => {
    if (!demoData) return {};
    const fin = demoData.financials || {};
    const marketingReachValue = demoData?.marketing?.summary?.total_reach;
    const tax = demoData.tax || {};
    const readiness =
      tax?.summary?.annualEstimate
        ? Math.max(
            0,
            Math.round(
              (1 - (tax.summary.balanceDue || 0) / tax.summary.annualEstimate) * 100
            )
          )
        : null;
    return {
      profitability: fin?.mtdProfit != null ? `$${Number(fin.mtdProfit).toLocaleString()}` : undefined,
      marketingReach: marketingReachValue != null ? marketingReachValue.toLocaleString() : undefined,
      taxReadiness: readiness != null ? `${readiness}%` : undefined,
    };
  }, [demoData]);

  const recentCash = useMemo(() => {
    if (demoData?.financials?.recentCash) return demoData.financials.recentCash;
    return [
      { id: "a1", label: "Invoice paid", amount: 1200 },
      { id: "a2", label: "Payment received", amount: 900 },
      { id: "a3", label: "Invoice paid", amount: 2400 },
      { id: "a4", label: "Payment received", amount: 1800 },
    ];
  }, [demoData]);

  return (
    <div className="w-full px-4 pt-2 pb-4">
      {/* Calm, minimal header for Pulse */}
      <ModuleHeader
        module="bizzy"
        hero={heroInsight}
        heroVariant="minimal"
        right={<SyncButton label="Sync Accounts" providers={["quickbooks", "jobber", "gmail"]} />}
      />

      <div className="grid gap-4 mt-2">
        {/* Snapshot + Pulse/Alerts */}
        <section className={`${panelClass} ${pad}`} aria-label="Snapshot">

          {/* Ensure BizzySnapshot is the lightweight stat tiles component (no imports of BizzyPanel) */}
          <BizzySnapshot
            profitability={snapshotProps.profitability}
            marketingReach={snapshotProps.marketingReach}
            taxReadiness={snapshotProps.taxReadiness}
          />

          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-lg border border-white/10 bg-black/20 p-3 sm:p-4">
              <BizzyPulse businessId={businessId} demoPulse={demoData?.pulse} />
            </div>
            <div className="rounded-lg border border-white/10 bg-black/20 p-3 sm:p-4">
              <BizzyAlerts businessId={businessId} demoAlerts={demoData?.pulse?.alerts} />
            </div>
          </div>
        </section>

        {/* KPIs */}
        <section className={`${panelClass} ${pad}`} aria-label="KPIs">
          <KPIDashboardPanel userId={userId} businessId={businessId} />
        </section>

        {/* Recent Cash Activity */}
        <section className={`${panelClass} ${pad}`} aria-label="Recent Cash Activity">
          <RecentCashActivity items={recentCash} currency="$" />
        </section>
      </div>
    </div>
  );
}
