import React, { useMemo, useState } from "react";
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
  accentHex,
  animate = false,
  index = 0,
  onFirstShown,
}) {
  const { module, title, body, metrics = [], created_at } = insight;
  const moduleKey = String(module || "bizzy").toLowerCase();
  const [hovered, setHovered] = useState(false);

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
  const delay = Math.min(index * 120, 1200);
  const BODY_AFTER_TITLE_PAUSE = 350;

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
          <span className="text-[11px] text-white/60 leading-none">{timeAgo(created_at)}</span>
          {onSnooze && (
            <button
              aria-label="Dismiss insight"
              title="Dismiss"
              onClick={() => onSnooze(insight.id, new Date().toISOString())}
              className="h-6 w-6 grid place-items-center rounded-md border border-white/12 text-white/70 hover:text-white hover:bg-white/10 transition"
              style={{ lineHeight: 1, paddingTop: "1px" }}
            >
              ×
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
    </div>
  );
}

/* ---------------- helpers ---------------- */

function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(diff)) return "";
  const s = diff / 1000;
  if (s < 60) return `${Math.floor(s)}s`;
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
