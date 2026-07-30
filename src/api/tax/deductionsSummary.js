// /src/api/tax/deductionsSummary.js
import { supabase } from "../../services/supabaseAdmin.js";
import { computeTaxDeductionsSummary } from "../../services/tax/taxDeductionsEngine.js";
import { toLegacyDeductionsMatrix } from "../../services/tax/taxDeductionsLegacyAdapter.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalDate, optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

export default async function deductionsSummaryHandler(req, res) {
  setTaxNoStore(res);

  if ((req.method || "").toUpperCase() !== "POST") {
    return sendTaxError(res, { code: "method_not_allowed", message: "Method Not Allowed. Use POST.", status: 405 }, "method_not_allowed");
  }

  let businessId;
  let year;
  let asOfDate;
  let format;
  let includeComparisons;
  let includeCoverage;
  let includeWarnings;
  try {
    businessId = validateBusinessIdInput(req);
    year = optionalTaxYear(req.body?.year, new Date().getFullYear());
    asOfDate = optionalDate(req.body?.asOfDate, "asOfDate");
    format = normalizeSummaryFormat(req.body?.format);
    includeComparisons = req.body?.includeComparisons !== false;
    includeCoverage = req.body?.includeCoverage !== false;
    includeWarnings = req.body?.includeWarnings !== false;
    await assertTaxBusinessAccess({ req, businessId, supabase });
  } catch (err) {
    return sendTaxError(res, err, "invalid_deductions_request");
  }

  try {
    let data;
    if (format === "canonical") {
      data = await computeTaxDeductionsSummary({ supabase, businessId, taxYear: year, asOfDate, includeComparisons });
      if (!includeCoverage) delete data.coverage;
      if (!includeWarnings) delete data.warnings;
      data.meta = { ...data.meta, format: "canonical" };
    } else {
      const canonical = await computeTaxDeductionsSummary({ supabase, businessId, taxYear: year, asOfDate, includeComparisons });
      data = toLegacyDeductionsMatrix(canonical);
      if (!includeCoverage) delete data.meta.coverage;
      if (!includeWarnings) {
        delete data.meta.warnings;
        for (const row of data.grid || []) delete row.warnings;
      }
      data.meta = { ...data.meta, format: "legacy" };
    }
    return sendTaxSuccess(res, data);
  } catch (err) {
    console.error("[deductionsSummary] error:", err);
    return sendTaxError(res, err, "tax_data_unavailable");
  }
}

function normalizeSummaryFormat(value) {
  if (value == null || value === "") return "legacy";
  const format = String(value).trim().toLowerCase();
  if (!["legacy", "canonical"].includes(format)) {
    throw { code: "invalid_format", message: "format must be legacy or canonical.", status: 422 };
  }
  return format;
}
