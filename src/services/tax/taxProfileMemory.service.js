// /src/services/tax/taxProfileMemory.service.js
import { normalizeConfidenceScore, normalizeDateOnly } from "./taxDomain.js";
import { TAX_PROFILE_SOURCES } from "./taxDomain.js";
import { validationError, conflictError, notFoundError } from "./taxErrors.js";
import { validateTaxMemoryValue } from "./taxMemoryKeys.js";

const SOURCE_TRUST = Object.freeze({
  cpa: 5,
  user: 4,
  imported: 3,
  rule_engine: 2,
  inferred: 1,
  system: 1,
});

export async function getActiveTaxMemories({ supabase, businessId, asOfDate } = {}) {
  assertBase({ supabase, businessId });
  let query = supabase.from("tax_profile_memory").select("*").eq("business_id", businessId);
  if (asOfDate) {
    const date = normalizeDateOnly(asOfDate);
    if (!date) throw validationError("invalid_as_of_date", "asOfDate must be YYYY-MM-DD.");
    query = query.lte("effective_from", date).or(`effective_to.is.null,effective_to.gte.${date}`);
  } else {
    query = query.is("effective_to", null);
  }
  const { data, error } = await query.order("memory_key", { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function getTaxMemory({ supabase, businessId, memoryKey, asOfDate } = {}) {
  assertBase({ supabase, businessId, memoryKey });
  let query = supabase
    .from("tax_profile_memory")
    .select("*")
    .eq("business_id", businessId)
    .eq("memory_key", memoryKey);
  if (asOfDate) {
    const date = normalizeDateOnly(asOfDate);
    if (!date) throw validationError("invalid_as_of_date", "asOfDate must be YYYY-MM-DD.");
    query = query.lte("effective_from", date).or(`effective_to.is.null,effective_to.gte.${date}`);
  } else {
    query = query.is("effective_to", null);
  }
  const { data, error } = await query.order("effective_from", { ascending: false }).limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

export async function setTaxMemory({
  supabase,
  businessId,
  memoryKey,
  value,
  source = TAX_PROFILE_SOURCES.USER,
  confidenceScore,
  confirmedBy,
  confirmedAt,
  effectiveFrom,
  notes,
  metadata,
} = {}) {
  assertBase({ supabase, businessId, memoryKey });
  const normalizedValue = validateTaxMemoryValue(memoryKey, value);
  const from = normalizeDateOnly(effectiveFrom) || new Date().toISOString().slice(0, 10);
  const normalizedSource = String(source || TAX_PROFILE_SOURCES.USER).trim().toLowerCase();
  const active = await getTaxMemory({ supabase, businessId, memoryKey });
  if (active && isLowerTrustReplacement(active, { source: normalizedSource, confirmedBy })) {
    throw conflictError("confirmed_tax_memory_protected", "A confirmed tax memory cannot be replaced by a lower-trust inferred value.", {
      memoryKey,
    });
  }

  // Transaction limitation: this project does not expose a tax-memory RPC yet.
  // We expire the active row first, then insert the new row. The partial unique
  // index protects against duplicate active rows if concurrent requests race.
  if (active) {
    const { error: expireError } = await supabase
      .from("tax_profile_memory")
      .update({ effective_to: from, updated_at: new Date().toISOString() })
      .eq("business_id", businessId)
      .eq("memory_key", memoryKey)
      .is("effective_to", null);
    if (expireError) throw expireError;
  }

  const row = {
    business_id: businessId,
    memory_key: memoryKey,
    value_json: normalizedValue,
    effective_from: from,
    effective_to: null,
    source: normalizedSource,
    confidence_score: normalizeConfidenceScore(confidenceScore) ?? defaultConfidence(normalizedSource),
    confirmed_by: confirmedBy || null,
    confirmed_at: confirmedAt || (confirmedBy ? new Date().toISOString() : null),
    last_reviewed_at: null,
    notes: notes || null,
    metadata: metadata || {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase.from("tax_profile_memory").insert(row).select("*").single();
  if (error) throw error;
  return data;
}

export async function expireTaxMemory({ supabase, businessId, memoryKey, effectiveTo, userId } = {}) {
  assertBase({ supabase, businessId, memoryKey });
  const to = normalizeDateOnly(effectiveTo) || new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("tax_profile_memory")
    .update({
      effective_to: to,
      updated_at: new Date().toISOString(),
      metadata: { expired_by: userId || null },
    })
    .eq("business_id", businessId)
    .eq("memory_key", memoryKey)
    .is("effective_to", null)
    .select("*");
  if (error) throw error;
  return data || [];
}

export async function listTaxMemoryHistory({ supabase, businessId, memoryKey, limit = 50, offset = 0 } = {}) {
  assertBase({ supabase, businessId, memoryKey });
  const { data, error } = await supabase
    .from("tax_profile_memory")
    .select("*")
    .eq("business_id", businessId)
    .eq("memory_key", memoryKey)
    .order("effective_from", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
}

export function mergeTaxMemoryIntoContext({ profile, memories = [], asOfDate } = {}) {
  const memoryMap = {};
  for (const memory of memories || []) {
    memoryMap[memory.memory_key] = {
      value: memory.value_json,
      source: memory.source,
      confidence_score: memory.confidence_score,
      effective_from: memory.effective_from,
      effective_to: memory.effective_to,
    };
  }
  return {
    profile,
    taxMemory: memoryMap,
    asOfDate: asOfDate || new Date().toISOString().slice(0, 10),
  };
}

export async function updateTaxMemoryMetadata({ supabase, businessId, id, patch = {}, userId } = {}) {
  assertBase({ supabase, businessId });
  if (!id) throw validationError("missing_tax_memory_id", "Tax memory id is required.");
  const allowed = {};
  if ("notes" in patch) allowed.notes = patch.notes || null;
  if ("confirmedBy" in patch || "confirmed_by" in patch) allowed.confirmed_by = patch.confirmedBy || patch.confirmed_by || userId || null;
  if ("confirmedAt" in patch || "confirmed_at" in patch) allowed.confirmed_at = patch.confirmedAt || patch.confirmed_at || new Date().toISOString();
  if ("lastReviewedAt" in patch || "last_reviewed_at" in patch) allowed.last_reviewed_at = patch.lastReviewedAt || patch.last_reviewed_at || new Date().toISOString();
  if ("metadata" in patch) allowed.metadata = patch.metadata || {};
  allowed.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from("tax_profile_memory")
    .update(allowed)
    .eq("business_id", businessId)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  if (!data) throw notFoundError("tax_memory_not_found", "Tax memory was not found.");
  return data;
}

function isLowerTrustReplacement(active, incoming) {
  const activeTrust = active.confirmed_by ? 4 : SOURCE_TRUST[String(active.source || "").toLowerCase()] || 0;
  const incomingTrust = incoming.confirmedBy ? 4 : SOURCE_TRUST[String(incoming.source || "").toLowerCase()] || 0;
  return activeTrust >= 4 && incomingTrust < activeTrust;
}

function defaultConfidence(source) {
  if (source === TAX_PROFILE_SOURCES.CPA) return 0.95;
  if (source === TAX_PROFILE_SOURCES.USER) return 0.85;
  if (source === TAX_PROFILE_SOURCES.IMPORTED) return 0.7;
  return 0.35;
}

function assertBase({ supabase, businessId, memoryKey }) {
  if (!supabase) throw validationError("missing_supabase", "Supabase client is required.");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  if (memoryKey != null && !String(memoryKey).trim()) {
    throw validationError("missing_tax_memory_key", "memoryKey is required.");
  }
}
