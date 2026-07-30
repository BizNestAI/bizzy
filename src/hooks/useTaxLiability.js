// Transitional compatibility facade. New Tax Desk components should use
// src/hooks/tax/useTaxOverview.js directly.
import { useMemo } from "react";
import { adaptTaxOverviewForLegacyDashboard } from "../services/tax/taxApiClient.js";
import { useTaxOverview } from "./tax/useTaxOverview.js";

export function useTaxLiability(businessId, { year = new Date().getFullYear() } = {}) {
  const overview = useTaxOverview({ businessId, year });

  const data = useMemo(() => {
    if (!overview.data) return null;
    if (overview.isDemo && overview.data?.legacy) return buildDemoCompatibilityPayload(overview.data.legacy);
    return adaptTaxOverviewForLegacyDashboard(overview.data);
  }, [overview.data, overview.isDemo]);

  return {
    data,
    loading: overview.loading,
    error: overview.error?.message || "",
    refetch: overview.refetch,
    refreshCalculation: overview.refreshCalculation,
  };
}

function buildDemoCompatibilityPayload(tax = {}) {
  return {
    trend: Array.isArray(tax.trend) ? tax.trend.slice(-12) : [],
    quarterly: tax.quarterly || [],
    cashFlowOverlay: Array.isArray(tax.cashFlowOverlay) ? tax.cashFlowOverlay.slice(-12) : [],
    summary: tax.summary || {},
    safeHarbor: tax.safeHarbor || {},
    monthlySnapshot: tax.monthlySnapshot || {},
    meta: { source: "demo" },
    confidence: tax.confidence || null,
    warnings: [],
    setupState: null,
  };
}

export default useTaxLiability;
