import React, { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import Typewriter from "./Typewriter.jsx";

/** Chrome Silver for default/ChatHome scheme */
const CHROME_HEX  = "#BFBFBF";

function hexToRgba(hex, a = 1) {
  let c = (hex || "").replace("#", "");
  if (c.length === 3) c = c.split("").map(s => s + s).join("");
  const n = parseInt(c || "000000", 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

export default function InsightCard({
  insight = {},
  onSnooze,
  onCta,
  accentHex,
  animate = false,
  index = 0,
  onFirstShown,
  hideDashboardNavigationCtas = false,
}) {
  const { module, title, body, metrics = [], created_at } = insight;
  const moduleKey = String(module || "bizzy").toLowerCase();
  const [hovered, setHovered] = useState(false);
  const primaryCta = useMemo(() => {
    const cta = normalizeCta(insight, "primary");
    return hideDashboardNavigationCtas && isDashboardNavigationCta(cta) ? null : cta;
  }, [hideDashboardNavigationCtas, insight]);
  const secondaryCta = useMemo(() => {
    const cta = normalizeCta(insight, "secondary");
    return hideDashboardNavigationCtas && isDashboardNavigationCta(cta) ? null : cta;
  }, [hideDashboardNavigationCtas, insight]);
  const hasCtas = Boolean(primaryCta?.label || secondaryCta?.label);

  // Accent: always default chrome silver (or explicit override)
  const baseHex = useMemo(() => accentHex || CHROME_HEX, [accentHex]);

  // 🧊 Card glass style — light, non-opaque
  // (This is the important change: we remove the heavy dark fill.)
  const glassBg = "linear-gradient(180deg, rgba(18,19,20,0.38) 0%, rgba(18,19,20,0.26) 100%)";
  const borderCol = useMemo(() => hexToRgba(baseHex, 0.22), [baseHex]);
  const outerGlow = useMemo(() => hexToRgba(baseHex, 0.14), [baseHex]);
  const hoverGlow = useMemo(() => hexToRgba(baseHex, 0.24), [baseHex]);
  const hoverBorder = useMemo(() => hexToRgba(baseHex, 0.28), [baseHex]);
  const innerEdge = "rgba(255,255,255,0.04)";

  // Typewriter timing
  const [titleDone, setTitleDone] = useState(false);
  const [relativeNow, setRelativeNow] = useState(() => Date.now());
  const delay = Math.min(index * 120, 1200);
  const BODY_AFTER_TITLE_PAUSE = 350;

  useEffect(() => {
    if (!created_at) return undefined;
    const id = setInterval(() => setRelativeNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [created_at]);

  return (
    <div
      className="ml-2 rounded-2xl p-3"
      style={{
        // glassy, *light* background so it doesn’t read as a black slab
        background: glassBg,
        // small blur/saturate to sell the glass; not enough to hurt perf
        backdropFilter: "blur(6px) saturate(128%)",
        WebkitBackdropFilter: "blur(6px) saturate(128%)",

        border: `1px solid ${hovered ? hoverBorder : borderCol}`,
        // Feathered accent glow; strengthen slightly on hover
        boxShadow: hovered
          ? `0 0 12px ${hoverGlow}, inset 0 1px 0 ${innerEdge}`
          : `0 0 10px ${outerGlow}, inset 0 1px 0 ${innerEdge}`,
        backgroundClip: "padding-box",
        transform: hovered ? "translateY(-3px) scale(1.02)" : "translateY(0) scale(1)",
        transition: "transform 200ms cubic-bezier(0.22,1,0.36,1), box-shadow 200ms ease, border-color 200ms ease",
        transformOrigin: "center center",
        willChange: "transform",
      }}
      role="note"
      aria-live="off"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-module={moduleKey}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-1">
        <div
          className="min-w-0 font-semibold leading-tight whitespace-normal break-words text-[15px] text-white/95"
          style={{ fontFamily: '"IBM Plex Sans", system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}
        >
          {animate ? (
            <Typewriter
              key={`title-${insight.id || created_at || title}`}
              text={title || ""}
              startDelay={delay}
              onDone={() => {
                setTitleDone(true);
                onFirstShown?.();
              }}
            />
          ) : (
            title || ""
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0 mt-[2px]">
          <span className="text-[11px] text-white/60 leading-none">{timeAgo(created_at, relativeNow)}</span>
          {onSnooze && (
            <button
              aria-label="Dismiss insight"
              title="Dismiss"
              onClick={() => onSnooze(insight.id, new Date().toISOString())}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-white/12 p-0 text-white/70 hover:text-white hover:bg-white/10 transition"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      {body && (
        <div
          className="text-sm leading-relaxed text-white/86 mb-2 whitespace-normal break-words tracking-[0.01em]"
          style={{ fontFamily: '"IBM Plex Sans", system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}
        >
          {animate ? (
            titleDone && (
              <Typewriter
                key={`body-${insight.id || created_at || body}`}
                text={body}
                startDelay={BODY_AFTER_TITLE_PAUSE}
              />
            )
          ) : (
            body
          )}
        </div>
      )}

      {/* Metrics */}
      {Array.isArray(metrics) && metrics.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {metrics.map((m, i) => (
            <span
              key={i}
              className={`text-[11px] px-1.5 py-0.5 rounded-full border ${deltaClass(m?.delta)}`}
              style={{ fontFamily: '"IBM Plex Sans", system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}
            >
              {m?.label}: {m?.value}
              {m?.delta ? ` (${m.delta})` : ""}
            </span>
          ))}
        </div>
      )}

      {/* CTAs */}
      {hasCtas && (
        <div className="mt-2 flex flex-wrap gap-2">
          {primaryCta?.label && (
            <button
              type="button"
              onClick={() => onCta?.(insight, primaryCta, "primary")}
              className="min-h-7 max-w-full rounded-md border border-emerald-400/45 bg-emerald-400/12 px-2.5 py-1 text-[12px] font-semibold leading-4 text-emerald-100 shadow-[0_0_12px_rgba(16,185,129,0.12)] transition hover:border-emerald-300/70 hover:bg-emerald-400/20 focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
              style={{ fontFamily: '"IBM Plex Sans", system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}
            >
              <span className="block truncate">{primaryCta.label}</span>
            </button>
          )}
          {secondaryCta?.label && (
            <button
              type="button"
              onClick={() => onCta?.(insight, secondaryCta, "secondary")}
              className="min-h-7 max-w-full rounded-md border border-white/12 bg-white/[0.04] px-2.5 py-1 text-[12px] font-semibold leading-4 text-white/74 transition hover:border-white/22 hover:bg-white/[0.08] hover:text-white focus:outline-none focus:ring-2 focus:ring-white/15"
              style={{ fontFamily: '"IBM Plex Sans", system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}
            >
              <span className="block truncate">{secondaryCta.label}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- helpers ---------------- */

function parsePayload(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return { value };
  }
}

function normalizeCta(insight = {}, prefix) {
  const nested = insight[`${prefix}_cta`] || {};
  const label = insight[`${prefix}_cta_label`] ?? nested.label ?? null;
  const action = insight[`${prefix}_cta_action`] ?? nested.action ?? null;
  const payload = insight[`${prefix}_cta_payload`] ?? nested.payload ?? (nested.route ? { route: nested.route } : null);
  if (!label || !action) return null;
  return {
    label,
    action,
    payload: parsePayload(payload),
  };
}

function isDashboardNavigationCta(cta) {
  if (!cta) return false;
  const action = String(cta.action || "").trim().toLowerCase();
  if (action !== "navigate" && action !== "open_route") return false;
  const payload = cta.payload || {};
  const route = payload.path || payload.route || payload.url || payload.value || "";
  return String(route).startsWith("/dashboard");
}

function timeAgo(ts, nowMs = Date.now()) {
  if (!ts) return "";
  const createdMs = new Date(ts).getTime();
  if (!Number.isFinite(createdMs)) return "";
  const diffMs = Math.max(0, nowMs - createdMs);
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function deltaClass(delta = "") {
  if (!delta && delta !== 0) {
    return "border-white/15 text-white/80";
  }
  const d = String(delta).trim();
  return d.startsWith("-")
    ? "border-rose-400/35 text-rose-300/90"
    : "border-emerald-400/35 text-emerald-300/90";
}
