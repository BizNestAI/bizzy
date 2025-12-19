// src/pages/Marketing/MarketingDashboard.jsx
import React, { useEffect, useState, useMemo } from "react";
import { useBusiness } from "../../context/BusinessContext";
import useModuleTheme from "../../hooks/useModuleTheme";

import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader";
import SyncButton from "../../components/Integrations/SyncButton.jsx";
// import { getHeroInsight } from "../../services/heroInsights/getHeroInsight";

import MarketingAnalyticsDashboard from "../../components/Marketing/MarketingAnalyticsDashboard";
import RecentPostsCard from "../../components/Marketing/RecentPostsCard";
import MarketingSummaryTiles from "../../components/Marketing/MarketingSummaryTiles";
import { marketingSummaryFallback } from "../../components/Marketing/marketingSummaryData";

import { useNavigate } from "react-router-dom";
import { useRightExtras } from "../../insights/RightExtrasContext";
import AgendaWidget from "../../pages/calendar/AgendaWidget.jsx";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";

/* ---- Marketing accent + graphite helpers ---- */
const MARKETING_ACCENT = "#3B82F6"; // base blue
const PANEL_BG = "var(--panel)";

function hexToRgba(hex, alpha = 1) {
  let c = (hex || "").replace("#", "");
  if (c.length === 3) c = c.split("").map(s => s + s).join("");
  const n = parseInt(c || "000000", 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ── Frames: darker chrome + darker blue
const CHROME_BORDER          = "rgba(165,167,169,0.14)";
const CHROME_BORDER_HOVER    = "rgba(165,167,169,0.20)";
const BLUE_DARK_BORDER       = hexToRgba(MARKETING_ACCENT, 0.18);
const BLUE_DARK_BORDER_HOVER = hexToRgba(MARKETING_ACCENT, 0.26);

/** Graphite card wrapper with subtle glass styling */
const Card = ({
  children,
  className = "",
  padded = true,
  variant = "default",
}) => {
  const [isHover, setHover] = useState(false);
  const isBorderless = variant === "borderless";

  return (
    <div
      className={[
        "relative rounded-[24px]",
        padded ? "p-4 sm:p-6" : "",
        isBorderless ? "transition-all duration-300" : "border transition-all duration-300",
        className,
      ].join(" ")}
      style={{
        borderColor: isBorderless ? "transparent" : isHover ? BLUE_DARK_BORDER_HOVER : BLUE_DARK_BORDER,
        background: isBorderless
          ? "transparent"
          : "linear-gradient(140deg, rgba(12,16,23,0.95), rgba(6,8,13,0.9))",
        backdropFilter: isBorderless ? "none" : "blur(26px)",
        WebkitBackdropFilter: isBorderless ? "none" : "blur(26px)",
        boxShadow: isBorderless
          ? "none"
          : isHover
          ? `0 30px 65px rgba(0,0,0,0.55), 0 0 25px rgba(59,130,246,0.15)`
          : "0 24px 52px rgba(0,0,0,0.5)",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {children}
    </div>
  );
};

// Add a "scroll" prop (default: true). When false, we hide bars entirely.
  const Cap = ({ children, scroll = true }) => (
    <>
      {/* cross-browser scrollbar hide utility */}
      <style>{`
        .no-scrollbar { scrollbar-width: none; -ms-overflow-style: none; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
      `}</style>
      <div
        className={[
          "relative min-h-[140px]",
          "max-h-[280px] sm:max-h-[300px] lg:max-h-[340px]",
          scroll ? "overflow-y-auto overscroll-contain pr-1 no-scrollbar" : "overflow-hidden",
        ].join(" ")}
      >
        {children}
      </div>
    </>
  );

export default function MarketingDashboard() {
  const { currentBusiness, loading } = useBusiness();
  const theme = useModuleTheme("marketing");
  const navigate = useNavigate();
  const { setRightExtras } = useRightExtras();

  const [hero, setHero] = useState(null);

  const businessId = useMemo(
    () => currentBusiness?.id || localStorage.getItem("currentBusinessId"),
    [currentBusiness?.id]
  );

  // Right rail agenda
  useEffect(() => {
    if (!businessId) return;
    setRightExtras(
      <AgendaWidget
        businessId={businessId}
        module="marketing"
        onOpenCalendar={() => navigate("/dashboard/calendar")}
      />
    );
    return () => setRightExtras(null);
  }, [businessId, navigate, setRightExtras]);

  // Load hero insight (Marketing) — keep your existing logic/import as needed.
  useEffect(() => {
    let alive = true;
    (async () => {
      // const res = await getHeroInsight("marketing", { force: true, timeout: 6000 });
      const res = null;
      if (!alive) return;
      if (!res?.hero) {
        setHero({
          id: "debug-mkt-hero",
          title: "Engagement up 8% vs last week",
          summary: "CTR improved after Tuesday's campaign. Connect accounts to see live data.",
          metric: "+8%",
          severity: "good",
          dismissible: true,
        });
      } else {
        setHero(res.hero);
      }
    })();
    return () => { alive = false; };
  }, [businessId]);

  if (loading) return null;
  if (!currentBusiness) return <div className="text-rose-400 p-4">No business selected.</div>;
  if (!shouldUseDemoData(currentBusiness)) {
    return <LiveModePlaceholder title="Connect your social + reviews to view Marketing insights" />;
  }

  /* Graphite tokens */
  const bgColor = theme?.bgClass || "bg-app";
  const textColor = theme?.textClass || "text-primary";

  const summaryData = marketingSummaryFallback;

  return (
    <div className={`w-full px-3 md:px-4 pt-0 pb-6 font-sans ${textColor} ${bgColor}`}>
      {/* Header (title + optional hero) */}
      <ModuleHeader
        module="marketing"
        title="Growth Studio"
        hero={hero}
        onDismissHero={() => setHero(null)}
        className="mb-6"
        right={<SyncButton label="Sync Socials" providers={["facebook", "instagram", "linkedin"]} />}
      />

      {/* Middle column constrained between sidebar and insights rail */}
      <div className="mx-auto w-full max-w-[1200px] 2xl:max-w-[1280px]">
        <div className="mb-5">
          <MarketingSummaryTiles summary={summaryData} />
        </div>
        {/* Content rows; don't stretch cards vertically */}
        <div className="grid grid-cols-12 gap-6 items-start">
          {/* Analytics (full width top row) */}
          <div className="col-span-12">
            <Card variant="borderless" padded={false}>
              <MarketingAnalyticsDashboard businessId={businessId} summary={summaryData} />
            </Card>
        </div>

        <div className="col-span-12">
          <Card variant="borderless" padded={false}>
            <Cap>
              <RecentPostsCard businessId={businessId} fullWidth />
            </Cap>
          </Card>
        </div>

        </div>
      </div>
    </div>
  );
}
