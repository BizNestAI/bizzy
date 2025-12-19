// File: /src/components/Accounting/AffordabilityInsightCard.jsx
import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  MessageCircle,
} from 'lucide-react';

const RISK_META = {
  negative_month: {
    label: 'Negative month',
    explain: 'At least one of the next 6 months goes negative after this expense.',
    severity: 'high',
  },
  ending_cash_below_zero: {
    label: 'Ending cash below $0',
    explain: 'Ending cash after the horizon would drop below zero.',
    severity: 'high',
  },
  low_ending_cash: {
    label: 'Low ending cash',
    explain: 'Baseline lowest ending cash in the horizon is below zero.',
    severity: 'high',
  },
  high_impact_vs_net: {
    label: 'High impact vs net cash',
    explain: 'The monthly expense is large relative to average monthly net cash (≥ ~50%).',
    severity: 'medium',
  },
  large_one_time: {
    label: 'Large one-time expense',
    explain: 'One-time cost exceeds ~25% of your current cash buffer.',
    severity: 'medium',
  },
};

const severityStyles = {
  high:   'border-rose-300/25 bg-rose-500/10 text-rose-300',
  medium: 'border-amber-300/25 bg-amber-500/10 text-amber-300',
  low:    'border-white/15 bg-white/5 text-white/80',
};

const verdictStyles = {
  Yes: {
    text: 'text-emerald-300',
    chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-300/20',
    icon: <CheckCircle2 size={18} className="text-emerald-300" />,
  },
  No: {
    text: 'text-rose-300',
    chip: 'bg-rose-500/15 text-rose-300 border-rose-300/20',
    icon: <XCircle size={18} className="text-rose-300" />,
  },
  Depends: {
    text: 'text-amber-300',
    chip: 'bg-amber-500/15 text-amber-300 border-amber-300/20',
    icon: <AlertTriangle size={18} className="text-amber-300" />,
  },
};

const currency = (n) =>
  typeof n === 'number'
    ? n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '-';

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="text-xs text-white/60">{label}</div>
      <div className="mt-1 text-base font-semibold">{value}</div>
    </div>
  );
}

export default function AffordabilityInsightCard({ result, metaLabel }) {
  if (!result) return null;

  const {
    verdict = 'Depends',
    rationale = '',
    reasons = [], // optional list of short bullets (if present)
    impactSummary = {},
    recommendations = [],
    confidence,        // 0..1
    risk_flags = [],   // array of keys
    recommendation,    // legacy shape: { suggestedTiming, note }
  } = result || {};

  const {
    monthlyExpenseImpact,
    oneTimeImpact,
    monthsReviewed,
    endCashAfterHorizon,
    // legacy fields (graceful support)
    netCashAfterExpense,
    potentialCashShortfall,
    burnRateImpact,
  } = impactSummary || {};

  // Normalize recs if the old shape is present
  const normalizedRecs =
    Array.isArray(recommendations) && recommendations.length
      ? recommendations
      : [
          recommendation?.suggestedTiming ? `Suggested timing: ${recommendation.suggestedTiming}` : null,
          recommendation?.note ? `Note: ${recommendation.note}` : null,
        ].filter(Boolean);

  const s = verdictStyles[verdict] || verdictStyles.Depends;

  // ✅ local state for which risk chip is active (must be at top-level, not inside JSX)
  const [activeRisk, setActiveRisk] = useState(
    Array.isArray(risk_flags) && risk_flags.length ? risk_flags[0] : null
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="rounded-2xl border border-white/10 bg-zinc-900 p-5 text-white shadow-lg"
    >
      {/* Header */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {s.icon}
          <h3 className={`text-lg font-semibold ${s.text}`}>Verdict: {verdict}</h3>
        </div>
        {metaLabel ? (
          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-white/70">
            {metaLabel}
          </span>
        ) : null}
      </div>

      {/* Rationale */}
      {rationale && <p className="mb-4 text-sm text-white/80">{rationale}</p>}

      {/* Optional: Why Bizzy decided this */}
      {Array.isArray(reasons) && reasons.length > 0 && (
        <div className="mb-4 rounded-xl border border-white/10 bg-white/5 p-4">
          <p className="mb-2 text-sm font-medium text-white/70">Why Bizzy decided this</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-white/80">
            {reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      {/* Impact Summary */}
      <div className="rounded-xl border border-white/10 bg-white/5 p-4">
        <p className="mb-2 text-sm font-medium text-white/70">Impact Summary</p>

        {(monthlyExpenseImpact != null ||
          oneTimeImpact != null ||
          monthsReviewed != null ||
          endCashAfterHorizon != null) && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Monthly impact" value={currency(Number(monthlyExpenseImpact || 0))} />
            <Stat label="One-time" value={currency(Number(oneTimeImpact || 0))} />
            <Stat label="Months reviewed" value={Number(monthsReviewed || 0)} />
            <Stat label="Ending cash (after)" value={currency(Number(endCashAfterHorizon || 0))} />
          </div>
        )}

        {(netCashAfterExpense != null ||
          potentialCashShortfall != null ||
          burnRateImpact != null) && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-white/80">
            {netCashAfterExpense != null && <li>Net Cash After Expense: {currency(Number(netCashAfterExpense || 0))}</li>}
            {potentialCashShortfall != null && (
              <li>Potential Cash Shortfall: {potentialCashShortfall ? 'Yes' : 'No'}</li>
            )}
            {burnRateImpact != null && <li>Burn Rate Impact: {burnRateImpact}</li>}
          </ul>
        )}
      </div>

      {/* Recommendations + confidence */}
      <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium text-white/70">Recommendations</p>
          {typeof confidence === 'number' && (
            <span className={`rounded-full border px-2.5 py-1 text-xs ${s.chip}`}>
              Confidence: {Math.round(confidence * 100)}%
            </span>
          )}
        </div>

        {normalizedRecs.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-white/80">
            {normalizedRecs.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : (
          <div className="flex items-center gap-2 text-sm text-white/60">
            <MessageCircle size={16} className="opacity-70" />
            No specific recommendations—looks straightforward.
          </div>
        )}

        {/* Risks & considerations */}
        {Array.isArray(risk_flags) && risk_flags.length > 0 && (
          <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium text-white/70">Risks &amp; considerations</p>
            </div>

            <div className="flex flex-wrap gap-2">
              {risk_flags.map((key, i) => {
                const meta = RISK_META[key] || { label: key.replace(/_/g, ' '), explain: 'No details available.', severity: 'low' };
                const pressed = activeRisk === key;
                return (
                  <button
                    type="button"
                    key={`${key}-${i}`}
                    onClick={() => setActiveRisk(key)}
                    aria-pressed={pressed}
                    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition
                      ${severityStyles[meta.severity]} ${pressed ? 'ring-1 ring-white/20' : 'hover:bg-white/10'}`}
                  >
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-70" />
                    {meta.label}
                  </button>
                );
              })}
            </div>

            {/* explanation panel for the selected chip */}
            {activeRisk && (
              <div className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3 text-sm text-white/80">
                <div className="font-medium">
                  {(RISK_META[activeRisk] && RISK_META[activeRisk].label) || activeRisk.replace(/_/g, ' ')}
                </div>
                <div className="mt-1">
                  {(RISK_META[activeRisk] && RISK_META[activeRisk].explain) || 'No additional details available.'}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
