import React, { useState } from "react";
import TaxPaymentsCard from "./TaxPaymentsCard.jsx";
import TaxPaymentHistory from "./TaxPaymentHistory.jsx";
import RecordTaxPaymentModal from "./RecordTaxPaymentModal.jsx";
import TaxSafeHarborSummary from "./TaxSafeHarborSummary.jsx";
import { useTaxPayments } from "../../../hooks/tax/useTaxPayments.js";

export default function TaxPlanningPanel({
  businessId,
  year,
  overview,
  onRefreshOverview,
  onAskBizzy,
}) {
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const payments = useTaxPayments({ businessId, year, enabled: Boolean(businessId) });
  const overviewPayments = overview?.payments || payments.payments || {};
  const remainingLiability = overview?.summary?.remainingProjectedLiability ?? overview?.liability?.remainingProjectedLiability ?? null;

  const refreshPlanning = async () => {
    await Promise.allSettled([
      payments.refetch(),
      onRefreshOverview?.(),
    ]);
  };

  const savePayment = async (payment) => {
    await payments.createPayment(payment);
    setPaymentModalOpen(false);
    await refreshPlanning();
  };

  const voidPayment = async (row) => {
    if (!window.confirm("Void this tax payment record? The history entry is not hard-deleted.")) return;
    await payments.voidPayment(row.id, "Voided from Tax Planning UI.");
    await refreshPlanning();
  };

  return (
    <section className="space-y-5" aria-labelledby="tax-planning-heading">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-[12px] uppercase tracking-[0.14em] text-white/52">Planning</div>
          <h2 id="tax-planning-heading" className="text-xl font-semibold text-white">Payments and safe harbor</h2>
          <p className="mt-1 max-w-2xl text-sm text-white/54">
            Track recorded tax payments and safe-harbor coverage without changing the projected obligation.
          </p>
        </div>
        <button type="button" onClick={() => onAskBizzy?.("How should I think about safe-harbor tax payments?", { module: "tax", surface: "planning" })} className="self-start rounded-full border border-white/12 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/64 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/35">
          Why?
        </button>
      </div>

      <div className="space-y-5">
        <TaxPaymentsCard payments={overviewPayments} remainingLiability={remainingLiability} loading={payments.loading} onRecord={() => setPaymentModalOpen(true)} />
        <TaxSafeHarborSummary safeHarbor={overview?.safeHarbor} />
      </div>

      <TaxPaymentHistory rows={payments.rows} loading={payments.loading} onVoid={voidPayment} />

      {payments.error ? (
        <div role="alert" className="rounded-[20px] border border-rose-300/22 bg-rose-400/[0.075] px-4 py-3 text-sm text-rose-50">
          {payments.error?.message || "Tax planning data failed to load."}
        </div>
      ) : null}

      <RecordTaxPaymentModal
        open={paymentModalOpen}
        year={year}
        saving={payments.saving}
        existingRows={payments.rows}
        projectedRemainingLiability={remainingLiability}
        onClose={() => setPaymentModalOpen(false)}
        onSave={savePayment}
      />
    </section>
  );
}
