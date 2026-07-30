import {
  DEFAULT_RECENT_RUN_FRESH_HOURS,
  DEFAULT_TAX_SCHEDULER_PAGE_SIZE,
  TAX_SCHEDULER_ELIGIBILITY_REASONS,
} from "./taxScheduleDomain.js";

const SUPPORTED_ENTITIES = new Set(["sole_proprietor", "single_member_llc", "s_corp", "s_corporation"]);
const INCOMPLETE_PROFILE_STATUSES = new Set(["incomplete", "missing", "unknown"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "partial"]);

export async function getBusinessesEligibleForTaxCalculation({
  supabase,
  taxYear,
  page = 0,
  pageSize = DEFAULT_TAX_SCHEDULER_PAGE_SIZE,
  now = new Date(),
  freshnessHours = DEFAULT_RECENT_RUN_FRESH_HOURS,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const businesses = await listCandidateBusinesses({ supabase, taxYear, page, pageSize });
  const results = [];
  for (const business of businesses) {
    results.push(await evaluateBusinessTaxCalculationEligibility({
      supabase,
      business,
      businessId: business.id || business.business_id,
      taxYear,
      now,
      freshnessHours,
    }));
  }
  return {
    page,
    pageSize,
    hasMore: businesses.length === pageSize,
    businesses: results,
  };
}

export async function evaluateBusinessTaxCalculationEligibility({
  supabase,
  business = null,
  businessId,
  taxYear,
  now = new Date(),
  freshnessHours = DEFAULT_RECENT_RUN_FRESH_HOURS,
} = {}) {
  const id = businessId || business?.id || business?.business_id;
  if (!id) return result({ eligible: false, businessId: null, taxYear, reason: TAX_SCHEDULER_ELIGIBILITY_REASONS.DISABLED });
  if (business && isBusinessDisabled(business)) return result({ eligible: false, businessId: id, taxYear, reason: TAX_SCHEDULER_ELIGIBILITY_REASONS.DISABLED });
  if (business && !hasBusinessOwner(business)) return result({ eligible: false, businessId: id, taxYear, reason: TAX_SCHEDULER_ELIGIBILITY_REASONS.NO_BUSINESS_OWNER });

  const profile = await latestProfile({ supabase, businessId: id, taxYear });
  if (!profile) return result({ eligible: false, businessId: id, taxYear, reason: TAX_SCHEDULER_ELIGIBILITY_REASONS.PROFILE_INCOMPLETE });
  if (isProfileIncomplete(profile)) return result({ eligible: false, businessId: id, taxYear, reason: TAX_SCHEDULER_ELIGIBILITY_REASONS.PROFILE_INCOMPLETE, profile });
  if (isUnsupportedEntity(profile)) return result({ eligible: false, businessId: id, taxYear, reason: TAX_SCHEDULER_ELIGIBILITY_REASONS.UNSUPPORTED_ENTITY, profile });

  const running = await hasActiveCalculation({ supabase, businessId: id, taxYear, now });
  if (running) return result({ eligible: false, businessId: id, taxYear, reason: TAX_SCHEDULER_ELIGIBILITY_REASONS.CALCULATION_RUNNING, profile });

  const hasTransactions = await hasPostedTransactions({ supabase, businessId: id, taxYear });
  if (!hasTransactions) return result({ eligible: false, businessId: id, taxYear, reason: TAX_SCHEDULER_ELIGIBILITY_REASONS.NO_POSTED_TRANSACTIONS, profile });

  const latestRun = await latestCompletedRun({ supabase, businessId: id, taxYear });
  if (latestRun && isFresh(latestRun.completed_at || latestRun.updated_at || latestRun.created_at, now, freshnessHours)) {
    return result({ eligible: false, businessId: id, taxYear, reason: TAX_SCHEDULER_ELIGIBILITY_REASONS.RECENT_RUN_FRESH, profile, latestRun });
  }

  return result({ eligible: true, businessId: id, taxYear, reason: TAX_SCHEDULER_ELIGIBILITY_REASONS.ELIGIBLE, profile, latestRun });
}

async function listCandidateBusinesses({ supabase, taxYear, page, pageSize }) {
  if (supabase.store) {
    const rows = supabase.store.business_profiles || supabase.store.businesses || [];
    if (rows.length) return rows.slice(page * pageSize, page * pageSize + pageSize);
    const ids = new Set();
    for (const table of ["tax_profiles", "qbo_posted_transactions", "transaction_tax_classifications", "tax_payments"]) {
      for (const row of supabase.store[table] || []) {
        if (!taxYear || !row.tax_year || Number(row.tax_year) === Number(taxYear)) ids.add(row.business_id);
      }
    }
    return Array.from(ids).filter(Boolean).map((id) => ({ id, owner_user_id: "store-owner" })).slice(page * pageSize, page * pageSize + pageSize);
  }

  const from = page * pageSize;
  const to = from + pageSize - 1;
  const { data, error } = await supabase
    .from("business_profiles")
    .select("id,business_id,owner_user_id,user_id,status,is_active,deleted_at,disabled_at,timezone,metadata")
    .range(from, to);
  if (!error && data?.length) return data;

  return fallbackCandidateBusinesses({ supabase, taxYear, from, to });
}

async function fallbackCandidateBusinesses({ supabase, taxYear, from, to }) {
  const ids = new Set();
  for (const table of ["tax_profiles", "qbo_posted_transactions", "transaction_tax_classifications", "tax_payments"]) {
    try {
      let query = supabase.from(table).select("business_id").not("business_id", "is", null).range(from, to);
      if (taxYear) query = query.eq("tax_year", taxYear);
      const { data } = await query;
      for (const row of data || []) ids.add(row.business_id);
    } catch {
      // Optional source tables should not make the scheduler fail globally.
    }
  }
  return Array.from(ids).map((id) => ({ id, owner_user_id: "unknown" }));
}

async function latestProfile({ supabase, businessId, taxYear }) {
  if (supabase.store) {
    return (supabase.store.tax_profiles || [])
      .filter((row) => row.business_id === businessId && Number(row.tax_year) === Number(taxYear))
      .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))[0] || null;
  }
  const { data, error } = await supabase
    .from("tax_profiles")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data || null;
}

