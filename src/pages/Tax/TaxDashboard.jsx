// File: /components/Tax/TaxDashboard.jsx
import React, { useEffect, useState } from "react";
import { RefreshCw, AlertTriangle } from "lucide-react";

import TaxLiabilityPanel from "../../components/Tax/TaxLiabilityPanel";
import TaxLiabilityChart from "../../components/Tax/TaxLiabilityChart";
import TaxSnapshotMini from "../../components/Tax/TaxSnapshotMini";
import TaxMonthlySnapshot from "../../components/Tax/TaxMonthlySnapshot";
import TaxSuggestions from "../../components/Tax/TaxSuggestions";

import { useBusinessContext } from "../../context/BusinessContext";
import { useNavigate } from "react-router-dom";
import { useTaxLiability } from "../../hooks/useTaxLiability";
import useIntegrationManager from "../../hooks/useIntegrationManager.js";

import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader";
import SyncButton from "../../components/Integrations/SyncButton.jsx";
// import { getHeroInsight } from "../../services/heroInsights/getHeroInsight";

import { useRightExtras } from "../../insights/RightExtrasContext";
import AgendaWidget from "../../pages/calendar/AgendaWidget.jsx";
import { useLocation } from "react-router-dom";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";

/* ---------- theme tokens (muted gold + neutral glass) ---------- */
const GOLD = "#E3C25C";                     // softer than pure #FFD700
const PANEL_BG = "var(--panel)";
const RING_NEUTRAL = "rgba(255,255,255,0.10)";
const RING_GOLD = "rgba(227,194,92,0.22)";
const SHADOW_SOFT = "0 14px 36px rgba(0,0,0,.28)";

/** ⛑️ TEMP client mock to verify UI. Remove once /api/hero-insights/tax is live. */
const TEMP_DEBUG_MOCK_HIGHLIGHT = {
  id: "debug-tax-hero",
  title: "Quarterly estimate due Oct 15",
  summary: "Paying early could avoid penalties and improve cash planning.",
  metric: "Oct 15",
  severity: "warn",
  dismissible: true,
};

export default function TaxDashboard({ onAskBizzy }) {
  const { currentBusiness } = (useBusinessContext?.() || {});
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId");
  const navigate = useCallbackSafeNavigate(useNavigate());
  const location = useLocation();
  const usingDemo = shouldUseDemoData(currentBusiness);
  const integrationManager = useIntegrationManager({ businessId });
  const qbStatus = integrationManager?.getStatus?.("quickbooks")?.status || "disconnected";
  const allowLive = qbStatus === "connected";

  if (!usingDemo && !allowLive) {
    return <LiveModePlaceholder title="Connect your tax + accounting data to view the Tax Desk" />;
  }

  // Right rail agenda
  const { setRightExtras } = useRightExtras();
  useEffect(() => {
    if (!businessId) return;
    setRightExtras(
      <AgendaWidget
        businessId={businessId}
        module="tax"
        onOpenCalendar={() => navigate("/dashboard/calendar")}
      />
    );
    return () => setRightExtras(null);
  }, [businessId, navigate, setRightExtras]);

  // Shared liability
  const {
    data: liab,
    loading: chartLoading,
    error: chartError,
    refetch: refetchLiab,
  } = useTaxLiability(businessId);

  // Module header “hero” insight (safe if not imported)
  const [hero, setHero] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      let res = null;
      try {
        // safe: typeof on an undeclared identifier won't throw in JS
        if (typeof getHeroInsight === "function") {
          res = await getHeroInsight("tax", { force: true, timeout: 6000 });
        }
      } catch {}
      if (!alive) return;
      setHero(res?.hero ?? TEMP_DEBUG_MOCK_HIGHLIGHT);
    })();
    return () => { alive = false; };
  }, [businessId]);

  const sourceBadge =
    liab?.meta?.source === "mock"
      ? "text-[10px] px-2 py-0.5 rounded-full ring-1 ring-inset ring-[rgba(227,194,92,.28)] text-[rgba(227,194,92,.9)] bg-[rgba(227,194,92,.08)]"
      : "text-[10px] px-2 py-0.5 rounded-full ring-1 ring-inset ring-[rgba(16,185,129,.28)] text-[rgba(16,185,129,.9)] bg-[rgba(16,185,129,.08)]";

  const TOP_CARD_HEIGHT = 200;

  return (
     <div key={location.pathname} className="min-h-screen w-full bg-app text-primary">
      {/* Header */}
      <ModuleHeader
        module="tax"
        title="Tax Desk"
        hero={hero}
        onDismissHero={() => setHero(null)}
        className="max-w-[1200px] mx-auto px-4 pt-0 pb-2"
        right={<SyncButton label="Sync QuickBooks" providers={["quickbooks"]} />}
      />

      {/* Main layout */}
      <main className="relative z-0 max-w-[1200px] mx-auto px-4 pt-2 pb-6 grid grid-cols-12 gap-5">
  

<section className="col-span-12 grid grid-cols-12 gap-5 items-start">
  {/* Chart — narrower (lg:6). Header now rendered inside TaxLiabilityChart */}
  <Frame variant="gold-dark" elev="flat" className="col-span-12 lg:col-span-6">
    {chartError ? (
      <div className="text-xs text-rose-300 inline-flex items-center gap-2 mb-2">
        <AlertTriangle className="h-3.5 w-3.5" /> {chartError}
      </div>
    ) : null}

    <TaxLiabilityChart
      data={liab?.trend || []}
      overlay={liab?.cashFlowOverlay || []}
      quarters={liab?.quarterly || []}
      height={TOP_CARD_HEIGHT}
      title="TAX LIABILITY TREND"
      source={liab?.meta?.source === "mock" ? "mock" : "live"}
      loading={chartLoading}
      onRefresh={refetchLiab}
    />
  </Frame>

  {/* Mini snapshot — wider (lg:6) and same height */}
  <Frame variant="gold-dark" elev="flat" className="col-span-12 lg:col-span-6">
    <TaxSnapshotMini
      businessId={businessId}
      onAskBizzy={(text, payload) => onAskBizzy?.(text, payload)}
      onOpen={() => {
        document.getElementById("full-snapshot")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }}
      height={TOP_CARD_HEIGHT}
    />
  </Frame>
</section>


        {/* SECOND ROW: Suggestions */}
        <section className="col-span-12">
          <Frame variant="gold-dark">
            <TaxSuggestions
              businessId={businessId}
              onAskBizzy={(text, payload) => onAskBizzy?.(text, payload)}
            />
          </Frame>
        </section>

        {/* THIRD ROW: Full liability panel */}
        <section className="col-span-12">
          {businessId ? (
            <Frame variant="gold-dark" padded={false} borderless>
              <TaxLiabilityPanel
                businessId={businessId}
                prefetched={liab}
                onRefetch={refetchLiab}
                onAskBizzy={(payload) =>
                  onAskBizzy?.("How can I reduce this liability?", payload)
                }
              />
            </Frame>
          ) : (
            <div className="rounded-xl p-4 text-sm ring-1 ring-inset" style={{ background: PANEL_BG, borderColor: RING_NEUTRAL }}>
              Select or create a business to view tax liability.
            </div>
          )}
        </section>

        {/* FULL Monthly Snapshot */}
        <section className="col-span-12" id="full-snapshot">
          <Frame variant="gold-dark">
            <TaxMonthlySnapshot
              businessId={businessId}
              onAskBizzy={(text, payload) => onAskBizzy?.(text, payload)}
              onOpenDeductions={() => {}}
            />
          </Frame>
        </section>
      </main>
    </div>
  );
}

