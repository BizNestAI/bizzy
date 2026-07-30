import React from "react";
import { formatDate, labelize, normalizeList } from "../Explanations/taxExplanationDisplay.js";

export default function TaxSourceFreshnessPanel({ sourceFreshness }) {
  const rows = normalizeFreshness(sourceFreshness);
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Source freshness</div>
      <h3 className="mt-1 text-lg font-semibold text-white">Connected data status</h3>
      <div className="mt-4 grid gap-2 md:grid-cols-2">
        {rows.length ? rows.map((row) => (
          <div key={row.code} className="rounded-xl border border-white/8 bg-black/18 px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold text-white/82">{row.label}</div>
              <div className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-white/58">{labelize(row.status)}</div>
            </div>
            <div className="mt-1 text-xs text-white/46">Last seen: {formatDate(row.lastSeenAt || row.date || row.updatedAt)}</div>
          </div>
        )) : <div className="text-sm text-white/52">Source freshness is unknown.</div>}
      </div>
    </section>
  );
}

function normalizeFreshness(sourceFreshness) {
  if (!sourceFreshness) return [];
  if (Array.isArray(sourceFreshness.sources)) return sourceFreshness.sources;
  if (Array.isArray(sourceFreshness.staleSources)) return sourceFreshness.staleSources;
  if (Array.isArray(sourceFreshness)) return sourceFreshness;
  return Object.entries(sourceFreshness || {})
    .filter(([, value]) => value && typeof value === "object")
    .map(([code, value]) => ({
      code,
      label: value.label || labelize(code),
      status: value.status || value.freshness || "unknown",
      lastSeenAt: value.lastSeenAt || value.lastUpdatedAt || value.date,
    }))
    .concat(normalizeList(sourceFreshness.staleSources));
}
