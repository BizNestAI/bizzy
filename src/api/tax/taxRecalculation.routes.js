import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import { getTaxRecalculationDiagnostics } from "../../services/tax/events/processTaxRecalculationRequests.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.get("/recalculation/diagnostics", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = req.query?.year || req.query?.taxYear ? optionalTaxYear(req.query.year ?? req.query.taxYear) : null;
    const diagnostics = await getTaxRecalculationDiagnostics({ supabase, businessId, taxYear });
    return sendTaxSuccess(res, diagnostics);
  } catch (err) {
    return sendTaxError(res, err, "tax_recalculation_diagnostics_failed");
  }
});

export default router;
