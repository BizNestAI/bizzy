const DEFAULT_STRIPE_WEBHOOK_EVENTS_TABLE = "stripe_webhook_events";

export async function claimStripeWebhookEventForProcessing({
  supabaseClient,
  event,
  stripeMode = null,
  now = new Date(),
  leaseMs = 5 * 60 * 1000,
  tableName = DEFAULT_STRIPE_WEBHOOK_EVENTS_TABLE,
} = {}) {
  if (!supabaseClient) {
    throw new Error("Stripe webhook idempotency requires a Supabase client.");
  }

  const eventId = String(event?.id || "").trim();
  if (!eventId) {
    const error = new Error("Stripe webhook event id is missing.");
    error.code = "stripe_event_id_missing";
    throw error;
  }
  const nowIso = now.toISOString();
  const staleBeforeIso = new Date(now.getTime() - leaseMs).toISOString();

  const { data, error } = await supabaseClient
    .from(tableName)
    .insert({
      event_id: eventId,
      event_type: event.type || null,
      stripe_mode: stripeMode,
      processing_status: "processing",
      processing_started_at: nowIso,
      attempt_count: 1,
    })
    .select("id,event_id,processing_status,processing_started_at,attempt_count")
    .single();

  if (!error) return { claimed: true, status: "new", row: data };
  if (error.code !== "23505") throw error;

  const { data: existing, error: readError } = await supabaseClient
    .from(tableName)
    .select("id,event_id,processing_status,processing_started_at,attempt_count")
    .eq("event_id", eventId)
    .maybeSingle();
  if (readError) throw readError;

  if (existing?.processing_status === "processed") {
    return { claimed: false, duplicate: true, status: "processed", row: existing };
  }

  const startedAtMs = existing?.processing_started_at ? new Date(existing.processing_started_at).getTime() : NaN;
  const isStaleProcessing =
    existing?.processing_status === "processing" &&
    (!Number.isFinite(startedAtMs) || existing.processing_started_at < staleBeforeIso);

  if (existing?.processing_status === "processing" && !isStaleProcessing) {
    return { claimed: false, duplicate: true, status: "active_processing", row: existing };
  }

  const nextAttemptCount = Number(existing?.attempt_count || 0) + 1;
  let reclaim = supabaseClient
    .from(tableName)
    .update({
      processing_status: "processing",
      processing_started_at: nowIso,
      attempt_count: nextAttemptCount,
      failed_at: null,
      error_code: null,
      error_message: null,
    })
    .eq("event_id", eventId);

  if (existing?.processing_status === "failed") {
    reclaim = reclaim.eq("processing_status", "failed");
  } else if (isStaleProcessing) {
    reclaim = reclaim
      .eq("processing_status", "processing")
      .lt("processing_started_at", staleBeforeIso);
  } else {
    return { claimed: false, duplicate: true, status: "not_reclaimable", row: existing };
  }

  const { data: reclaimedRows, error: reclaimError } = await reclaim
    .select("id,event_id,processing_status,processing_started_at,attempt_count");
  if (reclaimError) throw reclaimError;
  const reclaimed = Array.isArray(reclaimedRows) ? reclaimedRows[0] : reclaimedRows;
  if (!reclaimed) {
    return { claimed: false, duplicate: true, status: "claim_race_lost", row: existing };
  }

  return {
    claimed: true,
    status: existing?.processing_status === "failed" ? "reclaimed_failed" : "reclaimed_stale_processing",
    row: reclaimed,
  };
}
