import React from "react";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader.jsx";

export default function ReconciledTransactions() {
  return (
    <div className="px-3 md:px-4 pt-0 pb-8 text-slate-100 min-h-screen">
      <ModuleHeader
        module="financials"
        title="Reconciled Transactions"
        subtitle="View transactions that have completed reconciliation."
        className="mb-4"
      />
      <div className="rounded-2xl border border-[var(--accent-line)] bg-[var(--panel)] px-4 py-4 shadow-lg">
        <p className="text-sm text-slate-200">
          Reconciled transactions will appear here. This page will list all transactions that have been fully
          reconciled. Stay tuned as we roll out the detailed view.
        </p>
      </div>
    </div>
  );
}
