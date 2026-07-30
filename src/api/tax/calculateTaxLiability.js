// /src/api/tax/calculateTaxLiability.js
/* global process */
import { supabase } from "../../services/supabaseAdmin.js";
import { calculateTaxLiability } from "../../services/tax/calculateTaxLiability.js";
import { dataUnavailableError } from "../../services/tax/taxErrors.js";
import { emitTaxDataChanged } from "../../services/tax/taxChangeEvents.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { validateTaxCalculationRequest } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

let deps = {
  supabase,
  calculateTaxLiability,
  emitTaxDataChanged,
};

export function __setTaxCalculateLiabilityTestDeps(next = {}) {
  deps = { ...deps, ...next };
}

function isMissingTable(err) {
  const msg = (err?.message || "").toLowerCase();
  const details = (err?.details || "").toLowerCase();
  return (
    err?.code === "42P01" ||
    msg.includes("does not exist") ||
    /relation .* does not exist/i.test(msg) ||
    /relation .* does not exist/i.test(details)
  );
}

function mockLiability({ year }) {
  const monthly = Array.from({ length: 12 }, (_, i) => ({
    month: `${year}-${String(i + 1).padStart(2, "0")}`,
    estTax: 3200 + Math.round(Math.sin(i / 2.5) * 900),
  }));
  const annual = monthly.reduce((s, m) => s + m.estTax, 0);
  const qDue = { 1: `${year}-04-15`, 2: `${year}-06-15`, 3: `${year}-09-15`, 4: `${year + 1}-01-15` };
  const quarterly = [1, 2, 3, 4].map((q) => ({
    quarter: `Q${q}`, due: qDue[q], amount: 9500, paid: 0, remaining: 9500,
  }));
  return {
    meta: { year, generatedAt: new Date().toISOString(), source: "mock", is_demo: true },
    summary: {
      annualEstimate: annual,
      ytdEstimated: Math.round(annual * 0.65),
      ytdPaid: Math.round(annual * 0.55),
      balanceDue: Math.round(annual * 0.10),
    },
    safeHarbor: { method: "prior_year_100_percent", requiredAnnual: Math.round(annual * 0.95) },
    quarterly,
    trend: monthly,
    cashFlowOverlay: [],
    insights: [
      `You’re projected to owe $${annual.toLocaleString()} this year.`,
      "Consider increasing Q3/Q4 estimates if cash flow permits.",
    ],
  };
}

export default async function calculateTaxLiabilityHandler(req, res) {
  setTaxNoStore(res);

  if ((req.method || "").toUpperCase() !== "POST") {
    return sendTaxError(res, { code: "method_not_allowed", message: "Method not allowed. Use POST.", status: 405 }, "method_not_allowed");
  }

  let input;
  try {
    input = validateTaxCalculationRequest(req);
    await assertTaxBusinessAccess({ req, businessId: input.businessId, supabase: deps.supabase });
  } catch (err) {
    return sendTaxError(res, err, "invalid_tax_calculation_request");
  }

  if (process.env.MOCK_TAX_LIABILITY === "true") {
    return sendTaxSuccess(res, mockLiability({ year: input.taxYear }), { source: "mock", is_demo: true });
  }

  try {
    const data = await deps.calculateTaxLiability({
      supabase: deps.supabase,
      businessId: input.businessId,
      projectionOverride: input.projectionOverride,
      year: input.taxYear,
      asOfDate: input.asOfDate,
      calculationType: input.calculationType,
      triggerSource: req.body?.triggerSource || input.triggerSource,
      projectionMethod: req.body?.projectionMethod || null,
      projectionScenario: req.body?.projectionScenario || null,
      force: req.body?.force === true || req.body?.refresh === true,
      userId: req.user.id,
    });
    deps.emitTaxDataChanged?.({
      businessId: input.businessId,
      taxYear: input.taxYear,
      changeType: "tax_calculation_completed",
      entityId: data?.meta?.runId || null,
      userId: req.user.id,
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    if (isMissingTable(err)) {
      return sendTaxError(res, dataUnavailableError("Tax data is temporarily unavailable."), "tax_data_unavailable");
    }
    console.error("[tax] calculate-liability error:", err);
    return sendTaxError(res, err, "tax_calculation_failed");
  }
}