/* ------------------------ Frameless Glass Card ------------------------ */
// replace your Frame with this version
function Frame({
  children,
  className = "",
  padded = true,
  variant = "gold-dark",
  elev = "flat", // "flat" | "glass"
  borderless = false,
}) {
  const ringColor = variant === "gold-dark" ? RING_GOLD : RING_NEUTRAL;
  const isGlass = elev === "glass";

  return (
    <div className={`relative z-0 ${className}`}>
      {/* optional halo only for glass */}
      {isGlass ? (
        <div
          aria-hidden
          className="absolute -inset-0.5 rounded-2xl pointer-events-none -z-10"
          style={{
            background:
              variant === "gold-dark"
                ? "linear-gradient(135deg, rgba(227,194,92,.22), rgba(255,255,255,.05) 40%, rgba(0,0,0,0) 70%)"
                : "linear-gradient(135deg, rgba(255,255,255,.14), rgba(255,255,255,.04) 60%)",
            filter: "blur(6px)",
            opacity: 0.6,
          }}
        />
      ) : null}

      <div
        className={[
          "relative z-0 rounded-2xl overflow-hidden",
          padded ? "p-4 md:p-5" : "",
          isGlass ? "bg-white/[0.05] backdrop-blur-md" : "bg-[#0f1012]", // flatter
          borderless ? "" : "border",
          isGlass ? "shadow-[0_14px_36px_rgba(0,0,0,.25)]" : "shadow-[0_10px_24px_rgba(0,0,0,.22)]",
        ].join(" ")}
        style={{ borderColor: borderless ? "transparent" : ringColor }}
      >
        {/* inner highlight only for glass */}
        {isGlass ? (
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 h-10 pointer-events-none -z-10"
            style={{ background: "linear-gradient(180deg, rgba(255,255,255,.06), transparent)" }}
          />
        ) : null}

        {/* super subtle inner stroke for crisp edge (works for both) */}
        <div className="absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/[0.04] pointer-events-none -z-10" />
        {children}
      </div>
    </div>
  );
}



function Skeleton({ className = "" }) {
  return (
    <div
      className={`animate-pulse rounded-md ring-1 ring-inset ring-white/10 bg-white/5 ${className}`}
    />
  );
}

/* ------------------------ utils ------------------------ */
function useCallbackSafeNavigate(nav) {
  return (to) => {
    try { nav(to); } catch (_) {}
  };
}
