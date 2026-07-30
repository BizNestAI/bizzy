// /src/services/tax/taxAdjustment.service.js
import {
  TAX_ADJUSTMENT_DIRECTIONS,
  TAX_CLASSIFICATION_SOURCES,
  normalizeDateOnly,
  normalizeMoney,
  normalizeTaxYear,
} from "./taxDomain.js";
import { notFoundError, validationError } from "./taxErrors.js";

const ACTIVE_STATUSES = new Set(["active", "approved", "posted", "manual", "cpa_confirmed", "user_confirmed"]);
const ARCHIVED_STATUSES = new Set(["archived", "deleted", "void"]);
const DIRECTIONS = new Set(Object.values(TAX_ADJUSTMENT_DIRECTIONS));
const SOURCES = new Set([...Object.values(TAX_CLASSIFICATION_SOURCES), "manual_override", "imported_return", "system"]);

export async function listTaxAdjustments({
  supabase,
  businessId,
  taxYear,
  asOfDate,
  status,
  adjustmentType,
} = {}) {
  const year = requireTaxYear(taxYear);
  const cutoff = normalizeDateOnly(asOfDate) || `${year}-12-31`;
  let query = supabase
    .from("tax_adjustments")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", year)
    .lte("effective_date", cutoff)
    .order("effective_date", { ascending: true })
    .order("created_at", { ascending: true });
  if (status) query = query.eq("status", status);
  if (adjustmentType) query = query.eq("adjustment_type", adjustmentType);
  const { data, error } = await query;
  if (error) throw error;
  return (data || [])
    .filter((row) => !isArchived(row))
    .map(sanitizeAdjustment);
}

export async function createTaxAdjustment({ supabase, businessId, taxYear, input = {}, userId } = {}) {
  const row = normalizeAdjustmentInput(input, { businessId, taxYear, userId, creating: true });
  const { data, error } = await supabase.from("tax_adjustments").insert(row).select("*").single();
  if (error) throw error;
  return sanitizeAdjustment(data || row);
}

export async function updateTaxAdjustment({ supabase, businessId, taxYear, adjustmentId, patch = {}, userId } = {}) {
  const year = requireTaxYear(taxYear);
  if (!adjustmentId) throw validationError("missing_adjustment_id", "adjustmentId is required.");
  assertProtectedFields(patch);
  const normalized = normalizeAdjustmentPatch(patch, { userId });
  const { data, error } = await supabase
    .from("tax_adjustments")
    .update({ ...normalized, updated_at: new Date().toISOString() })
    .eq("id", adjustmentId)
    .eq("business_id", businessId)
    .eq("tax_year", year)
    .select("*")
    .single();
  if (error) throw error;
  if (!data) throw notFoundError("tax_adjustment_not_found", "Tax adjustment was not found.");
  return sanitizeAdjustment(data);
}

export async function archiveTaxAdjustment({ supabase, businessId, taxYear, adjustmentId, userId } = {}) {
  return updateTaxAdjustment({
    supabase,
    businessId,
    taxYear,
    adjustmentId,
    userId,
    patch: {
      status: "archived",
      metadata: { archived_by: userId || null, archived_at: new Date().toISOString() },
    },
  });
}

export async function summarizeTaxAdjustments(args = {}) {
  const rows = await listTaxAdjustments(args);
  return summarizeAdjustmentRows(rows);
}

export function summarizeAdjustmentRows(rows = []) {
  const summary = {
    increasesToTaxableIncome: 0,
    decreasesToTaxableIncome: 0,
    increasesToTax: 0,
    decreasesToTax: 0,
    items: [],
  };
  for (const row of rows) {
    const amount = Math.abs(Number(row.amount || 0));
    if (row.direction === TAX_ADJUSTMENT_DIRECTIONS.INCREASE_TAXABLE_INCOME) summary.increasesToTaxableIncome += amount;
    if (row.direction === TAX_ADJUSTMENT_DIRECTIONS.DECREASE_TAXABLE_INCOME) summary.decreasesToTaxableIncome += amount;
    if (row.direction === TAX_ADJUSTMENT_DIRECTIONS.INCREASE_TAX) summary.increasesToTax += amount;
    if (row.direction === TAX_ADJUSTMENT_DIRECTIONS.DECREASE_TAX) summary.decreasesToTax += amount;
    summary.items.push(row);
  }
  for (const key of ["increasesToTaxableIncome", "decreasesToTaxableIncome", "increasesToTax", "decreasesToTax"]) {
    summary[key] = round2(summary[key]);
  }
  return summary;
}

