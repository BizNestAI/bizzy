import React from "react";

export default function TaxSafeHarborCard({ safeHarbor }) {
  const status = safeHarbor?.status || "unavailable";
  const unavailable = status === "unavailable";
  const partial = status === "partial";

  return (
    <section className="rounded-[20px] border border-white/10 bg-white/[0.05] p-4 shadow-[0_18px_48px_rgba(0,0,0,0.32)]">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Safe harbor</div>
      <h2 className="mt-1 text-lg font-semibold text-white">
        {unavailable ? "Estimate unavailable" : partial ? "Partial target" : "Payment target"}
      </h2>
      {unavailable ? (
        <p className="mt-3 text-sm leading-relaxed text-white/68">
          Safe-harbor estimate unavailable. {safeHarbor?.warning?.message || "Add prior-year tax and payment details to calculate a target."}
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <Metric label="Method" value={labelize(safeHarbor?.method)} />
          <Metric label="Required annual" value={formatCurrency(safeHarbor?.requiredAnnual)} />
          <Metric label="Covered" value={formatCurrency(safeHarbor?.coveredAmount)} />
          <Metric label="Remaining" value={formatCurrency(safeHarbor?.remainingAmount)} />
          <Metric label="Next due" value={formatDate(safeHarbor?.nextDueDate)} />
          <Metric label="Next amount" value={formatCurrency(safeHarbor?.nextPaymentAmount)} />
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-black/18 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-white/42">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-white/88">{value}</div>
    </div>
  );
}

function formatCurrency(value) {
  if (value == null || Number.isNaN(Number(value))) return "Not available";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value));
}

function formatDate(value) {
  if (!value) return "Not available";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function labelize(value) {
  return value ? String(value).replaceAll("_", " ") : "Not available";
}
