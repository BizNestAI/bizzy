// File: /src/api/accounting/bookkeepingHealth.js
import { supabase } from "../../services/supabaseAdmin.js";

export async function getBookkeepingHealth(businessId) {
  if (!businessId) return null;
  const { data, error } = await supabase
    .from("bookkeeping_health")
    .select("business_id, status, uncategorized_count, needs_review_count, confidence_score, last_sync_at, last_evaluated_at, notes, created_at, updated_at")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) {
    const msg = error?.message || "";
    if (/relation .*bookkeeping_health.* does not exist/i.test(msg)) {
      return {
        status: "unknown",
        uncategorized_count: null,
        needs_review_count: null,
        confidence_score: null,
        last_updated: null,
        note: "bookkeeping_health_not_configured",
      };
    }
    console.warn("[bookkeeping_health] fetch failed:", error.message || error);
    return {
      status: "unknown",
      uncategorized_count: null,
      needs_review_count: null,
      confidence_score: null,
      last_updated: null,
      note: "bookkeeping_health_error",
    };
  }
  if (!data) {
    return {
      status: "unknown",
      uncategorized_count: null,
      needs_review_count: null,
      confidence_score: null,
      last_sync_at: null,
      last_evaluated_at: null,
      notes: null,
      created_at: null,
      updated_at: null,
    };
  }
  return data;
}

export async function upsertBookkeepingHealth({ businessId, uncategorizedCount, lastSyncAt, lastCleanupAt }) {
  if (!businessId) return null;
  const payload = {
    business_id: businessId,
    uncategorized_count: uncategorizedCount ?? null,
    last_sync_at: lastSyncAt || null,
    last_cleanup_at: lastCleanupAt || null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from("bookkeeping_health")
    .upsert(payload, { onConflict: "business_id" })
    .select()
    .maybeSingle();
  if (error) {
    console.warn("[bookkeeping_health] upsert failed", error.message || error);
    return null;
  }
  return data || null;
}
