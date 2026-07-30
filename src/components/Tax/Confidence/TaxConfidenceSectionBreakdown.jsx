import React from "react";
import { labelize } from "../Explanations/taxExplanationDisplay.js";

const SECTIONS = [
  ["profile", "Profile and entity"],
  ["transactionClassification", "Transaction classification"],
  ["deductions", "Deductions"],
  ["taxableIncome", "Taxable income"],
  ["projection", "Projection"],
  ["federal", "Federal"],
  ["selfEmployment", "Self-employment"],
  ["sCorp", "S-Corp"],
  ["state", "State"],
  ["payments", "Payments"],
  ["safeHarbor", "Safe harbor"],
  ["reserve", "Reserve"],
  ["freshness", "Data freshness"],
];

export default function TaxConfidenceSectionBreakdown({ confidence }) {
  const bySection = confidence?.confidenceBySection || {};
  const factors = confidence?.factors || [];
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Sections</div>
      <h3 className="mt-1 text-lg font-semibold text-white">Confidence by area</h3>
      <div className="mt-4 grid gap-2 md:grid-cols-2">
        {SECTIONS.map(([key, label]) => {
          const score = bySection[key] ?? findFactorScore(factors, key);
          return (
            <div key={key} className="rounded-xl border border-white/8 bg-black/18 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold text-white/82">{label}</div>
                <div className="text-sm text-white/68">{score == null ? "Not available" : `${Math.round(Number(score))}/100`}</div>
              </div>
              <div className="mt-1 text-xs text-white/46">{score == null ? "Backend did not provide a section score." : labelize(levelFor(score))}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function findFactorScore(factors, key) {
  const normalized = key.toLowerCase();
  const match = factors.find((factor) => `${factor.code || ""} ${factor.category || ""} ${factor.label || ""}`.toLowerCase().includes(normalized));
  return match?.score ?? null;
}

function levelFor(score) {
  if (score >= 85) return "high";
  if (score >= 60) return "medium";
  if (score > 0) return "low";
  return "unavailable";
}
