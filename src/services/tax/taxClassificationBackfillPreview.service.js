import { listUnclassifiedPostedTransactions } from "./taxPostedTransaction.repository.js";
import { normalizeTaxYear } from "./taxDomain.js";
import { validationError } from "./taxErrors.js";

const DEFAULT_LIMIT = 1000;
const PAGE_SIZE = 250;
const PREVIEW_RULE_VERSION = "tax-classification-preview-v1";

export async function previewTaxClassificationBackfill({ supabase, businessId, taxYear, limit = DEFAULT_LIMIT } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const year = normalizeTaxYear(taxYear);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  const boundedLimit = Math.min(Math.max(Number(limit || DEFAULT_LIMIT), 1), DEFAULT_LIMIT);
  const rows = [];

  for (let offset = 0; rows.length < boundedLimit; offset += PAGE_SIZE) {
    const page = await listUnclassifiedPostedTransactions({
      supabase,
      businessId,
      taxYear: year,
      limit: Math.min(PAGE_SIZE, boundedLimit - rows.length),
      offset,
    });
    rows.push(...(page.rows || []));
    if (!page.pagination?.hasMore || !page.rows?.length) break;
  }

  return summarizeTaxClassificationBackfillPreviewRows(rows, {
    businessId,
    taxYear: year,
    capped: rows.length >= boundedLimit,
    limit: boundedLimit,
  });
}

export function summarizeTaxClassificationBackfillPreviewRows(rows = [], context = {}) {
  const summaries = rows.map(classifyTaxBackfillPreviewRow);
  const counts = summaries.reduce((acc, item) => {
    acc.previewed += 1;
    acc[item.bucket] = (acc[item.bucket] || 0) + 1;
    return acc;
  }, {
    previewed: 0,
    estimatedAutomaticClassifications: 0,
    estimatedExclusions: 0,
    estimatedReviewRequired: 0,
  });
  counts.estimatedAutomaticClassifications = summaries.filter((row) => row.bucket === "estimatedAutomaticClassifications").length;
  counts.estimatedExclusions = summaries.filter((row) => row.bucket === "estimatedExclusions").length;
  counts.estimatedReviewRequired = summaries.filter((row) => row.bucket === "estimatedReviewRequired").length;

  return {
    meta: {
      businessId: context.businessId || null,
      taxYear: context.taxYear || null,
      rulesVersion: PREVIEW_RULE_VERSION,
      generatedAt: new Date().toISOString(),
      readOnly: true,
      capped: context.capped === true,
      limit: context.limit ?? DEFAULT_LIMIT,
    },
    counts: {
      eligible: summaries.length,
      previewed: summaries.length,
      estimatedAutomaticClassifications: counts.estimatedAutomaticClassifications,
      estimatedExclusions: counts.estimatedExclusions,
      estimatedReviewRequired: counts.estimatedReviewRequired,
    },
    totalsByTaxCategory: rollup(summaries, "taxCategory"),
    totalsByGlAccount: rollup(summaries, "qboAccountName"),
    warnings: previewWarnings(summaries),
  };
}

export function classifyTaxBackfillPreviewRow(row = {}) {
  const account = displayText(row.qboAccountName || row.bookAccount || row.qboAccount || "Unmapped QuickBooks account");
  const accountText = account.toLowerCase();
  const txnType = displayText(row.qboTxnType || row.transactionType || row.type).toLowerCase();
  const direction = displayText(row.direction).toLowerCase();
  const amount = Math.abs(Number(row.absoluteAmount ?? row.amount ?? row.signedAmount ?? 0)) || 0;

  if (isExcluded(accountText, txnType, direction)) {
    return previewRow(row, "estimatedExclusions", "excluded", "excluded", 0, "Known non-deduction or duplicate representation.", amount);
  }
  if (requiresReview(accountText)) {
    return previewRow(row, "estimatedReviewRequired", suggestedReviewCategory(accountText), "needs_review", null, "Requires tax review or substantiation before becoming authoritative.", amount);
  }
  const automaticCategory = automaticCategoryFor(accountText);
  if (automaticCategory) {
    return previewRow(row, "estimatedAutomaticClassifications", automaticCategory, "fully_deductible", 100, "Matched a deterministic tax category pattern.", amount);
  }
  return previewRow(row, "estimatedReviewRequired", "unclassified", "needs_review", null, "No approved deterministic tax rule matched.", amount);
}

