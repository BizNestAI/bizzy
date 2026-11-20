import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { bookkeepingAccountReadScope } from "../../_shared/bookkeepingAccountReadScope.js";
import {
  excludeBookkeepingTransaction,
  restoreBookkeepingTransaction,
  TransactionExclusionError,
} from "../../../services/bookkeeping/transactionExclusionService.js";

const router = Router();

function actorId(req) {
  return req.user?.id || req.auth?.userId || req.user?.sub || "authenticated_user";
}

export function createExcludeTransactionHandler({ db = supabase, exclude = excludeBookkeepingTransaction } = {}) {
  return async (req, res) => {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    try {
      const scope = await bookkeepingAccountReadScope(req, db, businessId);
      if (req.body?.expected_feed != null && req.body.expected_feed !== "handled") {
        return res.status(400).json({ ok: false, error: { code: "INVALID_EXCLUSION_FEED", message: "Invalid exclusion feed." } });
      }
      if (req.tenantContext?.mode === "admin_view" && [req.body?.business_id, req.headers?.["x-business-id"]]
        .some(id => id && String(id) !== String(scope.businessId))) {
        return res.status(403).json({ ok: false, error: { code: "ADMIN_VIEW_BUSINESS_MISMATCH", message: "Bookkeeping Access business cannot be changed." } });
      }
      if (req.tenantContext?.mode !== "admin_view" && req.tenantContext?.readOnly === true) {
        return res.status(403).json({ ok: false, error: { code: "BOOKKEEPING_WRITE_REQUIRED", message: "Bookkeeping write access is required." } });
      }
      const result = await exclude({
        db,
        businessId: scope.businessId,
        transactionId: req.params.transactionId,
        accountId: req.body?.account_id || null,
        actorId: req.tenantContext?.mode === "admin_view" ? req.tenantContext.staffUserId : actorId(req),
        source: req.tenantContext?.mode === "admin_view" ? "admin_bookkeeping_access" : "books_review",
        expectedFeed: req.body?.expected_feed || null,
        reason: req.body?.reason || null,
      });
      return res.json(result);
    } catch (err) {
      if (err instanceof TransactionExclusionError) return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message, correlationId: err.details?.correlationId || null } });
      if (err.status === 403 || err.status === 401) return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message } });
      return res.status(500).json({ ok: false, error: { code: "TRANSACTION_EXCLUSION_FAILED", message: "Transaction could not be excluded.", correlationId: null } });
    }
  };
}
router.post("/transactions/:transactionId/exclude", requireAuth, createExcludeTransactionHandler());

export function createRestoreTransactionHandler({ db = supabase, restore = restoreBookkeepingTransaction } = {}) {
  return async (req, res) => {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    try {
      const scope = await bookkeepingAccountReadScope(req, db, businessId);
      if (req.tenantContext?.mode === "admin_view" && [req.body?.business_id, req.headers?.["x-business-id"]]
        .some(id => id && String(id) !== String(scope.businessId))) {
        return res.status(403).json({ ok: false, error: { code: "ADMIN_VIEW_BUSINESS_MISMATCH" } });
      }
      if (req.tenantContext?.mode !== "admin_view" && req.tenantContext?.readOnly === true) {
        return res.status(403).json({ ok: false, error: { code: "BOOKKEEPING_WRITE_REQUIRED" } });
      }
      const result = await restore({
        db,
        businessId: scope.businessId,
        transactionId: req.params.transactionId,
        actorId: req.tenantContext?.mode === "admin_view" ? req.tenantContext.staffUserId : actorId(req),
        source: req.tenantContext?.mode === "admin_view" ? "admin_bookkeeping_access" : "books_review",
      });
      return res.json(result);
    } catch (err) {
      if (err instanceof TransactionExclusionError) return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message, correlationId: err.details?.correlationId || null } });
      if (err.status === 403 || err.status === 401) return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message } });
      return res.status(500).json({ ok: false, error: { code: "TRANSACTION_RESTORE_FAILED", message: "Transaction could not be restored.", correlationId: null } });
    }
  };
}
router.post("/transactions/:transactionId/restore", requireAuth, createRestoreTransactionHandler());

export default router;
