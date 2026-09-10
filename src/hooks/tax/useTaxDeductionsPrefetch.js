import { useEffect } from "react";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";
import { prefetchTaxDeductionsOverviewBundle } from "../../services/tax/taxApiClient.js";

export function TaxDeductionsPrefetcher({ businessId, loading = false, year = new Date().getFullYear() }) {
  useTaxDeductionsPrefetch({ businessId, loading, year });
  return null;
}

export function useTaxDeductionsPrefetch({ businessId, loading = false, year = new Date().getFullYear(), enabled = true } = {}) {
  useEffect(() => {
    if (!enabled || loading || !businessId || shouldUseDemoData()) return undefined;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      prefetchTaxDeductionsOverviewBundle({ businessId, year }).catch(() => {});
    };
    const idle = scheduleIdle(run);
    return () => {
      cancelled = true;
      cancelIdle(idle);
    };
  }, [businessId, enabled, loading, year]);
}

function scheduleIdle(callback) {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    return { type: "idle", id: window.requestIdleCallback(callback, { timeout: 1500 }) };
  }
  if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
    return { type: "timeout", id: window.setTimeout(callback, 0) };
  }
  callback();
  return { type: "sync", id: null };
}

function cancelIdle(handle) {
  if (!handle || typeof window === "undefined") return;
  if (handle.type === "idle" && typeof window.cancelIdleCallback === "function") {
    window.cancelIdleCallback(handle.id);
  } else if (handle.type === "timeout" && typeof window.clearTimeout === "function") {
    window.clearTimeout(handle.id);
  }
}

export default useTaxDeductionsPrefetch;
