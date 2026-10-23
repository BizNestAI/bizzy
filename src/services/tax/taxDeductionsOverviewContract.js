export const TAX_DEDUCTIONS_OVERVIEW_PROJECTION_VERSION = "tax-deductions-overview-v1";

export function validateTaxDeductionsOverviewResponse(payload, { businessId, taxYear, requestId = null } = {}) {
  const overview = payload?.ok === true && payload?.data !== undefined ? payload.data : payload;
  const projection = overview?.projection;
  const responseRequestId = payload?.requestId || payload?.request_id || requestId || null;
  const fail = (missingFields) => {
    throw Object.assign(new Error("The Tax deductions overview is not compatible with this version of Bizzi."), {
      code: "tax_deductions_overview_version_mismatch",
      status: 502,
      requestId: responseRequestId,
      retryable: false,
      details: { expectedVersion: TAX_DEDUCTIONS_OVERVIEW_PROJECTION_VERSION, missingFields },
    });
  };

  const missing = [];
  if (!overview || typeof overview !== "object" || Array.isArray(overview)) missing.push("data");
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) missing.push("projection");
  if (projection?.projectionVersion !== TAX_DEDUCTIONS_OVERVIEW_PROJECTION_VERSION) missing.push("projection.projectionVersion");
  if (!nonempty(projection?.projectionId)) missing.push("projection.projectionId");
  if (String(projection?.canonicalBusinessId || "") !== String(businessId || "")) missing.push("projection.canonicalBusinessId");
  if (Number(projection?.taxYear) !== Number(taxYear)) missing.push("projection.taxYear");
  if (!finiteNumber(projection?.estimatedDeductibleAmount)) missing.push("projection.estimatedDeductibleAmount");
  for (const field of ["evaluatedTransactionCount", "matrixIncludedCount", "outsideDeductionsCount", "questionsForYouGroupCount"]) {
    if (!nonnegativeInteger(projection?.[field])) missing.push(`projection.${field}`);
  }
  if (!validTimestamp(projection?.refreshedAt)) missing.push("projection.refreshedAt");
  if (!overview?.totals || !finiteNumber(overview.totals.estimatedDeductibleAmount)) missing.push("totals.estimatedDeductibleAmount");
  if (!Array.isArray(overview?.categories)) missing.push("categories");
  if (missing.length) fail(missing);
  return overview;
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value) {
  return value !== null && value !== "" && Number.isFinite(Number(value));
}

function nonnegativeInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 0;
}

function validTimestamp(value) {
  return nonempty(value) && Number.isFinite(Date.parse(value));
}
