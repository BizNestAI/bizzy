// src/components/Tax/TaxSuggestions.jsx
import React, { useState } from "react";
import { Info, RefreshCw, MessageCircle } from "lucide-react";
import CardHeader from "../ui/CardHeader";
import { useTaxInsights } from "../../hooks/useTaxInsights";

const GOLD_MUTED = "rgba(227,194,92,1)";

export default function TaxSuggestions({ businessId, watchKey, onAskBizzy, title = "BIZZI’S TAX SUGGESTIONS" }) {
  const { tips, loading, error, refetch } = useTaxInsights({ businessId, watchKey });
  const [expanded, setExpanded] = useState(null);

  const rows = tips && tips.length ? tips : Array.from({ length: 3 }, () => ({ loading: true }));

  return (
    <div className="w-full min-w-0">
      {/* Unified compact header */}
      <CardHeader
        title={title}
        size="sm"
        dense
        className="mb-2"
        titleClassName="text-[13px]"
        right={
          <button
            type="button"
            onClick={refetch}
            className="text-[12px] inline-flex items-center gap-1.5 px-2 py-1 rounded-md ring-1 ring-inset ring-white/12 hover:bg-white/10"
          >
            {loading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </button>
        }
      />

      {/* Glass body */}
      <div className="rounded-xl p-3 sm:p-4 bg-white/5 backdrop-blur-sm ring-1 ring-inset ring-white/10">
        {error && <div className="text-xs text-rose-300 mb-3">{error}</div>}

        <div className="space-y-3">
          {rows.map((t, i) => (
            <SuggestionRow
              key={i}
              loading={!!t.loading}
              tip={t.tip}
              urgency={t.urgency}
              estimated={t.estimated_savings}
              deadline={t.deadline}
              reasoning={t.reasoning}
              expanded={expanded === i}
              onToggle={() => setExpanded(expanded === i ? null : i)}
              onAsk={() => onAskBizzy?.("Does this apply to me right now?", { tip: t })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/* -------------------- Row -------------------- */

function SuggestionRow({ loading, tip, urgency, estimated, deadline, reasoning, expanded, onToggle, onAsk }) {
  return (
    <div className="rounded-lg p-3 bg-white/4 ring-1 ring-inset ring-white/10 hover:bg-white/6 transition">
    {/* Top line */}
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm text-white/90 leading-snug">
          {loading ? <Skeleton className="h-4 w-5/6" /> : <p className="line-clamp-2">{tip}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!loading && <UrgencyPill level={urgency} />}
          {!loading && typeof estimated === "number" && (
            <span className="text-xs font-medium text-emerald-400 tabular-nums">
              {formatUSD(estimated)}
            </span>
          )}
        </div>
      </div>

      {/* Meta / actions */}
      {!loading ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-white/70">
          <div className="inline-flex items-center gap-1">
            <Info className="h-3.5 w-3.5" />
            <span>{deadline || "Ongoing"}</span>
          </div>
          <div className="inline-flex gap-1.5">
            <button
              type="button"
              onClick={onToggle}
              className="px-2 py-1 rounded-md ring-1 ring-inset ring-white/12 hover:bg-white/10"
            >
              {expanded ? "Hide" : "Learn more"}
            </button>
            <button
              type="button"
              onClick={onAsk}
              className="px-2 py-1 rounded-md inline-flex items-center gap-1 ring-1 ring-inset ring-white/12 hover:bg-white/10"
            >
              <MessageCircle className="h-3.5 w-3.5" />
              Ask Bizzi
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-6 w-24" />
        </div>
      )}

      {/* Expanded body */}
      {expanded && !loading && reasoning && (
        <div className="mt-2 text-xs text-white/80 leading-relaxed">{reasoning}</div>
      )}
    </div>
  );
}

/* -------------------- Small atoms -------------------- */

function UrgencyPill({ level }) {
  // toned down palette to avoid harsh yellow
  const map = {
    High: "bg-rose-500/15 text-rose-300 ring-rose-400/25",
    Medium: "bg-[rgba(227,194,92,.12)] text-[rgba(227,194,92,.95)] ring-[rgba(227,194,92,.28)]",
    Low: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/25",
  };
  const cls = map[level] || map.Medium;
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full ring-1 ring-inset ${cls}`}>
      {level || "Medium"}
    </span>
  );
}

function Skeleton({ className = "" }) {
  return <div className={`animate-pulse rounded-md bg-white/10 ${className}`} />;
}

function formatUSD(n) {
  return n?.toLocaleString?.(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }) ?? "—";
}
