/* global process */
import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { assertTaxBusinessAccess } from "../../tax/taxRouteUtils.js";
import { createRateLimiter } from "../../_shared/rateLimit.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import {
  confirmIncomingDepositQboMatch,
  discoverExistingIncomingDepositMatches,
  discoverIncomingDepositQboMatch,
  IncomingDepositMatchError,
  rejectIncomingDepositQboMatch,
  undoIncomingDepositQboMatch,
} from "../../../services/bookkeeping/incomingDepositMatchService.js";
import { ProcessorFeeRefreshError, refreshProcessorFeeQboEvidence } from "../../../services/bookkeeping/processorFeeQboRefreshService.js";

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

function requestCorrelationId(req) {
  return req.get("X-Request-ID") || req.get("X-Correlation-ID") || `incoming-deposit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sendError(req, res, err, fallback = "incoming_deposit_match_failed") {
  const correlationId = req.matchCorrelationId || requestCorrelationId(req);
  if (err instanceof IncomingDepositMatchError) {
    const refreshed = err.code === "qbo_match_details_changed" ? err.details?.refreshed_candidate : null;
    return res.status(err.status || 400).json({
      ok: false,
      error: err.code,
      correlation_id: correlationId,
      ...(refreshed ? { details: { refreshed_candidate: {
        qbo_entity_type: refreshed.qbo_entity_type,
        qbo_entity_id: refreshed.qbo_entity_id,
        txn_date: refreshed.txn_date,
        amount_minor: refreshed.amount_minor,
        currency: refreshed.currency,
        status: refreshed.status,
      } } } : {}),
    });
  }
  console.error("[bookkeeping][incoming-deposit-match] failed", {
    correlation_id: correlationId,
    code: err?.code || null,
    message: err?.message || null,
    details: err?.details || null,
    hint: err?.hint || null,
  });
  return res.status(err?.status || 500).json({ ok: false, error: fallback, correlation_id: correlationId });
}

router.get("/incoming-deposit-matches/:transactionId", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  req.matchCorrelationId = requestCorrelationId(req);
  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const result = await discoverIncomingDepositQboMatch({
      db: supabase,
      businessId,
      bankTransactionId: req.params.transactionId,
      actor: actorId(req),
      actorRole: "user",
      persist: req.query?.persist !== "false",
      correlationId: req.matchCorrelationId,
    });
    return res.json({ ok: true, result });
  } catch (err) {
    return sendError(req, res, err);
  }
});

router.post("/incoming-deposit-matches/:transactionId/refresh", requireAuth, incomingDepositMatchWriteRateLimit, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  req.matchCorrelationId = requestCorrelationId(req);
  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const refresh = await refreshProcessorFeeQboEvidence({ businessId, bankTransactionId: req.params.transactionId, db: supabase });
    const result = await discoverIncomingDepositQboMatch({
      db: supabase, businessId, bankTransactionId: req.params.transactionId,
      actor: actorId(req), actorRole: "user_targeted_refresh", persist: true, correlationId: req.matchCorrelationId,
    });
    const status = result.status === "needs_confirmation" ? "match_found"
      : result.status === "ambiguous" ? "multiple_matches"
        : result.status === "candidate" ? "authoritative_no_match" : "cache_incomplete";
    return res.json({ ok: true, status, refresh, result });
  } catch (err) {
    if (err instanceof ProcessorFeeRefreshError) {
      return res.status(200).json({ ok: false, status: "refresh_failed", error: err.code, diagnostics: err.details || {}, correlation_id: req.matchCorrelationId });
    }
    return sendError(req, res, err, "qbo_processor_fee_refresh_failed");
  }
});

router.post("/incoming-deposit-matches/discovery", requireAuth, incomingDepositMatchWriteRateLimit, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  req.matchCorrelationId = requestCorrelationId(req);
  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const result = await discoverExistingIncomingDepositMatches({
      db: supabase,
      businessId,
      transactionId: req.body?.transaction_id || req.body?.transactionId || null,
      dryRun: req.body?.dry_run !== false && req.body?.dryRun !== false,
      limit: req.body?.limit || 25,
      actor: actorId(req),
      actorRole: req.body?.dry_run === false || req.body?.dryRun === false ? "candidate_backfill_execute" : "candidate_backfill_dry_run",
    });
    return res.json(result);
  } catch (err) {
    return sendError(req, res, err, "incoming_deposit_match_discovery_failed");
  }
});

router.post("/incoming-deposit-matches/:transactionId/:matchId/confirm", requireAuth, incomingDepositMatchWriteRateLimit, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  req.matchCorrelationId = requestCorrelationId(req);
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
      selectedQboEntityId: req.body?.qbo_entity_id || req.body?.qboEntityId || null,
      selectedQboEntityType: req.body?.qbo_entity_type || req.body?.qboEntityType || null,
    });
    return res.json(result);
  } catch (err) {
    return sendError(req, res, err, "incoming_deposit_match_confirm_failed");
  }
});

router.post("/incoming-deposit-matches/:transactionId/:matchId/reject", requireAuth, incomingDepositMatchWriteRateLimit, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  req.matchCorrelationId = requestCorrelationId(req);
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
    return sendError(req, res, err, "incoming_deposit_match_reject_failed");
  }
});

router.post("/incoming-deposit-matches/:transactionId/:matchId/undo", requireAuth, incomingDepositMatchWriteRateLimit, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  req.matchCorrelationId = requestCorrelationId(req);
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
      idempotencyKey: req.body?.idempotency_key || req.get("Idempotency-Key") || null,
      expectedBankUpdatedAt: req.body?.expected_bank_updated_at || req.body?.expectedBankUpdatedAt || null,
    });
    return res.json(result);
  } catch (err) {
    return sendError(req, res, err, "incoming_deposit_match_undo_failed");
  }
});

export default router;
