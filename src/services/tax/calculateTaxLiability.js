// /src/services/tax/calculateTaxLiability.js
import { runCanonicalTaxCalculation } from "./orchestrator/taxOrchestrator.js";
import { toLegacyTaxLiabilityResponse } from "./orchestrator/legacyTaxLiabilityAdapter.js";
import { TAX_CALCULATION_TYPES, TAX_TRIGGER_SOURCES } from "./taxDomain.js";

export async function calculateTaxLiability({
  supabase,
  businessId,
  projectionOverride,
  year = new Date().getFullYear(),
  asOfDate,
  calculationType = TAX_CALCULATION_TYPES.FULL_ESTIMATE,
  triggerSource = TAX_TRIGGER_SOURCES.MANUAL,
  projectionMethod = null,
  projectionScenario = null,
  userId = null,
  persistRun = true,
  force = false,
} = {}) {
  if (!supabase) throw new Error("supabase client (service-role) is required");
  if (!businessId) throw new Error("businessId required");
  const canonical = await runCanonicalTaxCalculation({
    supabase,
    businessId,
    taxYear: year,
    asOfDate,
    calculationType,
    projectionMethod: projectionMethod || projectionOverride?.method || "blended",
    projectionScenario: projectionScenario || projectionOverride?.scenario || "base",
    manualOverrides: normalizeLegacyManualOverrides(projectionOverride),
    triggerSource,
    userId,
    persistRun,
    force,
  });
  return toLegacyTaxLiabilityResponse(canonical);
}

function normalizeLegacyManualOverrides(projectionOverride) {
  if (!projectionOverride || typeof projectionOverride !== "object" || Array.isArray(projectionOverride)) return null;
  if (projectionOverride.manualOverrides) return projectionOverride.manualOverrides;
  const hasManualShape = projectionOverride.annual || projectionOverride.monthly || projectionOverride.reason;
  return hasManualShape ? projectionOverride : null;
}
