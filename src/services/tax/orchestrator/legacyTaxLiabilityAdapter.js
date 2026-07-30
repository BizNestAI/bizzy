// /src/services/tax/orchestrator/legacyTaxLiabilityAdapter.js
/* global process */
import { TAX_API_VERSION } from "../api/taxApiVersion.js";
import { buildTaxSetupState } from "../api/taxSetupState.js";

export function toLegacyTaxLiabilityResponse(canonical, { includeCanonical = process.env.NODE_ENV !== "production" } = {}) {
  const year = canonical.meta.taxYear;
  const trend = buildTrend(canonical);
  const setupState = buildTaxSetupState({ canonicalResult: canonical });
  const safeHarborStatus = canonical.safeHarbor?.combined?.status || canonical.safeHarbor?.federal?.status || "unavailable";
  const quarterly = safeHarborStatus === "unavailable" ? [] : canonical.safeHarbor?.federal?.quarterSchedule || [];
  const legacy = {
    meta: {
      year,
      generatedAt: canonical.meta.generatedAt,
      source: "canonical",
      runId: canonical.meta.runId,
      status: canonical.meta.status,
      confidence: canonical.confidence,
      warnings: canonical.warnings,
      apiVersion: TAX_API_VERSION,
      canonicalStatus: canonical.meta.status,
      deprecation: {
        deprecated: false,
        canonicalEndpoint: "/api/tax/overview",
        plannedMigration: true,
      },
    },
    summary: {
      annualEstimate: nullableRound2(canonical.liability.projectedTotalTax),
      ytdEstimated: nullableRound2(canonical.liability.ytdTaxGeneratedEstimate),
      ytdPaid: nullableRound2(canonical.liability.paymentsAndWithholdingYtd),
      balanceDue: nullableRound2(canonical.liability.balanceDueEstimate),
      profitYTD: nullableRound2(canonical.actuals.taxableIncome?.businessTaxableIncome?.finalBusinessTaxableIncome),
      recommendedReserve: nullableRound2(canonical.reserve?.reserve?.recommendedReserve ?? canonical.reserveInput?.recommendedReserveBeforeCashComparison),
      reserveGap: nullableRound2(canonical.reserve?.reserve?.reserveGap ?? canonical.reserveInput?.reserveGap),
    },
    safeHarbor: {
      status: safeHarborStatus,
      method: canonical.safeHarbor?.federal?.method,
      requiredAnnual: nullableRound2(canonical.safeHarbor?.federal?.requiredAnnual),
      coveredAmount: nullableRound2(canonical.safeHarbor?.federal?.coveredAmount),
      remainingAmount: nullableRound2(canonical.safeHarbor?.federal?.remainingAmount),
      warnings: canonical.safeHarbor?.federal?.warnings || [],
    },
    quarterly: quarterly.map((row) => ({
      quarter: row.quarter,
      due: row.due,
      amount: round2(row.amount),
      paid: round2(row.paid),
      remaining: round2(row.remaining),
    })),
    trend,
    cashFlowOverlay: [],
    monthlySnapshot: {
      metrics: {
        profitYTD: nullableRound2(canonical.actuals.taxableIncome?.businessTaxableIncome?.finalBusinessTaxableIncome),
        taxableIncomeYTD: nullableRound2(canonical.actuals.taxableIncome?.businessTaxableIncome?.finalBusinessTaxableIncome),
        projectedTaxableIncome: nullableRound2(canonical.projection?.projectedAnnual?.taxableBusinessIncome),
      },
    },
    confidence: {
      score: canonical.confidence?.score ?? null,
      level: canonical.confidence?.level || "unavailable",
      estimateReady: canonical.confidence?.estimateReady === true,
      reserveReady: canonical.confidence?.reserveReady === true,
    },
    warnings: canonical.warnings,
    setupState,
  };
  if (includeCanonical) {
    legacy.canonical = {
      meta: canonical.meta,
      liability: canonical.liability,
      federal: { totalFederalTax: canonical.federal.totalFederalTax },
      state: { totalStateTax: canonical.state.totalStateTax },
      reserveInput: canonical.reserveInput,
      reserve: canonical.reserve,
      warnings: canonical.warnings,
      missingInputs: canonical.missingInputs,
      unsupportedItems: canonical.unsupportedItems,
    };
  }
  return legacy;
}

function buildTrend(canonical) {
  const monthly = canonical.projection?.projectedAnnual?.monthly || canonical.projection?.actual?.monthly || {};
  const annualTotal = Number(canonical.liability.projectedTotalTax || 0);
  const months = Array.from({ length: 12 }, (_, i) => `${canonical.meta.taxYear}-${String(i + 1).padStart(2, "0")}`);
  const perMonth = round2(annualTotal / 12);
  const currentMonth = String(canonical.meta.asOfDate || "").slice(0, 7);
  return months.map((month) => ({
    month,
    estTax: perMonth,
    projectedTax: month > currentMonth ? perMonth : null,
    actualTax: null,
    modeledTax: month <= currentMonth && monthly[month]?.taxableBusinessIncome != null ? perMonth : null,
    periodType: month === currentMonth ? "current_partial" : month < currentMonth ? "modeled_reconstructed" : "projected",
    pointType: month > currentMonth ? "projected_future_period" : "legacy_elapsed_time_reconstruction",
    sourceType: "legacy_elapsed_time_reconstruction",
    method: "elapsed_time_allocation",
    confidence: { level: "low", status: "legacy_reconstruction" },
    isCurrent: month === currentMonth,
  }));
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function nullableRound2(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return round2(value);
}
