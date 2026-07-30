// /src/api/tax/deductionsExport.js
import { supabase } from "../../services/supabaseAdmin.js";
import {
  buildCpaPackage,
  listDeductionTransactions,
  validateDeductionTransactionFilters,
} from "../../services/tax/taxDeductionsApi.service.js";
import { computeTaxDeductionsSummary } from "../../services/tax/taxDeductionsEngine.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalDate, optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, setTaxNoStore } from "./taxHttp.js";

export default async function deductionsExportHandler(req, res) {
  setTaxNoStore(res);
  try {
    // Accept query OR body; keep it simple
    const businessId = validateBusinessIdInput(req);
    const src = req.method === "GET" ? req.query : (req.body || {});
    const year = optionalTaxYear(src.year, new Date().getFullYear());
    const asOfDate = optionalDate(src.asOfDate, "asOfDate");
    const format = normalizeExportFormat(src.format);
    const includeHistory = src.includeHistory === true || src.includeHistory === "true";
    await assertTaxBusinessAccess({ req, businessId, supabase });

    if (format === "cpa_package_json") {
      const json = await buildCpaPackage({ supabase, businessId, taxYear: year, asOfDate, includeHistory });
      setDownloadHeaders(res, { businessName: businessId, year, format, extension: "json", contentType: "application/json; charset=utf-8" });
      return res.send(JSON.stringify(json, null, 2));
    }

    const csv = await buildCsvExport({ supabase, businessId, year, asOfDate, format, src });
    setDownloadHeaders(res, { businessName: businessId, year, format, extension: "csv", contentType: "text/csv; charset=utf-8" });
    return res.send(csv);
  } catch (err) {
    console.error("[deductionsExport] error:", err);
    return sendTaxError(res, err, "tax_data_unavailable");
  }
}

async function buildCsvExport({ supabase, businessId, year, asOfDate, format, src }) {
  if (format === "summary_csv") {
    const summary = await computeTaxDeductionsSummary({ supabase, businessId, taxYear: year, asOfDate });
    return summaryCsv(summary);
  }
  const filters = validateDeductionTransactionFilters(src);
  const result = await listDeductionTransactions({
    supabase,
    businessId,
    taxYear: year,
    asOfDate,
    filters,
    pagination: { limit: 200, offset: 0 },
  });
  const rows = format === "review_csv" ? result.rows.filter((row) => row.classificationStatus === "needs_review" || row.requiresReview) : result.rows;
  return transactionsCsv(rows, { reviewOnly: format === "review_csv" });
}

function summaryCsv(summary) {
  const header = [
    "Tax Category",
    "Book Expense Amount",
    "Estimated Deductible Amount",
    "Confirmed Deductible Amount",
    "Auto-Classified Deductible Amount",
    "Nondeductible Amount",
    "Capitalizable Amount",
    "Needs Review Amount",
    "Transaction Count",
    "Review Count",
    "Average Deductible Percent",
    "Confidence Level",
  ];
  const lines = [header];
  for (const row of summary.categories) {
    lines.push([
      row.displayName,
      row.bookExpenseAmount,
      row.estimatedDeductibleAmount,
      row.confirmedDeductibleAmount,
      row.autoClassifiedDeductibleAmount,
      row.nondeductibleAmount,
      row.capitalizableAmount,
      row.needsReviewAmount,
      row.transactionCount,
      row.reviewCount,
      row.averageDeductiblePercent,
      row.confidenceLevel,
    ]);
  }
  return lines.map((row) => row.map(toCsvCell).join(",")).join("\n") + "\n";
}

function transactionsCsv(rows, { reviewOnly = false } = {}) {
  const header = reviewOnly
    ? ["Date", "Description", "Merchant / Counterparty", "Book Amount", "Tax Category", "Review Reason", "Proposed Treatment", "Confidence", "Warnings", "Source Conflicts", "Last Updated"]
    : ["Date", "Description", "Merchant / Counterparty", "Book Amount", "Direction", "QBO Account", "QBO Transaction Type", "QBO Transaction ID", "Tax Category", "Deductibility Status", "Deductible Percent", "Deductible Amount", "Nondeductible Amount", "Capitalizable Amount", "Classification Status", "Confidence Score", "Rule Code", "Rule Explanation", "User/CPA Override", "Needs Review", "Review Reason", "Last Updated"];
  const lines = [header];
  for (const row of rows) {
    const reviewReason = (row.warnings || []).join("; ");
    if (reviewOnly) {
      lines.push([row.date, row.description, row.merchantName || row.counterpartyName, row.signedAmount, row.taxCategory, reviewReason, row.taxTreatment?.type || "", row.confidenceLevel, (row.warnings || []).join("; "), sourceConflicts(row), row.updatedAt]);
    } else {
      lines.push([row.date, row.description, row.merchantName || row.counterpartyName, row.signedAmount, row.direction, row.qboAccountName, row.qboTxnType, row.qboTxnId, row.taxCategory, row.deductibilityStatus, row.deductiblePercent, row.deductibleAmount, row.nondeductibleAmount, row.capitalizableAmount, row.classificationStatus, row.confidenceScore, row.rule?.code, row.rule?.explanation, row.override?.hasOverride ? row.override.source || "yes" : "no", row.requiresReview ? "yes" : "no", reviewReason, row.updatedAt]);
    }
  }
  return lines.map((row) => row.map(toCsvCell).join(",")).join("\n") + "\n";
}

function toCsvCell(v) {
  if (typeof v === "string") {
    const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return String(v ?? "");
}

function normalizeExportFormat(value) {
  const format = String(value || "summary_csv").trim().toLowerCase();
  if (!["summary_csv", "transactions_csv", "review_csv", "cpa_package_json"].includes(format)) {
    throw { code: "invalid_export_format", message: "Unsupported deductions export format.", status: 422 };
  }
  return format;
}

function setDownloadHeaders(res, { businessName, year, format, extension, contentType }) {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="bizzi_tax_deductions_${safeName(businessName)}_${year}_${format}.${extension}"`);
}

function safeName(value) {
  return String(value || "business").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "business";
}

function sourceConflicts(row) {
  return (row.warnings || []).filter((w) => ["qbo_id_mismatch", "conflicting_post_status", "source_conflict"].includes(w)).join("; ");
}
