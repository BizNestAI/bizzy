import React from "react";
import { dedupeByCode, labelize, severityBucket } from "../Explanations/taxExplanationDisplay.js";

const GROUPS = [
  ["blocking", "Blocking"],
  ["material", "Material"],
  ["deferred", "Deferred"],
  ["informational", "Informational"],
  ["resolved", "Resolved since prior run"],
];

export default function TaxWarningsPanel({ warnings = [], deferred = [], unsupported = [], resolved = [], onAction }) {
  const grouped = groupWarnings({ warnings, deferred, unsupported, resolved });
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Warnings</div>
      <h3 className="mt-1 text-lg font-semibold text-white">Warning center</h3>
      <div className="mt-4 space-y-3">
        {GROUPS.map(([key, label]) => grouped[key]?.length ? (
          <div key={key}>
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-white/42">{label}</div>
            <div className="space-y-2">
              {grouped[key].map((warning) => (
                <div key={warning.code || warning.message || warning.label} className="rounded-xl border border-white/8 bg-black/18 px-3 py-2">
                  <div className="text-sm font-semibold text-white/84">{warning.title || warning.label || labelize(warning.code)}</div>
                  <div className="mt-1 text-xs leading-relaxed text-white/54">{warning.message || warning.description || String(warning)}</div>
                  {warning.impact || warning.affectedOutput || warning.amount ? (
                    <div className="mt-1 text-[11px] text-white/38">Impact: {warning.impact || warning.affectedOutput || warning.amount}</div>
                  ) : null}
                  {warning.action?.label || warning.recommendedAction ? (
                    <button type="button" onClick={() => onAction?.(warning.action || { label: warning.recommendedAction })} className="mt-2 rounded-full border border-white/10 px-2.5 py-1 text-xs font-semibold text-white/62 hover:bg-white/10 hover:text-white">
                      {warning.action?.label || warning.recommendedAction}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null)}
      </div>
    </section>
  );
}

function groupWarnings({ warnings, deferred, unsupported, resolved }) {
  const out = { blocking: [], material: [], informational: [], deferred: [], resolved: dedupeByCode(resolved) };
  for (const warning of dedupeByCode(warnings)) out[severityBucket(warning)].push(warning);
  for (const item of dedupeByCode(deferred)) out.deferred.push(normalizeItem(item, "deferred"));
  for (const item of dedupeByCode(unsupported)) out.blocking.push(normalizeItem(item, "unsupported"));
  return out;
}

function normalizeItem(item, severity) {
  if (typeof item === "string") return { code: item, title: labelize(item), message: `${labelize(item)} is not currently included.`, severity };
  return { ...item, severity };
}
