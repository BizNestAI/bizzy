// /src/api/tax/generateTaxInsights.js
/* global process */
import { supabase } from "../../services/supabaseAdmin.js";
import { generateTaxInsights } from "../../services/tax/generateTaxInsights.js";
import { triggerContractorCfoInsightsBestEffort } from "../../services/insights/contractorCfoTriggerService.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

/**
 * POST /api/tax/generate-tax-insights
 * Body: { businessId: string, year?: number }
 * Returns: { ok: true, data: Insight[] }
 */
export default async function generateTaxInsightsHandler(req, res) {
  setTaxNoStore(res);

  if ((req.method || "").toUpperCase() !== "POST") {
    return sendTaxError(res, { code: "method_not_allowed", message: "Method Not Allowed. Use POST.", status: 405 }, "method_not_allowed");
  }

  let businessId;
  let year;
  try {
    businessId = validateBusinessIdInput(req);
    year = optionalTaxYear(req.body?.year, new Date().getFullYear());
    await assertTaxBusinessAccess({ req, businessId, supabase });
  } catch (err) {
    return sendTaxError(res, err, "invalid_tax_insights_request");
  }

  try {
    const tips = await generateTaxInsights({
      supabase,
      openaiApiKey: process.env.OPENAI_API_KEY || null, // allow null -> heuristic fallback
      businessId,
      year,
      userId: req.user.id,
    });

    const normalized = Array.isArray(tips) ? tips : [];
    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "tax",
      force: false,
    });
    return sendTaxSuccess(res, normalized);
  } catch (err) {
    console.error("[generate-tax-insights] error:", err);
    return sendTaxError(res, err, "tax_data_unavailable");
  }
}
