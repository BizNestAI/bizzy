import { TAX_RECALCULATION_EVENT_TYPES as EVENTS, TAX_RECALCULATION_PRIORITIES } from "../events/taxRecalculationEventDomain.js";
import { handleTaxRecalculationEvent } from "../events/taxRecalculationTrigger.service.js";
import { DEFAULT_RESERVE_STALE_HOURS, TAX_SCHEDULE_JOB_TYPES } from "./taxScheduleDomain.js";

export async function runTaxReserveFreshnessScan({
  supabase,
  businessId,
  taxYear,
  now = new Date(),
  staleHours = DEFAULT_RESERVE_STALE_HOURS,
  handleEvent = handleTaxRecalculationEvent,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const account = await loadPrimaryReserveAccount({ supabase, businessId });
  if (!account) {
    return {
      jobType: TAX_SCHEDULE_JOB_TYPES.DAILY_RESERVE_REFRESH,
      businessId,
      taxYear,
      reserveReady: false,
      currentReserve: null,
      queued: false,
      reason: "reserve_account_missing",
    };
  }
  const lastVerified = account.last_verified_at || account.last_balance_refresh_at || account.updated_at || account.created_at;
  const stale = !lastVerified || now.getTime() - new Date(lastVerified).getTime() > staleHours * 60 * 60 * 1000;
  if (!stale) {
    return {
      jobType: TAX_SCHEDULE_JOB_TYPES.DAILY_RESERVE_REFRESH,
      businessId,
      taxYear,
      reserveReady: true,
      currentReserve: account.current_balance ?? account.manual_balance ?? null,
      queued: false,
      reason: "reserve_fresh",
    };
  }
  const event = {
    eventId: `daily_tax_reserve_refresh:${businessId}:${taxYear}:${now.toISOString().slice(0, 10)}`,
    eventType: EVENTS.TAX_RESERVE_BALANCE_REFRESHED,
    businessId,
    taxYear,
    occurredAt: now.toISOString(),
    source: "tax_scheduler_daily",
    sourceRecordId: account.id || businessId,
    sourceTable: "tax_reserve_accounts",
    triggerPriority: TAX_RECALCULATION_PRIORITIES.LOW,
    materiality: { amount: 0 },
    changedFields: ["current_balance"],
    metadata: { schedulerJobType: TAX_SCHEDULE_JOB_TYPES.DAILY_RESERVE_REFRESH, staleHours },
  };
  const queued = await handleEvent({ supabase, event, force: false, now });
  return {
    jobType: TAX_SCHEDULE_JOB_TYPES.DAILY_RESERVE_REFRESH,
    businessId,
    taxYear,
    reserveReady: true,
    currentReserve: account.current_balance ?? account.manual_balance ?? null,
    queued: Boolean(queued?.queued),
    reason: stale ? "reserve_stale" : "reserve_fresh",
    request: queued?.request || null,
  };
}

async function loadPrimaryReserveAccount({ supabase, businessId }) {
  if (supabase.store) {
    return (supabase.store.tax_reserve_accounts || [])
      .filter((row) => row.business_id === businessId && row.is_active !== false)
      .sort((a, b) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)))[0] || null;
  }
  const { data, error } = await supabase
    .from("tax_reserve_accounts")
    .select("*")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .order("is_primary", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data || null;
}

export default runTaxReserveFreshnessScan;
