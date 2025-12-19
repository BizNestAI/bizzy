// src/components/layout/ModuleHeader/HeroInsightCard.jsx
import React, { useState } from "react";

/**
 * Framed hero card for the module header.
 * - Full accent border with a soft glow
 * - Compact by default to avoid pushing layout
 * - Metric pill on the right, optional dismiss
 *
 * Props:
 *  - insight: { id, title, summary?, metric?, severity?, dismissible?, cta?:{label, href} }
 *  - accent:  string (module accent color)
 *  - onDismiss: (id) => void
 *  - compact: boolean (smaller padding)
 *  - variant: "compact" | "default" | "minimal"
 */
export default function HeroInsightCard({
  insight,
  accent = "#00FFB2",
  onDismiss,
  compact = true,
  variant,
}) {
  if (!insight) return null;

  const [hovered, setHovered] = useState(false);
  const normalizedVariant = variant || (compact ? "compact" : "default");
  const isMinimal = normalizedVariant === "minimal";
  const pad =
    normalizedVariant === "default"
      ? "px-4 py-3.5"
      : normalizedVariant === "minimal"
      ? "px-4 py-3"
      : "px-3 py-2.5";

  const severityColor =
    insight.severity === "good" ? "#00D59C" :
    insight.severity === "warn" ? "#F59E0B" :
    insight.severity === "risk" ? "#EF4444" : null;

  // Dot/pill should use the module accent first, falling back to severity.
  const badgeColor = accent || severityColor || "#94A3B8";

  // Warm gray base with a subtle lift on hover; no border or glow.
  const heroBg =
    "linear-gradient(180deg, rgba(42,38,34,0.94) 0%, rgba(32,29,27,0.92) 100%)";
  const heroBgHover =
    "linear-gradient(180deg, rgba(52,47,43,0.96) 0%, rgba(40,36,33,0.94) 100%)";

  const showMetric = !isMinimal && Boolean(insight.metric);
  const showDismiss = Boolean(insight.dismissible && onDismiss);
  const hasRightActions = showMetric || showDismiss;

  return (
    <div
      className={[
        "relative rounded-lg flex items-center justify-between gap-3",
        pad,
        "text-white transition-colors duration-200",
      ].join(" ")}
      style={{
        background: hovered ? heroBgHover : heroBg,
        border: "none",
        boxShadow: "none",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Main text block */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
            style={{ backgroundColor: badgeColor }}
            aria-hidden="true"
          />
          <p className="text-white font-medium truncate">{insight.title}</p>
        </div>

        {insight.summary && (
          <p
            className="text-[13px] text-white/70 mt-1 line-clamp-2"
            title={insight.summary}
          >
            {insight.summary}
          </p>
        )}

        {!isMinimal && insight.cta?.label && insight.cta?.href && (
          <a
            href={insight.cta.href}
            className="mt-1 inline-block text-[12px] font-medium hover:underline"
            style={{ color: accent }}
          >
            {insight.cta.label}
          </a>
        )}
      </div>

      {hasRightActions ? (
        <div className="shrink-0 flex items-center gap-2">
          {showMetric ? (
            <span
              className="text-[12px] font-semibold px-2 py-1 rounded-full"
              style={{
                color: "white",
                background: `${accent}26`, // ~15%
                border: `1px solid ${accent}4D`, // ~30%
              }}
            >
              {insight.metric}
            </span>
          ) : null}
          {showDismiss ? (
            <button
              aria-label="Dismiss hero"
              className="text-white/50 hover:text-white text-sm transition-colors"
              onClick={() => onDismiss(insight.id)}
            >
              ✕
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
