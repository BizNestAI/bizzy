// /src/services/tax/taxClassificationReview.service.js
import {
  TAX_CLASSIFICATION_STATUSES,
  TAX_REVIEW_TASK_SEVERITIES,
  TAX_REVIEW_TASK_STATUSES,
  normalizeTaxYear,
} from "./taxDomain.js";
import { validationError } from "./taxErrors.js";
import { listTaxClassifications } from "./taxClassification.repository.js";
import { getPostedTransactionForTax } from "./taxPostedTransaction.repository.js";

export const TAX_CLASSIFICATION_REVIEW_REASONS = Object.freeze([
  "no_matching_rule",
  "low_confidence",
  "partial_deduction",
  "capital_asset_review",
  "refund_or_reversal",
  "loan_split_required",
  "source_conflict",
  "missing_qbo_account",
  "personal_business_mixed_use",
  "missing_tax_memory",
  "unsupported_rule",
  "user_rejected_suggestion",
]);

export async function listTaxClassificationReviewQueue({ supabase, businessId, taxYear, filters = {}, limit = 100, offset = 0 } = {}) {
  const year = requireTaxYear(taxYear);
  const listed = await listTaxClassifications({
    supabase,
    businessId,
    taxYear: year,
    status: TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW,
    taxCategory: filters.category || null,
    search: filters.search || null,
    limit,
    offset,
  });
  const rows = [];
  for (const classification of listed.rows) {
    if (filters.reason && !classificationHasReason(classification, filters.reason)) continue;
    if (filters.minAmount != null && Math.abs(Number(classification.book_amount || 0)) < Number(filters.minAmount)) continue;
    if (filters.maxAmount != null && Math.abs(Number(classification.book_amount || 0)) > Number(filters.maxAmount)) continue;
    const transaction = await safeTransaction({ supabase, businessId, transactionId: classification.transaction_id });
    const latestOverride = await latestOverrideForClassification({ supabase, businessId, taxYear: year, transactionId: classification.transaction_id });
    rows.push({
      transaction,
      classification,
      proposedClassification: classification.metadata?.engine_proposal || null,
      ruleExplanation: classification.reason || null,
      confidence: { score: classification.confidence_score, level: classification.confidence_level },
      warnings: classification.metadata?.warnings || classification.metadata?.source_warnings || [],
      reviewTaskStatus: TAX_REVIEW_TASK_STATUSES.OPEN,
      latestOverride,
      availableActions: ["confirm", "override", "reject", "exclude"],
    });
  }
  return { rows, pagination: listed.pagination };
}

export async function getTaxReviewQueueSummary({ supabase, businessId, taxYear } = {}) {
  const listed = await listTaxClassifications({ supabase, businessId, taxYear, status: TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW, limit: 10000, offset: 0 });
  const byReason = {};
  for (const row of listed.rows) {
    for (const reason of deriveReviewReasons(row)) byReason[reason] = (byReason[reason] || 0) + 1;
  }
  return { needsReviewCount: listed.rows.length, byReason };
}

export async function createOrUpdateReviewTaskForClassification({ supabase, businessId, taxYear, classification, reasonCode } = {}) {
  const year = requireTaxYear(taxYear);
  const reason = reasonCode || deriveReviewReasons(classification)[0] || "no_matching_rule";
  const dedupeKey = `tax_classification:${year}:${classification.transaction_id}`;
  const { data: existing, error: lookupError } = await supabase
    .from("tax_review_tasks")
    .select("*")
    .eq("business_id", businessId)
    .eq("dedupe_key", dedupeKey)
    .in("status", [TAX_REVIEW_TASK_STATUSES.OPEN, TAX_REVIEW_TASK_STATUSES.IN_PROGRESS])
    .maybeSingle();
  if (lookupError) throw lookupError;
  const payload = {
    business_id: businessId,
    tax_year: year,
    transaction_id: classification.transaction_id,
    classification_id: classification.id || null,
    dedupe_key: dedupeKey,
    reason_code: reason,
    severity: severityForReason(reason),
    status: existing?.status || TAX_REVIEW_TASK_STATUSES.OPEN,
    title: "Review tax classification",
    description: classification.reason || "Tax classification requires review.",
    metadata: { tax_category: classification.tax_category, warnings: classification.metadata?.warnings || [] },
    updated_at: new Date().toISOString(),
    created_at: existing?.created_at || new Date().toISOString(),
  };
  const { data, error } = await supabase.from("tax_review_tasks").upsert(payload, { onConflict: "business_id,dedupe_key" }).select("*").single();
  if (error) throw error;
  return data || payload;
}

export async function resolveReviewTaskForClassification({ supabase, businessId, taxYear, transactionId, actor = {} } = {}) {
  const year = requireTaxYear(taxYear);
  const dedupeKey = `tax_classification:${year}:${transactionId}`;
  const { data, error } = await supabase
    .from("tax_review_tasks")
    .update({
      status: TAX_REVIEW_TASK_STATUSES.RESOLVED,
      resolved_by: actor.userId || null,
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("business_id", businessId)
    .eq("dedupe_key", dedupeKey)
    .select("*");
  if (error) throw error;
  return data || [];
}

export function deriveReviewReasons(classification = {}) {
  const warnings = classification.metadata?.warnings || classification.metadata?.source_warnings || [];
  const reasons = [];
  if (classification.tax_category === "unclassified") reasons.push("no_matching_rule");
  if (Number(classification.confidence_score || 0) < 60) reasons.push("low_confidence");
  if (classification.deductibility_status === "partially_deductible") reasons.push("partial_deduction");
  if (classification.deductibility_status === "capitalizable") reasons.push("capital_asset_review");
  if (classification.tax_category === "refund_or_reversal") reasons.push("refund_or_reversal");
  if (classification.tax_category === "loan_principal") reasons.push("loan_split_required");
  if (warnings.includes("qbo_id_mismatch") || warnings.includes("conflicting_post_status")) reasons.push("source_conflict");
  if (warnings.includes("missing_qbo_account")) reasons.push("missing_qbo_account");
  if (classification.metadata?.rule_support_level === "unverified") reasons.push("unsupported_rule");
  if (classification.metadata?.user_rejected_suggestion) reasons.push("user_rejected_suggestion");
  return [...new Set(reasons.length ? reasons : ["no_matching_rule"])];
}

function classificationHasReason(classification, reason) {
  return deriveReviewReasons(classification).includes(reason);
}

function severityForReason(reason) {
  if (["source_conflict", "unsupported_rule"].includes(reason)) return TAX_REVIEW_TASK_SEVERITIES.HIGH;
  if (["partial_deduction", "capital_asset_review", "loan_split_required"].includes(reason)) return TAX_REVIEW_TASK_SEVERITIES.MEDIUM;
  return TAX_REVIEW_TASK_SEVERITIES.LOW;
}

async function safeTransaction({ supabase, businessId, transactionId }) {
  try {
    return await getPostedTransactionForTax({ supabase, businessId, transactionId });
  } catch {
    return null;
  }
}

async function latestOverrideForClassification({ supabase, businessId, taxYear, transactionId }) {
  const { data, error } = await supabase
    .from("tax_classification_overrides")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .eq("transaction_id", transactionId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

function requireTaxYear(value) {
  const year = normalizeTaxYear(value);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  return year;
}