function normalizeAdjustmentInput(input, { businessId, taxYear, userId, creating }) {
  const year = requireTaxYear(taxYear ?? input.taxYear ?? input.tax_year);
  const patch = normalizeAdjustmentPatch(input, { userId });
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  if (!patch.reason) throw validationError("missing_adjustment_reason", "A reason is required for tax adjustments.", { field: "reason" });
  if (!patch.adjustment_type) throw validationError("missing_adjustment_type", "adjustmentType is required.", { field: "adjustmentType" });
  if (!patch.direction) throw validationError("missing_adjustment_direction", "direction is required.", { field: "direction" });
  if (patch.amount == null) throw validationError("missing_adjustment_amount", "amount is required.", { field: "amount" });
  const now = new Date().toISOString();
  return {
    business_id: businessId,
    tax_year: year,
    status: patch.status || "active",
    source: patch.source || TAX_CLASSIFICATION_SOURCES.USER,
    created_by: userId || input.created_by || null,
    created_at: creating ? now : undefined,
    updated_at: now,
    ...patch,
  };
}

function normalizeAdjustmentPatch(input = {}, { userId } = {}) {
  const direction = input.direction == null ? undefined : String(input.direction).trim().toLowerCase();
  if (direction && !DIRECTIONS.has(direction)) {
    throw validationError("invalid_adjustment_direction", "Tax adjustment direction is not supported.", { field: "direction" });
  }
  const amount = input.amount == null ? undefined : normalizeMoney(input.amount);
  if (input.amount != null && (amount == null || amount < 0)) {
    throw validationError("invalid_adjustment_amount", "Adjustment amount must be a nonnegative finite number.", { field: "amount" });
  }
  const source = input.source == null ? undefined : String(input.source).trim().toLowerCase();
  if (source && !SOURCES.has(source)) {
    throw validationError("invalid_adjustment_source", "Tax adjustment source is not supported.", { field: "source" });
  }
  const effectiveDate = input.effectiveDate ?? input.effective_date;
  const normalizedDate = effectiveDate == null ? undefined : normalizeDateOnly(effectiveDate);
  if (effectiveDate != null && !normalizedDate) {
    throw validationError("invalid_effective_date", "effectiveDate must be YYYY-MM-DD.", { field: "effectiveDate" });
  }
  const reason = input.reason == null ? undefined : String(input.reason).trim();
  if (input.reason != null && (!reason || reason.length > 1200)) {
    throw validationError("invalid_adjustment_reason", "Adjustment reason is required and must be under 1200 characters.", { field: "reason" });
  }
  const metadata = input.metadata == null ? undefined : normalizeMetadata(input.metadata);
  return removeUndefined({
    adjustment_type: input.adjustmentType ?? input.adjustment_type,
    direction,
    amount,
    effective_date: normalizedDate,
    source,
    reason,
    status: input.status == null ? undefined : String(input.status).trim().toLowerCase(),
    confidence_score: input.confidenceScore ?? input.confidence_score,
    metadata: metadata == null ? undefined : { ...metadata, last_touched_by: userId || null },
  });
}

function assertProtectedFields(patch) {
  for (const field of ["id", "business_id", "businessId", "tax_year", "taxYear", "created_at", "created_by"]) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      throw validationError("protected_adjustment_field", `${field} cannot be changed through this operation.`, { field });
    }
  }
}

function sanitizeAdjustment(row) {
  return {
    ...row,
    adjustmentType: row.adjustment_type ?? row.adjustmentType,
    effectiveDate: row.effective_date ?? row.effectiveDate,
  };
}

function isArchived(row) {
  return row.archived === true || row.is_archived === true || ARCHIVED_STATUSES.has(String(row.status || "").toLowerCase());
}

function normalizeMetadata(value) {
  if (Array.isArray(value) || typeof value !== "object") {
    throw validationError("invalid_adjustment_metadata", "metadata must be an object.", { field: "metadata" });
  }
  const text = JSON.stringify(value);
  if (text.length > 8000) throw validationError("adjustment_metadata_too_large", "metadata is too large.", { field: "metadata" });
  return { ...value };
}

function requireTaxYear(value) {
  const year = normalizeTaxYear(value);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  return year;
}

function removeUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

export const TAX_ADJUSTMENT_ACTIVE_STATUSES = ACTIVE_STATUSES;
