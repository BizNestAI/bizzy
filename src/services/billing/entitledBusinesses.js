/* global process */
import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { FULL_ENTITLEMENT_STATUSES, normalizeEntitlementStatus } from "../../api/_shared/entitlementAuth.js";

function billingMode() {
  const requested = String(process.env.STRIPE_MODE || "").toLowerCase();
  if (requested === "test" || requested === "live") return requested;
  return process.env.NODE_ENV === "production" ? "live" : "test";
}

export async function filterEntitledBusinessIds(businessIds, { db = defaultSupabase, mode = billingMode() } = {}) {
  const ids = [...new Set((businessIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const scopedStatus = `subscription_status_${mode}`;
  if (db.store?.business_billing) {
    const eligible = new Set(db.store.business_billing
      .filter((row) => ids.includes(row.business_id))
      .filter((row) => FULL_ENTITLEMENT_STATUSES.has(normalizeEntitlementStatus(row[scopedStatus])))
      .map((row) => row.business_id));
    return ids.filter((id) => eligible.has(id));
  }
  const select = `business_id,${scopedStatus}`;
  const { data, error } = await db.from("business_billing").select(select).in("business_id", ids);
  if (error) throw error;
  const eligible = new Set((data || []).filter((row) => {
    const status = row[scopedStatus];
    return FULL_ENTITLEMENT_STATUSES.has(normalizeEntitlementStatus(status));
  }).map((row) => row.business_id));
  return ids.filter((id) => eligible.has(id));
}

export async function businessHasPaidEntitlement(businessId, options = {}) {
  return (await filterEntitledBusinessIds([businessId], options)).length === 1;
}