function previewRow(row, bucket, taxCategory, deductibilityStatus, deductiblePercent, reason, amount) {
  return {
    transactionId: row.transactionId || row.id || null,
    bucket,
    taxCategory,
    deductibilityStatus,
    deductiblePercent,
    reason,
    amount,
    qboAccountName: displayText(row.qboAccountName || row.bookAccount || "Unmapped QuickBooks account"),
  };
}

function isExcluded(accountText, txnType, direction) {
  const text = `${accountText} ${txnType} ${direction}`;
  return [
    "transfer",
    "credit card payment",
    "card payment",
    "loan principal",
    "loan proceeds",
    "owner draw",
    "owner contribution",
    "equity",
    "duplicate",
  ].some((needle) => text.includes(needle));
}

function requiresReview(accountText) {
  return [
    "meal",
    "restaurant",
    "fuel",
    "gas",
    "vehicle",
    "parking",
    "rideshare",
    "travel",
    "equipment",
    "asset",
    "depreciation",
    "charit",
    "uncategorized",
    "unmapped",
    "personal",
  ].some((needle) => accountText.includes(needle));
}

function automaticCategoryFor(accountText) {
  if (accountText.includes("software")) return "software";
  if (accountText.includes("payment") && accountText.includes("fee")) return "payment_processing_fees";
  if (accountText.includes("bank fee") || accountText.includes("merchant fee") || accountText.includes("processing fee")) return "payment_processing_fees";
  if (accountText.includes("office") || accountText.includes("supplies")) return "office_expense";
  if (accountText.includes("insurance")) return "insurance";
  if (accountText.includes("electric") || accountText.includes("utility") || accountText.includes("utilities")) return "utilities";
  if (accountText.includes("professional") || accountText.includes("legal") || accountText.includes("accounting")) return "legal_professional";
  if (accountText.includes("rent")) return "rent";
  if (accountText.includes("contractor") || accountText.includes("subcontractor") || accountText.includes("contract labor")) return "contract_labor";
  return null;
}

function suggestedReviewCategory(accountText) {
  if (accountText.includes("meal") || accountText.includes("restaurant")) return "meals";
  if (accountText.includes("gas") || accountText.includes("fuel") || accountText.includes("vehicle")) return "vehicle";
  if (accountText.includes("equipment") || accountText.includes("asset")) return "equipment_asset";
  if (accountText.includes("personal")) return "personal_expense";
  if (accountText.includes("travel") || accountText.includes("parking") || accountText.includes("rideshare")) return "travel";
  if (accountText.includes("charit")) return "charitable_contribution";
  return "unclassified";
}

function rollup(rows, field) {
  const map = new Map();
  for (const row of rows) {
    const key = displayText(row[field] || "Unmapped");
    const current = map.get(key) || { key, count: 0, bookAmount: 0 };
    current.count += 1;
    current.bookAmount = round2(current.bookAmount + Number(row.amount || 0));
    map.set(key, current);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function previewWarnings(rows) {
  const categories = new Set(rows.map((row) => row.taxCategory));
  const warnings = [];
  if (categories.has("meals")) warnings.push({ code: "meals_require_review", message: "Meals require substantiation and are not auto-approved as fully deductible." });
  if (categories.has("vehicle")) warnings.push({ code: "vehicle_requires_business_use", message: "Vehicle and gas expenses require business-use context." });
  if (categories.has("equipment_asset")) warnings.push({ code: "assets_require_review", message: "Equipment may require capitalization or depreciation review." });
  if (categories.has("unclassified")) warnings.push({ code: "unmapped_requires_review", message: "Unmapped activity remains review-required." });
  return warnings;
}

function displayText(value) {
  return String(value ?? "").trim();
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
