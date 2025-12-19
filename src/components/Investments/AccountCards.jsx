// src/components/Investments/AccountCards.jsx
import React from "react";
import BrokerageValueChart from "./BrokerageValueChart";
import AllocationDonut from "./AllocationDonut";

// darker/muted purple ring for Investments
const RING_PURPLE = "rgba(179,136,255,0.20)"; // #B388FF @20%

/**
 * AccountCards (compact, no CardHeader)
 * Props:
 *  - data: { accounts, total_balance_usd, allocation | asset_allocation }
 *  - minHeightChart?: number  (optional)
 *  - minHeightAllocation?: number  (optional)
 *  - className?: string
 */
export default function AccountCards({
  data,
  minHeightChart,
  minHeightAllocation,
  className = "",
}) {
  const accounts = data?.accounts || [];
  const totalUSD = Number(data?.total_balance_usd || 0);
  const allocation = data?.allocation || data?.asset_allocation || null;

  return (
    <div className={`space-y-4 ${className}`} aria-label="Investments overview">
      {/* Brokerage chart with account toggle (compact label) */}
      <section
        className="rounded-2xl p-3 sm:p-4 border"
        style={{
          borderColor: RING_PURPLE,
          background: "#0f1012", // flat surface like Financials
          boxShadow: "0 10px 24px rgba(0,0,0,.22)",
          ...(typeof minHeightChart === "number" ? { minHeight: minHeightChart } : {}),
        }}
      >
        <div className="text-[12px] uppercase tracking-wide text-white/60 mb-2">
          Brokerage Investment Value
        </div>
        <BrokerageValueChart accounts={accounts} totalUSD={totalUSD} />
      </section>

      {/* Aggregated allocation donut (compact label) */}
      {!!allocation && (
        <section
          className="rounded-2xl p-3 sm:p-4 border"
          style={{
            borderColor: RING_PURPLE,
            background: "#0f1012",
            boxShadow: "0 10px 24px rgba(0,0,0,.22)",
            ...(typeof minHeightAllocation === "number" ? { minHeight: minHeightAllocation } : {}),
          }}
        >
       
          <AllocationDonut allocation={allocation} totalUSD={totalUSD} />
        </section>
      )}
    </div>
  );
}
