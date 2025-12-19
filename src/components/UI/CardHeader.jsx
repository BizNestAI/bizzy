// src/components/UI/CardHeader.jsx
import React from "react";

/**
 * Consistent card header for dashboard cards (not the big page header).
 *
 * Props:
 *  - title?: string            // main title; omit to render eyebrow-only
 *  - eyebrow?: string          // small uppercase line (e.g., "KPIS — OCT 2025")
 *  - subtitle?: string
 *  - right?: React.ReactNode   // right-aligned actions/badges
 *  - size?: "sm" | "md" | "lg" // default "md"
 *  - titleTone?: "muted" | "bold" (default "muted")
 *  - className?: string
 */
export default function CardHeader({
  title = "",
  eyebrow,
  subtitle,
  right = null,
  size = "md",
  titleTone = "muted",
  className = "",
}) {
  // Slightly larger but still compact title sizing
  const titleSize =
    size === "lg"
      ? "text-xl md:text-2xl"
      : size === "sm"
      ? "text-[15px] md:text-base"
      : "text-[17px] md:text-[19px]";

  // Slim, muted by default; set titleTone="bold" for stronger emphasis
  const titleClass =
    title && (titleTone === "bold"
      ? "font-semibold text-white/90"
      : "font-medium text-white/80");

  // Eyebrow: slightly larger, uppercase, muted gray (your KPIs style)
  const eyebrowClass =
    "text-[13px] md:text-[15px] uppercase tracking-[0.08em] text-white/65";

  return (
    <div className={`flex items-start justify-between ${className}`}>
      <div className="min-w-0">
        {eyebrow ? <div className={eyebrowClass}>{eyebrow}</div> : null}

        {title ? (
          <h3
            className={`${titleClass} ${titleSize} tracking-[-0.01em] leading-tight truncate`}
            style={{
              fontFamily:
                '"IBM Plex Sans", system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
            }}
          >
            {title}
          </h3>
        ) : null}

        {subtitle ? (
          <p className="mt-0.5 text-[12px]" style={{ color: "var(--text-2)" }}>
            {subtitle}
          </p>
        ) : null}
      </div>

      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}
