import { normalizeTaxYear } from "../taxDomain.js";
import { validationError } from "../taxErrors.js";
import { createTaxRecalculationEvent } from "./taxRecalculationEvent.js";
import {
  TAX_RECALCULATION_OUTCOMES,
  TAX_RECALCULATION_REQUEST_STATUSES,
  isNonRecalculationEvent,
} from "./taxRecalculationEventDomain.js";
import { compatibleForCoalescing, evaluateTaxRecalculationPolicy } from "./taxRecalculationPolicy.js";

export async function handleTaxRecalculationEvent({ supabase, event, force = false, now = new Date() } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (isNonRecalculationEvent(event?.eventType || event?.event_type)) {
    return { outcome: TAX_RECALCULATION_OUTCOMES.SKIP_UNSUPPORTED, queued: false, reason: "Calculation output events do not trigger recalculation." };
  }
  const canonicalEvent = createTaxRecalculationEvent(event);
  await validateBusinessExistsBestEffort({ supabase, businessId: canonicalEvent.businessId });
  const policy = evaluateTaxRecalculationPolicy(canonicalEvent, { force, now });
  if (!policy.shouldQueue) {
    return { event: canonicalEvent, outcome: policy.outcome, queued: false, reason: policy.reason };
  }
  const duplicate = await findRequestByEventId({ supabase, eventId: canonicalEvent.eventId });
  if (duplicate) {
    return { event: canonicalEvent, request: duplicate, outcome: TAX_RECALCULATION_OUTCOMES.SKIP_DUPLICATE, queued: false };
  }
  const coalesced = await coalescePendingRequest({ supabase, event: canonicalEvent, policy });
  if (coalesced) {
    return { event: canonicalEvent, request: coalesced, outcome: TAX_RECALCULATION_OUTCOMES.DEBOUNCE, queued: true, coalesced: true };
  }
  const request = await insertRecalculationRequest({ supabase, event: canonicalEvent, policy });
  return { event: canonicalEvent, request, outcome: policy.outcome, queued: true, coalesced: false };
}

export async function recordRecalculationOutcome({ supabase, requestId, status, outcome, calculationRunId = null, error = null, metadata = {} } = {}) {
  const patch = {
    status,
    outcome,
    calculation_run_id: calculationRunId,
    completed_at: [TAX_RECALCULATION_REQUEST_STATUSES.COMPLETED, TAX_RECALCULATION_REQUEST_STATUSES.SKIPPED, TAX_RECALCULATION_REQUEST_STATUSES.DEAD_LETTER].includes(status) ? new Date().toISOString() : null,
    error_code: error?.code || null,
    error_message: sanitizeError(error?.message),
    metadata,
    updated_at: new Date().toISOString(),
  };
  if (supabase.store?.tax_recalculation_requests) {
    const row = supabase.store.tax_recalculation_requests.find((item) => item.id === requestId);
    if (row) Object.assign(row, patch);
    return row || null;
  }
  const { data, error: updateError } = await supabase
    .from("tax_recalculation_requests")
    .update(Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)))
    .eq("id", requestId)
    .select("*")
    .maybeSingle();
  if (updateError) throw updateError;
  return data;
}

async function insertRecalculationRequest({ supabase, event, policy }) {
  const nowIso = new Date().toISOString();
  const row = {
    business_id: event.businessId,
    tax_year: event.taxYear,
    event_type: event.eventType,
    trigger_source: policy.triggerSource,
    priority: policy.priority,
    status: TAX_RECALCULATION_REQUEST_STATUSES.PENDING,
    event_id: event.eventId,
    correlation_id: event.correlationId,
    source_record_id: event.sourceRecordId,
    source_table: event.sourceTable,
    first_event_at: event.occurredAt,
    last_event_at: event.occurredAt,
    process_after: policy.processAfter,
    attempt_count: 0,
    max_attempts: 5,
    metadata: requestMetadata(event, policy),
    created_at: nowIso,
    updated_at: nowIso,
  };
  if (supabase.store) {
    row.id = `tax_recalc_${event.eventId.slice(-24)}`;
    supabase.store.tax_recalculation_requests ||= [];
    supabase.store.tax_recalculation_requests.push(row);
    return row;
  }
  const { data, error } = await supabase.from("tax_recalculation_requests").insert(row).select("*").single();
  if (error) throw error;
  return data || row;
}

