import React from "react";
import { Plus } from "lucide-react";
import { bucketValue, formatMoney } from "./taxPlanningDisplay.js";

const BUCKETS = [
  ["estimatedPayments", "Estimated payments"],
  ["withholding", "Withholding"],
  ["extensionPayments", "Extension payments"],
  ["priorYearCredits", "Prior-year credits"],
  ["refundApplied", "Refunds applied"],
  ["balanceDuePayments", "Balance-due payments"],
  ["otherPayments", "Other"],
];

export default function TaxPaymentsCard({ payments, remainingLiability, loading, onRecord }) {
  const federal = payments?.federal || {};
  const state = payments?.state || {};
  const totals = payments?.totals || {};
  const warnings = payments?.reconciliationWarnings || payments?.warnings || [];
  const pendingCount = (payments?.rows || []).filter((row) => ["needs_review", "pending_review"].includes(String(row.status || "").toLowerCase())).length;
  const withholding = bucketValue(federal, "withholding") + bucketValue(state, "withholding");
  const credits = bucketValue(federal, "priorYearCredits") + bucketValue(state, "priorYearCredits") + bucketValue(federal, "refundApplied") + bucketValue(state, "refundApplied");

  return (
    <section id="tax-payments-summary" className="rounded-[20px] border border-white/10 bg-white/[0.05] p-4 shadow-[0_18px_48px_rgba(0,0,0,0.32)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Tax payments</div>
          <h2 className="mt-1 text-lg font-semibold text-white">Confirmed payments and credits</h2>
          <p className="mt-1 text-sm text-white/54">Only confirmed compatible records reduce remaining liability; candidates stay pending until reviewed.</p>
        </div>
        <button type="button" onClick={onRecord} className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200/22 bg-emerald-300/[0.12] px-3 py-1.5 text-xs font-semibold text-emerald-50 hover:bg-emerald-300/[0.18] focus:outline-none focus:ring-2 focus:ring-emerald-300/35">
          <Plus className="h-3.5 w-3.5" />
          Record tax payment
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Confirmed applied" value={formatMoney(totals.totalPaidAndWithheld)} loading={loading} />
        <Metric label="Pending review" value={loading ? "Loading..." : String(pendingCount)} loading={false} />
        <Metric label="Withholding" value={formatMoney(withholding)} loading={loading} />
        <Metric label="Credits" value={formatMoney(credits)} loading={loading} />
        <Metric label="Projected balance" value={formatMoney(remainingLiability)} loading={loading} />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <JurisdictionBreakdown title="Federal" summary={federal} />
        <JurisdictionBreakdown title="State" summary={state} />
      </div>

      {warnings.length ? (
        <div className="mt-4 space-y-2">
          {warnings.slice(0, 2).map((warning, index) => (
            <div key={warning.code || index} className="rounded-2xl border border-amber-300/18 bg-amber-300/[0.06] px-3 py-2 text-xs text-amber-50/82">
              {warning.message || warning.code}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function JurisdictionBreakdown({ title, summary }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-black/18 p-3">
      <div className="text-sm font-semibold text-white/86">{title}</div>
      <div className="mt-3 space-y-2">
        {BUCKETS.map(([key, label]) => (
          <div key={key} className="flex items-center justify-between gap-3 text-xs">
            <span className="text-white/48">{label}</span>
            <span className="tabular-nums text-white/78">{formatMoney(bucketValue(summary, key), "Not available")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value, loading }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-black/18 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-white/42">{label}</div>
      <div className="mt-1 text-sm font-semibold text-white/88">{loading ? "Loading..." : value}</div>
    </div>
  );
}
