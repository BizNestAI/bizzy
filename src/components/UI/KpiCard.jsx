import React from "react";

const TONES = {
  neutral: {
    border: "border-white/10",
    glow: "shadow-[0_22px_54px_rgba(0,0,0,0.38)]",
    value: "text-white",
    marker: "bg-white/45",
    icon: "text-white/62",
  },
  emerald: {
    border: "border-emerald-300/24",
    glow: "shadow-[0_22px_56px_rgba(0,0,0,0.36),0_0_28px_rgba(16,185,129,0.10)]",
    value: "text-emerald-100",
    marker: "bg-emerald-300 shadow-[0_0_10px_rgba(32,216,155,0.18)]",
    icon: "text-emerald-200",
  },
  amber: {
    border: "border-amber-300/24",
    glow: "shadow-[0_22px_56px_rgba(0,0,0,0.36),0_0_24px_rgba(251,191,36,0.08)]",
    value: "text-amber-100",
    marker: "bg-amber-300 shadow-[0_0_14px_rgba(251,191,36,0.32)]",
    icon: "text-amber-200",
  },
  rose: {
    border: "border-rose-300/24",
    glow: "shadow-[0_22px_56px_rgba(0,0,0,0.36),0_0_24px_rgba(244,63,94,0.09)]",
    value: "text-rose-100",
    marker: "bg-rose-300 shadow-[0_0_14px_rgba(244,63,94,0.32)]",
    icon: "text-rose-200",
  },
};

function getTrendTone(trend, change) {
  const normalized = String(trend || "").toLowerCase();
  if (normalized === "up" || normalized === "positive") return "emerald";
  if (normalized === "down" || normalized === "negative") return "rose";
  if (typeof change === "number") {
    if (change > 0) return "emerald";
    if (change < 0) return "rose";
  }
  return "neutral";
}

function TrendIndicator({ trend, change }) {
  if (change === null || change === undefined || change === "") return null;
  const tone = getTrendTone(trend, change);
  const positive = tone === "emerald";
  const negative = tone === "rose";
  const classes = {
    emerald: "border-emerald-300/25 bg-emerald-300/10 text-emerald-100",
    rose: "border-rose-300/25 bg-rose-300/10 text-rose-100",
    neutral: "border-white/12 bg-white/[0.06] text-white/66",
  };

  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${classes[tone]}`}>
      <span aria-hidden="true">{positive ? "↑" : negative ? "↓" : "→"}</span>
      <span>{change}</span>
    </span>
  );
}

export default function KpiCard({
  label,
  value,
  detail,
  trend,
  change,
  tone = "neutral",
  icon,
  className = "",
  valueClassName = "",
  compact = false,
  multilineValue = false,
}) {
  const styles = TONES[tone] || TONES.neutral;

  return (
    <div
      className={[
        "group relative h-full overflow-hidden rounded-[20px] border bg-[var(--panel)] backdrop-blur-xl",
        "transition-all duration-200 hover:-translate-y-0.5 hover:border-emerald-300/35",
        styles.border,
        styles.glow,
        compact ? "min-h-[108px] p-3.5" : "min-h-[132px] p-4 sm:p-4",
        className,
      ].join(" ")}
    >
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.085] via-transparent to-black/15 opacity-95" />
      <div className="pointer-events-none absolute -left-10 -top-12 h-28 w-28 rounded-full bg-emerald-300/[0.045] blur-2xl opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
      <div className="pointer-events-none absolute inset-0 rounded-[20px] ring-1 ring-inset ring-white/[0.035]" />
      <div className="relative flex min-h-full flex-col">
        <div className="flex min-h-[2.35rem] items-start justify-between gap-3">
          <div className="min-w-0 text-[10px] font-semibold uppercase leading-snug tracking-[0.13em] text-white/48">
            {label}
          </div>
          {icon ? (
            <div className={`shrink-0 rounded-full border border-white/10 bg-white/[0.05] p-1.5 ${styles.icon}`}>
              {icon}
            </div>
          ) : (
            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${styles.marker}`} />
          )}
        </div>

        <div
          className={[
            "mt-2 max-w-full font-extrabold leading-tight tracking-normal tabular-nums drop-shadow-[0_10px_24px_rgba(0,0,0,0.32)]",
            multilineValue ? "line-clamp-2" : "truncate",
            compact ? "text-[1.35rem] sm:text-[1.45rem]" : "text-[clamp(1.45rem,1.55vw,1.9rem)]",
            styles.value,
            valueClassName,
          ].join(" ")}
        >
          {value ?? "—"}
        </div>

        {(detail || change) ? (
          <div className="mt-auto flex min-h-6 items-end justify-between gap-2 pt-3">
            {detail ? <div className="min-w-0 text-[10px] font-semibold leading-snug text-white/48">{detail}</div> : <span />}
            <TrendIndicator trend={trend} change={change} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
