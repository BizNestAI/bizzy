import React from "react";

export default function TaxDataFreshnessBadge({ mode = "live", label, refreshing = false }) {
  const isDemo = mode === "demo";
  return (
    <span
      className={[
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-semibold",
        isDemo
          ? "border-amber-300/30 bg-amber-300/10 text-amber-100"
          : "border-emerald-300/24 bg-emerald-300/10 text-emerald-100",
      ].join(" ")}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${refreshing ? "animate-pulse bg-white" : isDemo ? "bg-amber-300" : "bg-emerald-300"}`} />
      {isDemo ? "Demo" : refreshing ? "Refreshing" : "Live"}
      {label ? <span className="font-medium text-white/56">{label}</span> : null}
    </span>
  );
}
