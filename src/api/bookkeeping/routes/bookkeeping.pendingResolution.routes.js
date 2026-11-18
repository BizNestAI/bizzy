import { Router } from "express";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { requireStatementPendingAdministrator } from "../../_shared/statementPendingAdmin.js";
import { hasAdminBookkeepingWriteCapability } from "../../../services/adminBookkeepingAccess.js";
import { supabase } from "../../../services/supabaseAdmin.js";
import { getPendingResolutionContext, confirmPendingSettled } from "../../../services/bookkeeping/pendingTransactionResolutionService.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Run after authentication, before customer membership/billing middleware so
// authenticated customer calls fail 403 even without a tenant or subscription.
// adminViewRequested is only a routing hint; the normal opaque-session resolver
// and pendingBooksAdminScope still perform all authorization afterward.
export function rejectCustomerPendingResolutionRequest(req, res, next) {
  if (!req.auth?.adminViewRequested) return res.status(403).json({ ok: false, error: "internal_admin_required" });
  return next();
}

export async function pendingBooksAdminScope(req, db = supabase) {
  // tenantContext is attached only by the server's verified opaque-session
  // resolver. No customer membership, banner or body actor grants this scope.
  const context = req.tenantContext;
  if (context?.mode !== "admin_view" || !hasAdminBookkeepingWriteCapability(context)
    || !context.adminViewSessionId || !context.staffUserId
    || context.staffUserId !== req.auth?.userId) {
    throw Object.assign(new Error("Open Bookkeeping Access is required."), { status: 403, code: "internal_admin_required" });
  }
  const actor = await requireStatementPendingAdministrator(req, db);
  if (!UUID.test(context.businessId) || !UUID.test(req.params.transactionId)) {
    throw Object.assign(new Error("Invalid transaction scope."), { status: 400, code: "invalid_pending_scope" });
  }
  return { businessId: context.businessId, transactionId: req.params.transactionId, actor };
}

export function createPendingResolutionRouter({ db = supabase, loadContext = getPendingResolutionContext, confirm = confirmPendingSettled } = {}) {
  const router = Router();
  const handle = mutation => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const scope = await pendingBooksAdminScope(req, db);
      if (!mutation) return res.json({ ok: true, ...await loadContext({ ...scope, db }) });
      const key = String(req.body?.idempotency_key || "").trim();
      if (key.length < 8 || key.length > 160) return res.status(400).json({ ok: false, error: "missing_idempotency_key" });
      // A Books page may show all months. Bind a fresh operation to the source
      // date on the server; a completed replay must still reach the RPC first.
      const [bankResult, replay] = await Promise.all([
        db.from("bank_transactions").select("date").eq("business_id", scope.businessId).eq("id", scope.transactionId).maybeSingle(),
        db.from("pending_transaction_resolution_events").select("evidence").eq("business_id", scope.businessId).eq("idempotency_key", key).maybeSingle(),
      ]);
      if (bankResult.error) throw bankResult.error;
      if (replay.error) throw replay.error;
      const reviewMonth = replay.data?.evidence?.request?.review_month;
      const result = await confirm({ ...scope, db, idempotencyKey: key,
        month: reviewMonth || (bankResult.data?.date ? `${String(bankResult.data.date).slice(0, 7)}-01` : null),
        attested: req.body?.attested === true, statementDate: req.body?.statement_date,
        statementAmount: req.body?.statement_amount, reason: req.body?.note });
      return res.json({ ok: true, action: "confirm-settled", result });
    } catch (error) {
      return res.status(error.status || 409).json({ ok: false, error: error.code || "pending_resolution_failed", message: error.message || "Could not resolve this pending transaction." });
    }
  };
  router.get("/transactions/:transactionId/pending-resolution", requireAuth, handle(false));
  router.post("/transactions/:transactionId/pending-resolution/confirm-settled", requireAuth, handle(true));
  return router;
}
export default createPendingResolutionRouter();