async function coalescePendingRequest({ supabase, event, policy }) {
  const pending = await listPendingCompatible({ supabase, event });
  const match = pending.find((row) => compatibleForCoalescing(row, event));
  if (!match) return null;
  const metadata = {
    ...(match.metadata || {}),
    coalescedEventCount: Number(match.metadata?.coalescedEventCount || 1) + 1,
    eventTypes: [...new Set([...(match.metadata?.eventTypes || [match.event_type]), event.eventType])].slice(0, 20),
    sourceRecordIds: [...new Set([...(match.metadata?.sourceRecordIds || []), event.sourceRecordId].filter(Boolean))].slice(0, 50),
    lastEventId: event.eventId,
  };
  const patch = {
    last_event_at: event.occurredAt,
    process_after: maxIso(match.process_after, policy.processAfter),
    priority: higherPriority(match.priority, policy.priority),
    metadata,
    updated_at: new Date().toISOString(),
  };
  if (supabase.store?.tax_recalculation_requests) {
    Object.assign(match, patch);
    return match;
  }
  const { data, error } = await supabase
    .from("tax_recalculation_requests")
    .update(patch)
    .eq("id", match.id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function findRequestByEventId({ supabase, eventId }) {
  if (supabase.store?.tax_recalculation_requests) {
    return supabase.store.tax_recalculation_requests.find((row) => row.event_id === eventId) || null;
  }
  const { data, error } = await supabase
    .from("tax_recalculation_requests")
    .select("*")
    .eq("event_id", eventId)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data || null;
}

async function listPendingCompatible({ supabase, event }) {
  if (supabase.store?.tax_recalculation_requests) {
    return supabase.store.tax_recalculation_requests.filter((row) =>
      row.business_id === event.businessId &&
      Number(row.tax_year) === Number(event.taxYear) &&
      row.status === TAX_RECALCULATION_REQUEST_STATUSES.PENDING
    );
  }
  const { data, error } = await supabase
    .from("tax_recalculation_requests")
    .select("*")
    .eq("business_id", event.businessId)
    .eq("tax_year", event.taxYear)
    .eq("status", TAX_RECALCULATION_REQUEST_STATUSES.PENDING)
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) return [];
  return data || [];
}

async function validateBusinessExistsBestEffort({ supabase, businessId }) {
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  if (supabase.store) return true;
  try {
    const { error } = await supabase.from("business_profiles").select("id").eq("id", businessId).limit(1).maybeSingle();
    if (error && !["42P01", "PGRST205"].includes(error.code)) throw error;
  } catch {
    // Business authorization is enforced at route/service boundaries; missing business_profiles
    // should not prevent a recoverable recalculation request from being queued.
  }
  return true;
}

function requestMetadata(event, policy) {
  return {
    materiality: event.materiality,
    changedFields: event.changedFields,
    before: event.before,
    after: event.after,
    source: event.source,
    userId: event.userId,
    causationId: event.causationId,
    eventTypes: [event.eventType],
    sourceRecordIds: [event.sourceRecordId].filter(Boolean),
    debounceSeconds: policy.debounceSeconds,
  };
}

function maxIso(a, b) {
  return new Date(a).getTime() > new Date(b).getTime() ? a : b;
}

function higherPriority(a, b) {
  const rank = { low: 1, normal: 2, high: 3, critical: 4 };
  return (rank[a] || 0) >= (rank[b] || 0) ? a : b;
}

function sanitizeError(message) {
  if (!message) return null;
  return String(message).replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]").slice(0, 1000);
}

export function normalizeRequestTaxYear(value) {
  const year = normalizeTaxYear(value);
  if (!year) throw validationError("invalid_tax_year", "Invalid tax year.");
  return year;
}
