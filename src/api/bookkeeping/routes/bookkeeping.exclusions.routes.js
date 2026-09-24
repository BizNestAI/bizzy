import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import {
  excludeBookkeepingTransaction,
  restoreBookkeepingTransaction,
  TransactionExclusionError,
} from "../../../services/bookkeeping/transactionExclusionService.js";

const router = Router();

function actorId(req) {
  return req.user?.id || req.auth?.userId || req.user?.sub || "authenticated_user";
}

router.post("/transactions/:transactionId/exclude", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await excludeBookkeepingTransaction({
      db: supabase,
      businessId,
      transactionId: req.params.transactionId,
      actorId: actorId(req),
      reason: req.body?.reason || null,
    });
    return res.json(result);
  } catch (err) {
    if (err instanceof TransactionExclusionError) return res.status(err.status).json({ ok: false, error: err.code, ...err.details });
    return res.status(500).json({ ok: false, error: "transaction_exclusion_failed" });
  }
});

router.post("/transactions/:transactionId/restore", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await restoreBookkeepingTransaction({
      db: supabase,
      businessId,
      transactionId: req.params.transactionId,
      actorId: actorId(req),
    });
    return res.json(result);
  } catch (err) {
    if (err instanceof TransactionExclusionError) return res.status(err.status).json({ ok: false, error: err.code, ...err.details });
    return res.status(500).json({ ok: false, error: "transaction_restore_failed" });
  }
});

export default router;