async function hasPostedTransactions({ supabase, businessId, taxYear }) {
  if (supabase.store) {
    return ["qbo_posted_transactions", "transaction_tax_classifications", "transaction_categorizations"].some((table) =>
      (supabase.store[table] || []).some((row) => row.business_id === businessId && rowInYear(row, taxYear))
    );
  }
  for (const table of ["qbo_posted_transactions", "transaction_tax_classifications", "transaction_categorizations"]) {
    try {
      const { data, error } = await supabase.from(table).select("id").eq("business_id", businessId).limit(1);
      if (!error && data?.length) return true;
    } catch {
      // Continue to next source.
    }
  }
  return false;
}

async function hasActiveCalculation({ supabase, businessId, taxYear, now }) {
  const staleCutoffMs = now.getTime() - 30 * 60 * 1000;
  if (supabase.store) {
    return (supabase.store.tax_calculation_runs || []).some((row) =>
      row.business_id === businessId &&
      Number(row.tax_year) === Number(taxYear) &&
      row.status === "running" &&
      new Date(row.started_at || row.created_at || 0).getTime() > staleCutoffMs
    );
  }
  const { data } = await supabase
    .from("tax_calculation_runs")
    .select("id,started_at,created_at,status")
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .eq("status", "running")
    .limit(1);
  return (data || []).some((row) => new Date(row.started_at || row.created_at || 0).getTime() > staleCutoffMs);
}

async function latestCompletedRun({ supabase, businessId, taxYear }) {
  if (supabase.store) {
    return (supabase.store.tax_calculation_runs || [])
      .filter((row) => row.business_id === businessId && Number(row.tax_year) === Number(taxYear) && TERMINAL_RUN_STATUSES.has(row.status))
      .sort((a, b) => new Date(b.completed_at || b.updated_at || b.created_at || 0) - new Date(a.completed_at || a.updated_at || a.created_at || 0))[0] || null;
  }
  const { data } = await supabase
    .from("tax_calculation_runs")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .in("status", Array.from(TERMINAL_RUN_STATUSES))
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

function result({ eligible, businessId, taxYear, reason, profile = null, latestRun = null }) {
  return { businessId, taxYear, eligible, reason, profile, latestRun };
}

function isBusinessDisabled(business) {
  if (business.deleted_at || business.disabled_at) return true;
  if (business.is_active === false) return true;
  return ["disabled", "deleted", "archived"].includes(String(business.status || "").toLowerCase());
}

function hasBusinessOwner(business) {
  return Boolean(business.owner_user_id || business.user_id || business.owner_id || business.metadata?.ownerUserId || business.metadata?.owner_user_id);
}

function isProfileIncomplete(profile) {
  const status = String(profile.profile_status || profile.status || "").toLowerCase();
  if (INCOMPLETE_PROFILE_STATUSES.has(status)) return true;
  if (!profile.filing_status || profile.filing_status === "unknown") return true;
  if (!profile.primary_tax_state || profile.primary_tax_state === "unknown") return true;
  if (!profile.entity_type || profile.entity_type === "unknown") return true;
  if (profile.entity_type === "single_member_llc" && (!profile.tax_election || profile.tax_election === "unknown")) return true;
  return false;
}

function isUnsupportedEntity(profile) {
  return !SUPPORTED_ENTITIES.has(String(profile.entity_type || "").toLowerCase());
}

function rowInYear(row, taxYear) {
  if (!taxYear) return true;
  const raw = row.tax_year || row.date || row.transaction_date || row.posted_at || row.created_at;
  if (!raw) return true;
  return String(raw).slice(0, 4) === String(taxYear);
}

function isFresh(dateValue, now, freshnessHours) {
  const ts = new Date(dateValue || 0).getTime();
  return Number.isFinite(ts) && now.getTime() - ts < freshnessHours * 60 * 60 * 1000;
}
