// /src/api/tax/stateTax.routes.js
import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import { computeStateTax } from "../../services/tax/state/stateTaxEngine.js";
import { getStateTaxConfigSet } from "../../services/tax/stateTaxRule.repository.js";
import { evaluateTaxEntity } from "../../services/tax/entity/entityEngine.js";
import { getTaxProfile } from "../../services/tax/taxProfile.service.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalDate, optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.post("/state/calculate", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const body = req.body || {};
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(body.year ?? body.taxYear, new Date().getFullYear());
    const asOfDate = optionalDate(body.asOfDate, "asOfDate");
    const profile = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
    const entityContext = await evaluateTaxEntity({ supabase, businessId, taxYear, asOfDate, profile });
    const data = await computeStateTax({
      supabase,
      businessId,
      taxYear,
      asOfDate,
      stateCode: body.stateCode || body.state_code || profile?.primary_tax_state,
      filingStatus: body.filingStatus || body.filing_status || profile?.filing_status,
      entityContext,
      federalContext: body.federalContext || null,
      taxableIncomeContext: body.taxableIncomeContext || null,
      projectionContext: body.projectionContext || null,
      scenario: body.scenario || null,
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "state_tax_calculation_failed");
  }
});

router.get("/state/rule-support", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query?.year ?? req.query?.taxYear, new Date().getFullYear());
    const profile = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
    const data = await getStateTaxConfigSet({
      supabase,
      taxYear,
      stateCode: req.query?.stateCode || req.query?.state_code || profile?.primary_tax_state,
      filingStatus: req.query?.filingStatus || req.query?.filing_status || profile?.filing_status,
      entityType: profile?.entity_type,
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "state_rule_support_failed");
  }
});

export default router;
