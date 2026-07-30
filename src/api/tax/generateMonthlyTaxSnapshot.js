// /src/api/tax/generateMonthlyTaxSnapshot.js
/* global process */
import { supabase } from "../../services/supabaseAdmin.js";
import { generateMonthlyTaxSnapshot } from "../../services/tax/generateMonthlyTaxSnapshot.js";
import { triggerContractorCfoInsightsBestEffort } from "../../services/insights/contractorCfoTriggerService.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

export default async function generateMonthlyTaxSnapshotHandler(req, res) {
  setTaxNoStore(res);

  if ((req.method || "").toUpperCase() !== "POST") {
    return sendTaxError(res, { code: "method_not_allowed", message: "Method Not Allowed. Use POST.", status: 405 }, "method_not_allowed");
  }

  let input;
  try {
    const requestedYear = req.body?.year ?? req.body?.taxYear;
    input = {
      businessId: validateBusinessIdInput(req),
      year: requestedYear == null ? undefined : optionalTaxYear(requestedYear, new Date().getFullYear()),
      month: req.body?.month,
      archive: req.body?.archive !== false,
    };
    await assertTaxBusinessAccess({ req, businessId: input.businessId, supabase });
  } catch (err) {
    return sendTaxError(res, err, "invalid_tax_snapshot_request");
  }

  try {
    const data = await generateMonthlyTaxSnapshot({
      supabase,
      businessId: input.businessId,
      year: input.year,
      month: input.month,
      archive: input.archive,
      openaiApiKey: process.env.OPENAI_API_KEY || null, // allow null (fallback inside service)
      userId: req.user.id,
    });
    triggerContractorCfoInsightsBestEffort({
      businessId: input.businessId,
      trigger: "tax",
      force: false,
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    console.error("[generateMonthlyTaxSnapshot] error:", err);
    return sendTaxError(res, err, "tax_data_unavailable");
  }
}
