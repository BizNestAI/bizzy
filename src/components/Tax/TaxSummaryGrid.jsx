import React from "react";
import TaxSummaryCard from "./TaxSummaryCard.jsx";

export default function TaxSummaryGrid({ metrics, loading = false }) {
  return (
    <section aria-labelledby="tax-summary-heading" className="space-y-3">
      <h2 id="tax-summary-heading" className="sr-only">Tax summary</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <TaxSummaryCard key={metric.label} loading={loading} {...metric} />
        ))}
      </div>
    </section>
  );
}
