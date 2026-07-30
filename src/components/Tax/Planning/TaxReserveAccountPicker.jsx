import React, { useState } from "react";
import { formatDateTime, formatMoney, labelize, safeAccountLabel } from "./taxPlanningDisplay.js";

export default function TaxReserveAccountPicker({
  accounts = [],
  saving,
  onSetPrimary,
  onCreateManual,
  onRefresh,
  onDeactivate,
}) {
  const [manualName, setManualName] = useState("Tax reserve");
  const [manualBalance, setManualBalance] = useState("");
  const canCreateManual = manualName.trim() && manualBalance !== "" && Number(manualBalance) >= 0;

  return (
    <section className="rounded-2xl border border-white/8 bg-black/18 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-white/86">Reserve account</div>
          <p className="mt-1 text-xs text-white/48">Choose one account explicitly. Full account numbers are never shown.</p>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {accounts.length ? accounts.map((account) => (
          <div key={account.id} className="rounded-xl border border-white/10 bg-white/[0.035] px-3 py-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="font-semibold text-white/84">{safeAccountLabel(account)}</div>
                <div className="mt-1 text-xs text-white/46">
                  {labelize(account.trackingMethod)} • {account.currentBalance == null && account.manualBalance == null ? "Balance unavailable" : formatMoney(account.currentBalance ?? account.manualBalance)} • verified {formatDateTime(account.lastVerifiedAt || account.updatedAt)}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {account.isPrimary ? <span className="rounded-full border border-emerald-200/18 bg-emerald-300/[0.08] px-2.5 py-1 text-xs text-emerald-50/78">Primary</span> : (
                  <button type="button" disabled={saving} onClick={() => onSetPrimary?.(account.id)} className="rounded-full border border-white/10 bg-black/18 px-2.5 py-1 text-xs font-semibold text-white/62 hover:bg-white/10 hover:text-white disabled:opacity-50">
                    Set primary
                  </button>
                )}
                <button type="button" disabled={saving} onClick={() => onRefresh?.(account.id)} className="rounded-full border border-white/10 bg-black/18 px-2.5 py-1 text-xs font-semibold text-white/62 hover:bg-white/10 hover:text-white disabled:opacity-50">
                  Refresh
                </button>
                <button type="button" disabled={saving} onClick={() => onDeactivate?.(account.id)} className="rounded-full border border-white/10 bg-black/18 px-2.5 py-1 text-xs font-semibold text-white/48 hover:bg-white/10 hover:text-white disabled:opacity-50">
                  Deactivate
                </button>
              </div>
            </div>
          </div>
        )) : (
          <div className="rounded-xl border border-amber-300/18 bg-amber-300/[0.06] px-3 py-2 text-sm text-amber-50/82">
            No reserve account selected. Current reserve is not connected, not zero.
          </div>
        )}
      </div>
      <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-white/42">Manual tracker</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_140px_auto]">
          <label className="sr-only" htmlFor="manual-reserve-name">Manual reserve name</label>
          <input id="manual-reserve-name" value={manualName} onChange={(event) => setManualName(event.target.value)} className="rounded-xl border border-white/10 bg-[#0f1115] px-3 py-2 text-xs text-white outline-none focus:ring-2 focus:ring-emerald-300/35" />
          <label className="sr-only" htmlFor="manual-reserve-balance">Manual reserve balance</label>
          <input id="manual-reserve-balance" type="number" min="0" value={manualBalance} onChange={(event) => setManualBalance(event.target.value)} placeholder="Balance" className="rounded-xl border border-white/10 bg-[#0f1115] px-3 py-2 text-xs text-white outline-none focus:ring-2 focus:ring-emerald-300/35" />
          <button
            type="button"
            disabled={saving || !canCreateManual}
            onClick={() => onCreateManual?.({ trackingMethod: "manual", displayName: manualName.trim(), manualBalance: Number(manualBalance), isPrimary: true, lastVerifiedAt: new Date().toISOString() })}
            className="rounded-full border border-emerald-200/22 bg-emerald-300/[0.12] px-3 py-2 text-xs font-semibold text-emerald-50 hover:bg-emerald-300/[0.18] disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </div>
    </section>
  );
}
