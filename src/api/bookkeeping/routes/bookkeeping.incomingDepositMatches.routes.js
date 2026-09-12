/* global process */
import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { assertTaxBusinessAccess } from "../../tax/taxRouteUtils.js";
import { createRateLimiter } from "../../_shared/rateLimit.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import {
  confirmIncomingDepositQboMatch,
  discoverIncomingDepositQboMatch,
  IncomingDepositMatchError,
  rejectIncomingDepositQboMatch,
  undoIncomingDepositQboMatch,
} from "../../../services/bookkeeping/incomingDepositMatchService.js";

const router = Router();
const incomingDepositMatchWriteRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.BOOKKEEPING_INCOMING_DEPOSIT_MATCH_RATE_LIMIT_PER_MINUTE || 30),
  code: "incoming_deposit_match_rate_limited",
  message: "Too many matching requests. Try again shortly.",
});

function actorId(req) {
  return req.user?.id || req.user?.sub || null;
}

function sendError(res, err, fallback = "incoming_deposit_match_failed") {
  if (err instanceof IncomingDepositMatchError) {
    return res.status(err.status || 400).json({ ok: false, error: err.code, details: err.details || {} });
  }
  console.error("[bookkeeping][incoming-deposit-match] failed", err?.message || err);
  return res.status(err?.status || 500).json({ ok: false, error: err?.code || fallback, message: err?.message || "failed" });
}

router.get("/incoming-deposit-matches/:transactionId", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const result = await discoverIncomingDepositQboMatch({
      db: supabase,
      businessId,
      bankTransactionId: req.params.transactionId,
      actor: actorId(req),
      actorRole: "user",
      persist: req.query?.persist !== "false",
    });
    return res.json({ ok: true, result });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post("/incoming-deposit-matches/:transactionId/:matchId/confirm", requireAuth, incomingDepositMatchWriteRateLimit, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const result = await confirmIncomingDepositQboMatch({
      db: supabase,
      businessId,
      bankTransactionId: req.params.transactionId,
      matchId: req.params.matchId,
      actor: actorId(req),
      actorRole: "user",
      idempotencyKey: req.body?.idempotency_key || req.get("Idempotency-Key") || null,
      expectedBankUpdatedAt: req.body?.expected_bank_updated_at || req.body?.expectedBankUpdatedAt || null,
    });
    return res.json(result);
  } catch (err) {
    return sendError(res, err, "incoming_deposit_match_confirm_failed");
  }
});

router.post("/incoming-deposit-matches/:transactionId/:matchId/reject", requireAuth, incomingDepositMatchWriteRateLimit, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const result = await rejectIncomingDepositQboMatch({
      db: supabase,
      businessId,
      bankTransactionId: req.params.transactionId,
      matchId: req.params.matchId,
      actor: actorId(req),
      actorRole: "user",
      reason: req.body?.reason || "human_rejected",
    });
    return res.json({ ok: true, result });
  } catch (err) {
    return sendError(res, err, "incoming_deposit_match_reject_failed");
  }
});

router.post("/incoming-deposit-matches/:transactionId/:matchId/undo", requireAuth, incomingDepositMatchWriteRateLimit, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const result = await undoIncomingDepositQboMatch({
      db: supabase,
      businessId,
      bankTransactionId: req.params.transactionId,
      matchId: req.params.matchId,
      actor: actorId(req),
      actorRole: "user",
      reason: req.body?.reason || "human_undo",
    });
    return res.json(result);
  } catch (err) {
    return sendError(res, err, "incoming_deposit_match_undo_failed");
  }
});

export default router;
