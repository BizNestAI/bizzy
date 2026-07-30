import React from "react";
import { formatDate, formatMoney } from "./taxPlanningDisplay.js";

export default function TaxReserveCadence({ cadence }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-black/18 p-3">
      <div className="text-sm font-semibold text-white/86">Savings cadence</div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <Metric label="Weekly" value={formatMoney(cadence?.weeklySetAside)} />
        <Metric label="Biweekly" value={formatMoney(cadence?.biweeklySetAside)} />
        <Metric label="Monthly" value={formatMoney(cadence?.monthlySetAside)} />
        <Metric label="Target date" value={formatDate(cadence?.targetDate)} />
      </div>
      {!cadence?.targetDate ? <p className="mt-2 text-xs text-amber-50/72">Deadline-based cadence is unavailable.</p> : null}
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.12em] text-white/38">{label}</div>
      <div className="mt-1 font-semibold text-white/78">{value}</div>
    </div>
  );
}
