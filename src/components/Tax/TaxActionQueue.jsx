// src/components/Tax/TaxActionQueue.jsx
import React, { useState } from "react";
import { RefreshCw, MessageCircle, CalendarClock } from "lucide-react";
import { useTaxInsights } from "../../hooks/useTaxInsights";

const CARD_BASE =
  "rounded-[16px] border border-white/12 bg-white/[0.05] shadow-[0_18px_50px_rgba(0,0,0,0.35)]";

export default function TaxActionQueue({ businessId, onAskBizzy, watchKey }) {
  const { tips, loading, error, refetch } = useTaxInsights({ businessId, watchKey });
  const [expanded, setExpanded] = useState(null);
  const rows = tips && tips.length ? tips : Array.from({ length: 3 }, () => ({ loading: true }));

  return (
    <div className={`${CARD_BASE} p-4 sm:p-5 text-white`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[12px] uppercase tracking-[0.14em] text-white/65">Action Steps</div>
          <div className="text-lg font-semibold leading-tight">Sorted by impact</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refetch}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 border border-white/12 text-[12px] text-white/80 hover:text-white hover:bg-white/10 transition"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {error ? <div className="text-xs text-rose-300 mt-2">{error}</div> : null}

      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {rows.map((row, idx) => (
          <ActionCard
            key={idx}
            {...row}
            highlight={idx === 0}
            expanded={expanded === idx}
            onToggle={() => setExpanded(expanded === idx ? null : idx)}
            onAsk={() => onAskBizzy?.("Walk me through this action", { action: row.tip, urgency: row.urgency })}
          />
        ))}
      </div>
    </div>
  );
}

function ActionCard({ loading, tip, urgency, estimated_savings, deadline, expanded, onToggle, onAsk, highlight }) {
  const tone = impactTone(urgency);

  if (loading) {
    return (
      <div className={`${CARD_BASE} p-3 sm:p-4 bg-white/[0.04]`}>
        <Skeleton className="h-4 w-5/6 mb-2" />
        <Skeleton className="h-3 w-24 mb-3" />
        <div className="mt-2 flex gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${CARD_BASE} relative p-3 sm:p-4 bg-white/[0.04] ${highlight ? "ring-1 ring-[rgba(var(--accent-rgb),0.35)]" : ""}`}
      style={highlight ? { boxShadow: "0 0 0 1px rgba(var(--accent-rgb),0.18), 0 0 22px rgba(var(--accent-rgb),0.10)" } : {}}
    >
      {highlight ? (
        <div className="absolute -top-2 left-3 text-[11px] px-2 py-0.5 rounded-full bg-[rgba(var(--accent-rgb),0.14)] border border-[rgba(var(--accent-rgb),0.4)] text-[rgba(var(--accent-rgb),0.95)]">
          Top priority
        </div>
      ) : null}

      <div className="flex items-start justify-between gap-2">
        <div className="text-sm text-white/90 leading-snug">
          {loading ? <Skeleton className="h-4 w-5/6" /> : <p className="line-clamp-3">{tip}</p>}
        </div>
        <ImpactPill level={urgency} />
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-white/70">
        <div className="inline-flex items-center gap-1">
          <CalendarClock className="h-3.5 w-3.5" />
          <span>{deadline || "No deadline"}</span>
        </div>
        {typeof estimated_savings === "number" ? (
          <span className="text-[13px] font-medium text-[rgba(var(--accent-rgb),0.95)] tabular-nums">
            {formatUSD(estimated_savings)}
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onAsk}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 border border-white/12 bg-white/5 hover:bg-white/10 text-[12px]"
        >
          <MessageCircle className="h-4 w-4" />
          Ask Bizzi
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 border border-white/10 text-[12px] hover:border-white/14"
        >
          {expanded ? "Hide details" : "View details"}
        </button>
      </div>

      {expanded && !loading ? (
        <p className="mt-2 text-[12px] text-white/75 leading-relaxed">
          Impact: {tone.description}
        </p>
      ) : null}
    </div>
  );
}

function ImpactPill({ level }) {
  const tone = impactTone(level);
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full ring-1 ring-inset ${tone.ring} ${tone.bg} ${tone.text}`}>
      {tone.label}
    </span>
  );
}

function impactTone(level) {
  if (level === "High") return { label: "High", bg: "bg-rose-500/15", text: "text-rose-300", ring: "ring-rose-400/25", description: "High impact—moves the needle fastest." };
  if (level === "Low") return { label: "Low", bg: "bg-emerald-500/15", text: "text-emerald-300", ring: "ring-emerald-400/25", description: "Low impact—keep on radar." };
  return { label: level || "Medium", bg: "bg-[rgba(var(--accent-rgb),0.12)]", text: "text-[rgba(var(--accent-rgb),0.95)]", ring: "ring-[rgba(var(--accent-rgb),0.28)]", description: "Medium impact—worth scheduling soon." };
}

function Skeleton({ className = "" }) {
  return <div className={`animate-pulse rounded-md bg-white/10 ${className}`} />;
}

function formatUSD(n) {
  return n?.toLocaleString?.(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }) ?? "—";
}
