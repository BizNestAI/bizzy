import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LineChart, BarChart2, Shield } from "lucide-react";
import CardHeader from "../../components/UI/CardHeader.jsx";
import { usePeriod } from "../../context/PeriodContext";

function withAlpha(hex = "#FFFFFF", alpha = 1) {
  const clean = hex.replace("#", "");
  const bigint = parseInt(clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function Stat({ label, value, suffix, Icon, accentHex = "#FFFFFF", onClick }) {
  const [hovered, setHovered] = useState(false);
  const accentGlow = `linear-gradient(120deg, ${withAlpha(accentHex, 0.18)}, transparent 65%)`;
  const cardStyle = {
    border: "1px solid rgba(255,255,255,0.08)",
    background: "linear-gradient(150deg, rgba(11,14,20,0.95), rgba(5,7,10,0.92))",
    boxShadow: hovered
      ? `0 28px 60px ${withAlpha(accentHex, 0.25)}`
      : "0 18px 45px rgba(0,0,0,0.45)",
    transform: hovered ? "translateY(-2px)" : "translateY(0)",
    transition: "box-shadow 220ms ease, transform 220ms ease, border-color 220ms ease",
  };
  return (
    <button
      type="button"
      className="relative overflow-hidden rounded-xl p-3 sm:p-4 text-left w-full focus:outline-none"
      style={cardStyle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-80" style={{ background: accentGlow }} />
      <div className="relative flex items-center justify-between">
        <span className="text-xs font-medium tracking-wide text-white/70">{label}</span>
        {Icon ? (
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10"
            style={{ backgroundColor: withAlpha(accentHex, 0.1), color: accentHex }}
          >
            <Icon size={16} aria-hidden />
          </span>
        ) : null}
      </div>
      <div className="relative mt-3 text-3xl font-semibold text-white">
        <span className="drop-shadow-[0_5px_15px_rgba(0,0,0,0.55)]">{value}</span>
        {suffix ? (
          <span className="ml-2 text-base font-normal text-white/70">{suffix}</span>
        ) : null}
      </div>
      <div
        aria-hidden
        className="absolute inset-x-3 bottom-2 h-px"
        style={{ background: `linear-gradient(90deg, transparent, ${withAlpha(accentHex, 0.45)}, transparent)` }}
      />
    </button>
  );
}

/**
 * Values are placeholders; wire real values when available via props.
 *
 * Props:
 * - showHeader?: boolean (default true)
 * - eyebrowOverride?: string (optional) // e.g., "SNAPSHOT — Q1 2026"
 */
export default function BizzySnapshot({
  profitability = "$15,700",
  marketingReach = "—",
  marketingReachSuffix = "views",
  taxReadiness = "83%",
  showHeader = true,
  eyebrowOverride,
}) {
  const { period } = usePeriod?.() || {};
  const navigate = useNavigate?.();
  const now = new Date();
  const year = period?.year ?? now.getFullYear();
  const monthIndex = (period?.month ?? now.getMonth() + 1) - 1; // 0-based
  const monthShort = new Date(year, monthIndex, 1).toLocaleString(undefined, { month: "short" });
  const monthStamp = `${monthShort.toUpperCase()} ${year}`;
  const eyebrow = eyebrowOverride || `SNAPSHOT — ${monthStamp}`;

  return (
    <div className="relative space-y-3 sm:space-y-4">
      {showHeader && <CardHeader eyebrow={eyebrow} className="px-1 sm:px-2" />}
      <div className="relative grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <Stat
          label="Profitability"
          value={profitability}
          Icon={LineChart}
          accentHex="#42F8C4"
          onClick={() => navigate?.("/dashboard/accounting")}
        />
        <Stat
          label="Marketing Reach"
          value={marketingReach}
          suffix={marketingReachSuffix}
          Icon={BarChart2}
          accentHex="#7C8BFF"
          onClick={() => navigate?.("/dashboard/marketing")}
        />
        <Stat
          label="Tax Readiness"
          value={taxReadiness}
          Icon={Shield}
          accentHex="#FFC86B"
          onClick={() => navigate?.("/dashboard/tax")}
        />
      </div>
    </div>
  );
}
