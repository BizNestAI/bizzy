import { resolveInternalStaff } from "./internalStaffAuth.js";
import { hasAdminBookkeepingWriteCapability } from "../../services/adminBookkeepingAccess.js";
import { assertTaxBusinessAccess } from "../tax/taxRouteUtils.js";

export async function bookkeepingAccountReadScope(req, db, requestedBusinessId) {
  const context = req.tenantContext;
  if (context?.mode !== "admin_view") {
    if (req.auth?.adminViewRequested) throw Object.assign(new Error("Verified Bookkeeping Access required."), { status: 403, code: "internal_admin_required" });
    await assertTaxBusinessAccess({ req, businessId: requestedBusinessId, supabase: db });
    return { businessId: requestedBusinessId, cacheOnly: false };
  }
  if (!context.businessId || !context.adminViewSessionId || !context.staffUserId
    || context.staffUserId !== req.auth?.userId || !hasAdminBookkeepingWriteCapability(context)
    || !context.expiresAt || !(Date.parse(context.expiresAt) > Date.now())) {
    throw Object.assign(new Error("Verified Bookkeeping Access required."), { status: 403, code: "internal_admin_required" });
  }
  await resolveInternalStaff({ req, supabase: db });
  return { businessId: context.businessId, cacheOnly: true };
}
