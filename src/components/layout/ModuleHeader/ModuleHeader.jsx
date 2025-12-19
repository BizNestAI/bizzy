// src/components/layout/ModuleHeader/ModuleHeader.jsx
import React from "react";
import { moduleTheme } from "./moduleTheme";
import HeroInsightCard from "./HeroInsightCard";

/**
 * Props
 * -----
 * module:    "jobs" | "bizzy" | "financials" | "marketing" | "tax" | "investments"
 * title?:    string  (defaults: bizzy → "Bizzi Pulse", jobs → "Job Flow")
 * subtitle?: string
 * hero?:     { id, title, summary?, metric?, delta?, severity?, cta?, dismissible? } | null
 * onDismissHero?: (id) => void
 * heroVariant?: "compact" | "default"
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
  const CHROME_HEX  = "#BFBFBF";
  const CHROME_SOFT = "rgba(191,191,191,0.45)"; // glow/line soft
  const CHROME_FADE = "rgba(191,191,191,0.22)";

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

  const pillClass =
    "inline-flex items-center gap-3 rounded-full border border-white/12 bg-black/20 px-4 sm:px-5 py-2 text-[18px] sm:text-[20px] font-medium tracking-[0.18em] text-[#d3d7de]";

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <span className={pillClass}>{effectiveTitle}</span>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>

      {subtitle ? (
        <p className="mt-3 text-[13px] text-white/70">{subtitle}</p>
      ) : null}

      {hero ? (
        <div className="mt-4" aria-live="polite">
          <HeroInsightCard
            insight={hero}
            accent={accentForLine}
            onDismiss={onDismissHero}
            variant={heroVariant}
          />
        </div>
      ) : null}
    </div>
  );
}
