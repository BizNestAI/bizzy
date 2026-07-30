// /src/api/tax/taxableIncome.routes.js
import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import { computeTaxableIncome } from "../../services/tax/taxableIncome/taxableIncomeEngine.js";
import { TaxableIncomeComponentTypeSet } from "../../services/tax/taxableIncome/taxableIncomeDomain.js";
import { validationError } from "../../services/tax/taxErrors.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import {
  optionalDate,
  optionalEnum,
  optionalTaxYear,
  validateBusinessIdInput,
  validatePagination,
  validateProjectionOverride,
} from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();
const CALCULATION_TYPES = new Set(["ytd_actual", "projection", "manual_override"]);

router.post("/taxable-income/calculate", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const body = req.body || {};
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(body.year ?? body.taxYear, new Date().getFullYear());
    const asOfDate = optionalDate(body.asOfDate, "asOfDate");
    const calculationType = optionalEnum(body.calculationType, CALCULATION_TYPES, "calculationType") || "ytd_actual";
    const projectionContext = body.projectionContext == null ? null : validateProjectionOverride(body.projectionContext);
    const manualOverrides = validateManualOverrides(body.manualOverrides);
    const data = await computeTaxableIncome({
      supabase,
      businessId,
      taxYear,
      asOfDate,
      calculationType,
      includeForecast: body.includeForecast === true,
      projectionContext,
      manualOverrides,
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "taxable_income_calculation_failed");
  }
});

router.get("/taxable-income/latest", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query?.year ?? req.query?.taxYear, new Date().getFullYear());
    const data = await computeTaxableIncome({ supabase, businessId, taxYear });
    return sendTaxSuccess(res, data, { mode: "calculated_on_demand" });
  } catch (err) {
    return sendTaxError(res, err, "taxable_income_latest_failed");
  }
});

router.get("/taxable-income/components", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query?.year ?? req.query?.taxYear, new Date().getFullYear());
    const asOfDate = optionalDate(req.query?.asOfDate, "asOfDate");
    const componentType = optionalEnum(req.query?.componentType ?? req.query?.component_type, TaxableIncomeComponentTypeSet, "componentType");
    const { limit = 100, offset = 0 } = validatePagination(req.query || {});
    const result = await computeTaxableIncome({ supabase, businessId, taxYear, asOfDate });
    const filtered = componentType
      ? result.components.filter((component) => component.componentType === componentType)
      : result.components;
    const rows = filtered.slice(offset, offset + limit);
    return sendTaxSuccess(res, {
      rows,
      pagination: { limit, offset, returned: rows.length, total: filtered.length, hasMore: offset + limit < filtered.length },
    });
  } catch (err) {
    return sendTaxError(res, err, "taxable_income_components_failed");
  }
});

function validateManualOverrides(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    if (value.length > 100) throw validationError("manual_overrides_too_large", "manualOverrides cannot contain more than 100 items.");
    return value.map(validateManualOverride);
  }
  if (typeof value !== "object") {
    throw validationError("invalid_manual_overrides", "manualOverrides must be an object or array.", { field: "manualOverrides" });
  }
  const text = JSON.stringify(value);
  if (text.length > 12000) throw validationError("manual_overrides_too_large", "manualOverrides payload is too large.");
  if (Array.isArray(value.items)) return { ...value, items: value.items.slice(0, 100).map(validateManualOverride) };
  return { ...value };
}

function validateManualOverride(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw validationError("invalid_manual_override", "Each manual override must be an object.");
  }
  return { ...row };
}

export default router;
