import React from "react";
import { formatMoney, formatPercent, labelize, normalizeList } from "./taxExplanationDisplay.js";

const CHANGE_LABELS = {
  projectedTotalTax: "Projected total tax",
  taxableIncome: "Taxable income",
  federalTax: "Federal tax",
  seTax: "Self-employment tax",
  stateTax: "State tax",
  reserveRecommendation: "Reserve target",
  confidence: "Confidence",
  remainingLiability: "Remaining liability",
};

export default function TaxRunChangesPanel({ changes }) {
  const changeRows = Object.entries(changes?.changes || {});
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Run changes</div>
      <h3 className="mt-1 text-lg font-semibold text-white">{changes?.materialChange ? "Material changes since prior run" : "No material changes"}</h3>
      <div className="mt-4 space-y-2">
        {changeRows.length ? changeRows.map(([key, row]) => (
          <div key={key} className="rounded-xl border border-white/8 bg-black/18 px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold text-white/82">{CHANGE_LABELS[key] || labelize(key)}</div>
              <div className={`text-sm tabular-nums ${row.material ? "text-amber-50" : "text-white/58"}`}>{formatChange(key, row)}</div>
            </div>
            <div className="mt-1 text-xs text-white/42">Previous {formatValue(key, row.previous)} → Current {formatValue(key, row.current)}</div>
          </div>
        )) : <div className="text-sm text-white/52">No prior-run comparison is available.</div>}
      </div>
      {normalizeList(changes?.changedWarnings).length || normalizeList(changes?.resolvedWarnings).length ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <WarningList title="New warnings" warnings={changes.changedWarnings} />
          <WarningList title="Resolved warnings" warnings={changes.resolvedWarnings} />
        </div>
      ) : null}
    </section>
  );
}

function WarningList({ title, warnings }) {
  return (
    <div className="rounded-xl border border-white/8 bg-black/18 px-3 py-2">
      <div className="text-sm font-semibold text-white/82">{title}</div>
      <div className="mt-2 space-y-1">
        {normalizeList(warnings).length ? normalizeList(warnings).map((warning) => (
          <div key={warning.code || warning.message} className="text-xs text-white/52">{warning.message || warning.code || String(warning)}</div>
        )) : <div className="text-xs text-white/38">None</div>}
      </div>
    </div>
  );
}

function formatChange(key, row = {}) {
  if (key === "confidence") return `${row.absoluteChange > 0 ? "+" : ""}${Math.round(Number(row.absoluteChange || 0))} pts`;
  return `${row.absoluteChange > 0 ? "+" : ""}${formatMoney(row.absoluteChange, "$0")}`;
}

function formatValue(key, value) {
  if (key === "confidence") return `${Math.round(Number(value || 0))}/100`;
  if (String(key).toLowerCase().includes("percent")) return formatPercent(value);
  return formatMoney(value, "$0");
}
