// File: /src/pages/Investments/InvestmentsDashboard.jsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Bot } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useRightExtras } from "../../insights/RightExtrasContext";
import AgendaWidget from "../Calendar/AgendaWidget.jsx";

import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader";
import SyncButton from "../../components/Integrations/SyncButton.jsx";
import useIntegrationManager from "../../hooks/useIntegrationManager";
// import { getHeroInsight } from "../../services/heroInsights/getHeroInsight";

import AccountCards from "../../components/Investments/AccountCards";
import HoldingsTable from "../../components/Investments/HoldingsTable";
import WealthPulseCard from "../../components/Investments/WealthPulseCard";
import WealthMovesPanel from "../../components/Investments/WealthMovesPanel";

import {
  getBalances,
  getAssetAllocation,
  getPositions,
  syncBalances,
} from "../../services/investmentsApi";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";

/* ---------- Graphite + Investments accent ---------- */
const PURPLE = "#B388FF";
const PANEL_BG = "#0f1012";                         // flatter, like Financials
const NEUTRAL_BORDER = "rgba(165,167,169,0.18)";
const RING_PURPLE = "rgba(179,136,255,0.20)";       

function hexToRgba(hex, alpha = 1) {
  let c = (hex || "").replace("#", "");
  if (c.length === 3) c = c.split("").map(s => s + s).join("");
  const n = parseInt(c || "000000", 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
const ACCENT_BORDER = hexToRgba(PURPLE, 0.35);

/** ⛑️ TEMP mock; remove when /api/hero-insights/investments returns a hero */
const TEMP_DEBUG_MOCK_HERO = {
  id: "debug-inv-hero",
  title: "Portfolio up 5.4% this month",
  summary: "Growth driven by tech holdings.",
  metric: "+5.4%",
  severity: "good",
  dismissible: true,
};

export default function InvestmentsDashboard({
  data = {},
  onAskBizzy = () => {},
  onQuickPrompt = () => {},
}) {
  const navigate = useNavigate();
  const { setRightExtras } = useRightExtras();
  if (!shouldUseDemoData()) {
    return <LiveModePlaceholder title="Connect Plaid or brokerage accounts to view Investments" />;
  }

  const businessId = useMemo(
    () => data?.businessId || localStorage.getItem("currentBusinessId") || "",
    [data?.businessId]
  );
  const userId = useMemo(
    () => data?.user?.id || localStorage.getItem("user_id") || "",
    [data?.user?.id]
  );

  const integrationManager = useIntegrationManager({ businessId });
  const { getStatus, markStatus } = integrationManager;

  // ➜ Right sidebar: Agenda
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

  // ----------------- Hero Insight (Investments) -----------------
  const [hero, setHero] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      let res = null;
    try {
      if (typeof getHeroInsight === "function") {
        res = await getHeroInsight("investments", { force: true, timeout: 6000 });
      }
    } catch {}
    if (!alive) return;
    setHero(res?.hero ?? TEMP_DEBUG_MOCK_HERO);

    })();
    return () => { alive = false; };
  }, [businessId]);

  // ----------------- Overview (balances + allocation) -----------------
  const [balances, setBalances] = useState(null);
  const [allocation, setAllocation] = useState(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [errOverview, setErrOverview] = useState(null);

  // ----------------- Holdings -----------------
  const [positions, setPositions] = useState([]);
  const [asOf, setAsOf] = useState(null);
  const [loadingPos, setLoadingPos] = useState(true);
  const [errPos, setErrPos] = useState(null);

  // Initial load
  useEffect(() => {
    let ignore = false;

    (async () => {
      // 1) Overview (balances + allocation)
      try {
        setLoadingOverview(true);
        setErrOverview(null);
        const [b, a] = await Promise.all([getBalances(), getAssetAllocation()]);
        if (!ignore) {
          setBalances(b || null);
          setAllocation(a?.allocation ? a : { allocation: a?.allocation || {} });
        }

        // If nothing yet, try a one-shot sync then refetch (mock-safe)
        if (!ignore && (!b?.accounts || b.accounts.length === 0)) {
          await syncBalances();
          const [b2, a2] = await Promise.all([getBalances(), getAssetAllocation()]);
          if (!ignore) {
            setBalances(b2 || null);
            setAllocation(a2?.allocation ? a2 : { allocation: a2?.allocation || {} });
          }
        }
      } catch (e) {
        if (!ignore) setErrOverview(e?.message || "Failed to load balances");
      } finally {
        if (!ignore) setLoadingOverview(false);
      }

      // 2) Positions / holdings
      try {
        setLoadingPos(true);
        setErrPos(null);
        const p = await getPositions();
        const payload = p?.data || p || {};
        if (!ignore) {
          setPositions(Array.isArray(payload.positions) ? payload.positions : []);
          setAsOf(p?.as_of || payload?.as_of || null);
        }
      } catch (e) {
        if (!ignore) setErrPos(e?.message || "Failed to load holdings");
      } finally {
        if (!ignore) setLoadingPos(false);
      }
    })();

    return () => {
      ignore = true;
    };
  }, [userId]);

  // Merge for AccountCards
  const accountCardsData = useMemo(() => {
    if (!balances) return null;
    return {
      total_balance_usd: balances.total_balance_usd || 0,
      ytd_gain_usd: balances.ytd_gain_usd ?? 0,
      ytd_return_pct: balances.ytd_return_pct ?? null,
      accounts: balances.accounts || [],
      allocation: allocation?.allocation || null,
    };
  }, [balances, allocation]);

  // Treat API responses with meta.source === "mock" as demo-only and avoid showing "Synced".
  // For demo mode we always show "Sync Plaid" (avoid stale "Synced" badge from prior sessions).
  const forceUnsynced = true;

  useEffect(() => {
    if (!forceUnsynced) return;
    const status = getStatus("plaid");
    if (status?.status === "connected" || status?.status === "awaiting") {
      markStatus("plaid", "disconnected");
    }
  }, [forceUnsynced, getStatus, markStatus]);

  // ----------------- Handlers -----------------
  const handleViewHoldings = () => {
    const el = document.getElementById("holdings-table");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleRefreshOverview = async () => {
    try {
      await syncBalances();
      const [b, a] = await Promise.all([getBalances(), getAssetAllocation()]);
      setBalances(b || null);
      setAllocation(a?.allocation ? a : { allocation: a?.allocation || {} });
    } catch (e) {
      console.error("[Investments] sync failed", e);
    }
  };

  const handleConnect = useCallback(async () => {
    try {
      await integrationManager.connect("plaid");
    } catch (e) {
      console.error("[Investments] Plaid link failed", e);
    }
  }, [integrationManager]);
  const handleImportCSV = () => console.log("[Investments] Import CSV clicked");
  const handleAddManual = () => console.log("[Investments] Add manual clicked");

  const handleAskBizzy = (text) => onAskBizzy?.(text);
  const handleSchedule = (text, due_at) => console.log("[Schedule CTA]", text, due_at);
  const handleNavigate = (route, params) => navigate(route, { state: params });
  const TOP_CARD_MIN_H = 280;

  // ----------------- Render -----------------
  return (
    <div className="w-full min-h-screen bg-app text-primary">
      {/* Module Header */}
      <div className="max-w-[1200px] mx-auto px-4 pt-0 pb-2">
        <ModuleHeader
          module="investments"
          title="Wealth View"
          hero={hero}
          onDismissHero={() => setHero(null)}
          right={<SyncButton label="Sync Plaid" providers={["plaid"]} forceDisconnected={forceUnsynced} />}
        />
      </div>

      {/* Body */}
      <div className="max-w-[1200px] mx-auto px-4 pb-28">
      <div className="grid grid-cols-12 gap-5">
          <section className="col-span-12">
            {/* Overview */}
<Card variant="glass">
  {loadingOverview ? (
    <SkeletonGrid cols={3} />
  ) : errOverview ? (
    <div className="text-rose-400 text-sm">{errOverview}</div>
  ) : (
    <AccountCards data={accountCardsData} onViewHoldings={handleViewHoldings} />
  )}
</Card>

            {/* Pulse (own row, frameless to avoid double border) */}
<section className="mt-4 sm:mt-6">
  <Card variant="frameless" className="lg:max-w-[100%]">
    <WealthPulseCard
      userId={userId || undefined}
      onAskBizzy={handleAskBizzy}
      onSchedule={handleSchedule}
      onNavigate={handleNavigate}
    />
  </Card>
</section>

{/* Moves (own row, frameless to avoid double border) */}
<section className="mt-4 sm:mt-6">
  <Card variant="frameless" className="lg:max-w-[100%]">
    <WealthMovesPanel
      userId={userId || undefined}
      onAskBizzy={handleAskBizzy}
      onApplyMove={(move) =>
        handleAskBizzy(`Apply this move to my plan: ${move.move_title}`)
      }
    />
  </Card>
</section>


            {/* Holdings */}
<section id="holdings-table" className="mt-4 sm:mt-6">
  <Card variant="glass">
    {loadingPos ? (
      <div
        className="h-56 rounded-2xl border animate-pulse"
        style={{ background: "rgba(255,255,255,0.06)", borderColor: NEUTRAL_BORDER }}
      />
    ) : errPos ? (
      <div className="text-rose-400 text-sm">{errPos}</div>
    ) : (
      <HoldingsTable
        positions={positions}
        asOf={asOf}
        onRefresh={handleRefreshOverview}
        onConnect={handleConnect}
        onImportCSV={handleImportCSV}
        onAddManual={handleAddManual}
        onAskBizzy={handleAskBizzy}
      />
    )}
  </Card>
</section>
          </section>
        </div>
      </div>
    </div>
  );
}

/* -------------------- UI bits -------------------- */
function Card({
  className = "",
  children,
  style,
  variant = "glass", // "glass" | "solid" | "frameless"
}) {
  if (variant === "frameless") {
    // No container border/background — prevents double borders
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  }

  const baseStyle =
    variant === "glass"
      ? {
          background: "rgba(255,255,255,0.05)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          border: `1px solid ${RING_PURPLE}`,
          boxShadow: "0 14px 30px rgba(0,0,0,.28)",
        }
      : {
          background: PANEL_BG,
          border: `1px solid ${RING_PURPLE}`,
          boxShadow: "0 10px 24px rgba(0,0,0,.22)",
        };

  return (
    <div
      className={["rounded-2xl p-3 sm:p-4", className].join(" ")}
      style={{ ...baseStyle, ...style }}
    >
      {children}
    </div>
  );
}


function SkeletonGrid({ cols = 3 }) {
  const colClass =
    cols === 1 ? "md:grid-cols-1" :
    cols === 2 ? "md:grid-cols-2" :
    "md:grid-cols-3"; // default

  return (
    <div className={`grid grid-cols-1 ${colClass} gap-4`}>
      <div className="h-24 rounded-2xl border animate-pulse" style={{ background: "rgba(255,255,255,0.06)", borderColor: NEUTRAL_BORDER }} />
      <div className="h-24 rounded-2xl border animate-pulse" style={{ background: "rgba(255,255,255,0.06)", borderColor: NEUTRAL_BORDER }} />
      <div className="h-24 rounded-2xl border animate-pulse" style={{ background: "rgba(255,255,255,0.06)", borderColor: NEUTRAL_BORDER }} />
    </div>
  );
}
