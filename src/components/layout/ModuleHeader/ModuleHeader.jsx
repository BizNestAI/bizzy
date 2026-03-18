// src/components/layout/ModuleHeader/ModuleHeader.jsx
import React from "react";
import { moduleTheme } from "./moduleTheme";
// import HeroInsightCard from "./HeroInsightCard";

/**
 * Props
 * -----
 * module:    "jobs" | "bizzy" | "financials" | "marketing" | "tax" | "investments"
 * title?:    string  (defaults: bizzy → "Bizzi Pulse", jobs → "Job Flow")
 * subtitle?: string
 * hero?:     { id, title, summary?, metric?, delta?, severity?, cta?, dismissible? } | null
 * onDismissHero?: (id) => void
 * heroVariant?: "compact" | "default" | "minimal"
 * tone?:     "calm" | "neon"  (default: "calm")
 * right?:    ReactNode
 * className?: string
 */
export default function ModuleHeader({
  module = "financials",
  title,
  subtitle,
  hero = null,
  onDismissHero,
  heroVariant = "compact",
  tone: toneProp,
  right = null,
  className = "",
}) {
  const isBizzyFamily = module === "bizzy" || module === "jobs";

  // Base theme pulled from moduleTheme, then overridden for Bizzi family
  const base = moduleTheme[module] || moduleTheme.financials || {};

  // Chrome/silver tokens
  const CHROME_HEX  = base.accent || "var(--accent)";
  const CHROME_SOFT = "rgba(52,211,153,0.45)"; // glow/line soft
  const CHROME_FADE = "rgba(52,211,153,0.22)";

  // Accent palette
  // For bizzy/jobs we want chrome by default (per your request), not pink.
  const t =
    isBizzyFamily
      ? {
          ...base,
          accent: CHROME_HEX,
          accentLight: CHROME_SOFT,
          accentFaint: CHROME_FADE,
          text: base.text || "#ffffff",
        }
      : base;

  const tone = toneProp ?? "calm";

  // Defaults per module
  const effectiveTitle =
    title ??
    (module === "bizzy"
      ? "Bizzi Pulse"
      : module === "jobs"
      ? "Job Flow"
      : "");
  const moduleLabelMap = {
    bizzy: "Bizzi Pulse",
    jobs: "Job Flow",
    financials: "Financial Hub",
    marketing: "Marketing",
    tax: "Tax",
    investments: "Investments",
  };
  const moduleLabel = moduleLabelMap[module] || "Bizzi";

  const accentForLine = isBizzyFamily ? CHROME_HEX : t.accent;
  const glowForLine = isBizzyFamily ? CHROME_SOFT : t.accentFaint;

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[20px] sm:text-[22px] font-semibold tracking-[0.2em] text-white">
          {effectiveTitle}
        </span>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>

      {subtitle ? (
        <p className="mt-3 text-[13px] text-white/70">{subtitle}</p>
      ) : null}

      {/* Hero insight intentionally suppressed on Financials page per request */}
    </div>
  );
}
