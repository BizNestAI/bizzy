// /src/api/tax/taxProjection.routes.js
import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import { projectAnnualTaxableIncome, getAvailableProjectionMethods } from "../../services/tax/projection/annualProjectionEngine.js";
import { PROJECTION_METHODS, ProjectionMethodSet, ProjectionScenarioSet } from "../../services/tax/projection/taxProjectionDomain.js";
import { getHistoricalTaxPatterns } from "../../services/tax/projection/taxHistoricalPattern.service.js";
import { getTaxProjectionForecastInputs } from "../../services/tax/projection/taxForecastSource.service.js";
import { computeTaxableIncome } from "../../services/tax/taxableIncome/taxableIncomeEngine.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalDate, optionalEnum, optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.post("/projections/annual", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const body = req.body || {};
    const taxYear = optionalTaxYear(body.year ?? body.taxYear, new Date().getFullYear());
    const asOfDate = optionalDate(body.asOfDate, "asOfDate");
    const method = optionalEnum(body.method, ProjectionMethodSet, "method") || PROJECTION_METHODS.BLENDED;
    const scenario = optionalEnum(body.scenario, ProjectionScenarioSet, "scenario") || "base";
    const data = await projectAnnualTaxableIncome({
      supabase,
      businessId,
      taxYear,
      asOfDate,
      method,
      scenario,
      manualOverrides: body.manualOverrides || null,
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_projection_failed");
  }
});

router.get("/projections/methods", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query?.year ?? req.query?.taxYear, new Date().getFullYear());
    const asOfDate = optionalDate(req.query?.asOfDate, "asOfDate");
    const [actual, history, forecast] = await Promise.all([
      computeTaxableIncome({ supabase, businessId, taxYear, asOfDate }),
      getHistoricalTaxPatterns({ supabase, businessId, taxYear, asOfDate }),
      getTaxProjectionForecastInputs({ supabase, businessId, taxYear, asOfDate }),
    ]);
    const methods = getAvailableProjectionMethods({
      actualMonths: actual.actual?.monthsCompleted || Object.values(actual.monthly || {}).filter((row) => row.revenue || row.cogs || row.deductibleExpenses).length,
      historyYears: history.yearsAvailable.length,
      forecastMonths: Object.keys(forecast.monthlyForecast || {}).length,
    });
    const sample = await projectAnnualTaxableIncome({ supabase, businessId, taxYear, asOfDate, method: PROJECTION_METHODS.BLENDED });
    return sendTaxSuccess(res, {
      recommendedMethod: sample.confidence.recommendedMethod,
      ...methods,
      reasons: {
        historyWarnings: history.warnings,
        forecastWarnings: forecast.warnings,
      },
    });
  } catch (err) {
    return sendTaxError(res, err, "tax_projection_methods_failed");
  }
});

router.post("/projections/compare", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const body = req.body || {};
    const taxYear = optionalTaxYear(body.year ?? body.taxYear, new Date().getFullYear());
    const asOfDate = optionalDate(body.asOfDate, "asOfDate");
    const methods = Array.isArray(body.methods) && body.methods.length
      ? body.methods.map((method) => optionalEnum(method, ProjectionMethodSet, "methods"))
      : [PROJECTION_METHODS.ACTUAL_ONLY, PROJECTION_METHODS.ANNUALIZED_RUN_RATE, PROJECTION_METHODS.CASHFLOW_FORECAST, PROJECTION_METHODS.BLENDED];
    const rows = [];
    for (const method of methods) {
      rows.push(await projectAnnualTaxableIncome({ supabase, businessId, taxYear, asOfDate, method }));
    }
    return sendTaxSuccess(res, {
      rows: rows.map((row) => ({
        method: row.meta.method,
        projectedAnnual: row.projectedAnnual,
        range: row.range,
        confidence: row.confidence,
        warnings: row.warnings,
      })),
    });
  } catch (err) {
    return sendTaxError(res, err, "tax_projection_compare_failed");
  }
});

export default router;
