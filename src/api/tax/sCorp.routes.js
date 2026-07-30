// /src/api/tax/sCorp.routes.js
import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import { computeSCorpTaxContext } from "../../services/tax/sCorp/sCorpEngine.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalDate, optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.post("/s-corp/evaluate", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const body = req.body || {};
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(body.year ?? body.taxYear, new Date().getFullYear());
    const asOfDate = optionalDate(body.asOfDate, "asOfDate");
    const data = await computeSCorpTaxContext({
      supabase,
      businessId,
      taxYear,
      asOfDate,
      scenarioOverrides: sanitizeScenarioOverrides(body.scenarioOverrides ?? body.scenario_overrides),
    });
    return sendTaxSuccess(res, data, { scenario: Boolean(body.scenarioOverrides || body.scenario_overrides), persisted: false });
  } catch (err) {
    return sendTaxError(res, err, "s_corp_evaluation_failed");
  }
});

router.get("/s-corp/diagnostics", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query?.year ?? req.query?.taxYear, new Date().getFullYear());
    const asOfDate = optionalDate(req.query?.asOfDate, "asOfDate");
    const data = await computeSCorpTaxContext({ supabase, businessId, taxYear, asOfDate });
    return sendTaxSuccess(res, {
      salaryDiagnostics: data.wages.reasonableSalaryDiagnostics,
      wageDistributionRatio: data.wages.reasonableSalaryDiagnostics.distributionToWageRatio,
      missingInputs: data.blockers,
      withholding: data.withholding,
      passThroughIncome: data.income.passThroughIncome,
      warnings: data.warnings,
      supportedButDeferred: data.supportedButDeferred,
      confidence: data.confidence,
    });
  } catch (err) {
    return sendTaxError(res, err, "s_corp_diagnostics_failed");
  }
});

function sanitizeScenarioOverrides(value) {
  if (!value) return null;
  if (Array.isArray(value) || typeof value !== "object") return null;
  const allowed = new Set([
    "owner_reasonable_salary",
    "owner_w2_wages_ytd",
    "federal_withholding_ytd",
    "state_withholding_ytd",
    "health_insurance_deduction_ytd",
    "retirement_contributions_ytd",
    "metadata",
  ]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)));
}

export default router;
