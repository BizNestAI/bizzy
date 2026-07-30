import React from "react";
import { Info } from "lucide-react";
import KpiCard from "../UI/KpiCard.jsx";

export default function TaxSummaryCard({
  label,
  value,
  status = "known",
  detail,
  tooltip,
  action,
  loading = false,
}) {
  const display = loading ? "Loading" : formatValueForStatus(value, status);
  const tone = status === "incomplete" ? "amber" : status === "unavailable" ? "neutral" : "emerald";

  return (
    <div className="relative h-full">
      <KpiCard
        compact
        label={label}
        value={display}
        detail={detail}
        tone={tone}
        icon={tooltip ? <Info className="h-4 w-4" aria-hidden="true" /> : null}
        multilineValue={status !== "known"}
        className="min-h-[118px]"
      />
      {tooltip ? (
        <span className="sr-only">{tooltip}</span>
      ) : null}
      {action?.label ? (
        <button
          type="button"
          onClick={action.onClick}
          className="absolute bottom-3 right-3 rounded-full border border-white/12 bg-black/25 px-2.5 py-1 text-[11px] font-semibold text-white/72 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/40"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function formatValueForStatus(value, status) {
  if (status === "loading") return "Loading";
  if (value == null) {
    if (status === "incomplete") return "Setup needed";
    if (status === "unavailable") return "Not available";
    return "Needs more data";
  }
  if (typeof value === "number") {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
  }
  return value;
}
