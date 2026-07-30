import crypto from "node:crypto";
import { normalizeTaxYear } from "../taxDomain.js";
import { validationError } from "../taxErrors.js";
import { TAX_RECALCULATION_PRIORITIES, isSupportedTaxRecalculationEvent } from "./taxRecalculationEventDomain.js";

const SAFE_BEFORE_AFTER_FIELDS = new Set([
  "amount",
  "book_amount",
  "tax_category",
  "deductibility_status",
  "deductible_percent",
  "deductible_amount",
  "classification_status",
  "entity_type",
  "tax_election",
  "filing_status",
  "primary_tax_state",
  "accounting_method",
  "safe_harbor_method",
  "prior_year_total_tax",
  "prior_year_agi",
  "jurisdiction",
  "payment_type",
  "status",
  "is_primary",
  "manual_balance",
]);

const SENSITIVE_KEY_RE = /(token|secret|password|payload|raw|account_number|access_token|refresh_token|plaid|qbo_payload)/i;

export function createTaxRecalculationEvent(input = {}) {
  const businessId = stringOrNull(input.businessId || input.business_id);
  const eventType = stringOrNull(input.eventType || input.event_type);
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  if (!isSupportedTaxRecalculationEvent(eventType)) {
    throw validationError("unsupported_tax_recalculation_event", "Unsupported tax recalculation event.", { eventType });
  }
  const taxYear = resolveTaxYear(input.taxYear ?? input.tax_year ?? input.after?.tax_year ?? input.before?.tax_year);
  const occurredAt = validIso(input.occurredAt || input.occurred_at) || new Date().toISOString();
  const sourceRecordId = stringOrNull(input.sourceRecordId || input.source_record_id || input.entityId);
  const sourceTable = stringOrNull(input.sourceTable || input.source_table);
  const correlationId = stringOrNull(input.correlationId || input.correlation_id) || sourceRecordId || null;
  const event = {
    eventId: stringOrNull(input.eventId || input.event_id) || deterministicEventId({
      eventType,
      businessId,
      taxYear,
      sourceRecordId,
      sourceTable,
      occurredAt: occurredAt.slice(0, 19),
    }),
    eventType,
    businessId,
    userId: stringOrNull(input.userId || input.user_id),
    taxYear,
    occurredAt,
    source: stringOrNull(input.source) || "bizzi",
    sourceRecordId,
    sourceTable,
    triggerPriority: normalizePriority(input.triggerPriority || input.priority),
    materiality: sanitizeMateriality(input.materiality),
    changedFields: sanitizeChangedFields(input.changedFields || input.changed_fields),
    before: sanitizeObject(input.before),
    after: sanitizeObject(input.after),
    correlationId,
    causationId: stringOrNull(input.causationId || input.causation_id),
    metadata: sanitizeObject(input.metadata),
  };
  return event;
}

export function deterministicEventId(parts = {}) {
  const stable = JSON.stringify({
    eventType: parts.eventType,
    businessId: parts.businessId,
    taxYear: parts.taxYear,
    sourceTable: parts.sourceTable || null,
    sourceRecordId: parts.sourceRecordId || null,
    occurredAt: parts.occurredAt || null,
  });
  return `taxevt_${crypto.createHash("sha256").update(stable).digest("hex").slice(0, 32)}`;
}

export function sanitizeObject(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 1) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) continue;
    if (SAFE_BEFORE_AFTER_FIELDS.has(key) || depth > 0) {
      if (raw == null || ["string", "number", "boolean"].includes(typeof raw)) out[key] = raw;
      else if (typeof raw === "object") out[key] = sanitizeObject(raw, depth + 1);
    }
  }
  return out;
}

export function sanitizeChangedFields(fields) {
  if (!Array.isArray(fields)) return [];
  return [...new Set(fields.map((field) => String(field || "").trim()).filter((field) => field && !SENSITIVE_KEY_RE.test(field)))].slice(0, 50);
}

function sanitizeMateriality(materiality = {}) {
  return {
    amount: nullableNumber(materiality.amount),
    percentOfRevenue: nullableNumber(materiality.percentOfRevenue),
    percentOfProjectedTax: nullableNumber(materiality.percentOfProjectedTax),
    transactionCount: nullableNumber(materiality.transactionCount),
    classificationBucketChanged: materiality.classificationBucketChanged === true,
  };
}

function normalizePriority(value) {
  const priority = String(value || TAX_RECALCULATION_PRIORITIES.NORMAL).toLowerCase();
  return Object.values(TAX_RECALCULATION_PRIORITIES).includes(priority) ? priority : TAX_RECALCULATION_PRIORITIES.NORMAL;
}

function resolveTaxYear(value) {
  return normalizeTaxYear(value ?? new Date().getFullYear());
}

function nullableNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOrNull(value) {
  const string = String(value || "").trim();
  return string || null;
}

function validIso(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
