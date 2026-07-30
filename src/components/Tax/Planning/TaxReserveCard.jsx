import React from "react";
import TaxAffordabilityNotice from "./TaxAffordabilityNotice.jsx";
import TaxReserveAccountPicker from "./TaxReserveAccountPicker.jsx";
import TaxReserveCadence from "./TaxReserveCadence.jsx";
import { formatDateTime, formatMoney, labelize, safeAccountLabel } from "./taxPlanningDisplay.js";

export default function TaxReserveCard({
  reserve,
  accounts,
  loading,
  saving,
  onCreateAccount,
  onSetPrimary,
  onRefreshAccount,
  onDeactivateAccount,
}) {
  const reserveSummary = reserve?.reserve || reserve || {};
  const account = reserve?.account || accounts?.find((row) => row.isPrimary) || null;
  const currentReserve = reserveSummary.currentReserve;
  const recommended = reserveSummary.recommendedReserve ?? reserve?.recommendedReserve ?? null;
  const gap = reserveSummary.reserveGap ?? reserve?.reserveGap ?? null;
  const surplus = reserveSummary.surplusAmount ?? (gap == null ? null : Math.max(0, -gap));
  const immediateTransfer = reserveSummary.immediateTransferRecommended ?? null;
  const status = reserve?.status || (account ? "unavailable" : "setup_incomplete");
  const warnings = reserve?.warnings || [];
  const fundedPct = percent(currentReserve, recommended);

  return (
    <section className="rounded-[20px] border border-white/10 bg-white/[0.05] p-4 shadow-[0_18px_48px_rgba(0,0,0,0.32)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Tax reserve</div>
          <h2 className="mt-1 text-lg font-semibold text-white">
            {currentReserve != null && recommended != null ? `${formatMoney(currentReserve)} of ${formatMoney(recommended)} saved` : labelize(status)}
          </h2>
          <p className="mt-1 text-sm text-white/54">
            {account ? `${safeAccountLabel(account)} • verified ${formatDateTime(reserveSummary.lastVerifiedAt || account.lastVerifiedAt || account.updatedAt)}` : "Not connected. No reserve account selected."}
          </p>
        </div>
        {loading ? <span className="text-xs text-white/48">Loading...</span> : null}
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-white/58">{fundedPct == null ? "Reserve progress unavailable" : `${fundedPct}% funded`}</span>
          <span className="font-semibold text-white">{gap == null ? "Gap not available" : `Gap: ${formatMoney(Math.max(0, gap))}`}</span>
        </div>
        <div className="mt-2 h-3 overflow-hidden rounded-full bg-white/[0.08]">
          <div className="h-full rounded-full bg-emerald-300/75 transition-[width] duration-500" style={{ width: `${Math.min(100, Math.max(0, fundedPct || 0))}%` }} />
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Metric label="Recommended reserve" value={formatMoney(recommended)} />
        <Metric label="Immediate transfer" value={formatMoney(immediateTransfer)} />
        <Metric label="Next contribution" value={formatMoney(reserve?.cadence?.nextContributionAmount)} />
        <Metric label="Next payment amount" value={formatMoney(reserve?.liability?.nextPaymentAmount)} />
        <Metric label="Next payment date" value={reserve?.liability?.nextPaymentDate ? reserve.liability.nextPaymentDate : "Not available"} />
        <Metric label={surplus > 0 ? "Reserve surplus" : "Reserve gap"} value={surplus > 0 ? formatMoney(surplus) : formatMoney(gap)} />
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

      <div className="mt-4 space-y-3">
        <TaxAffordabilityNotice reserve={reserve} />
        <TaxReserveCadence cadence={reserve?.cadence} />
        <TaxReserveAccountPicker
          accounts={accounts}
          saving={saving}
          onSetPrimary={onSetPrimary}
          onCreateManual={onCreateAccount}
          onRefresh={onRefreshAccount}
          onDeactivate={onDeactivateAccount}
        />
      </div>
    </section>
  );
}

function percent(value, target) {
  if (value == null || target == null || Number(target) <= 0) return null;
  return Math.round((Number(value) / Number(target)) * 100);
}

function Metric({ label, value }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-black/18 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-white/42">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-white/88">{value}</div>
    </div>
  );
}
