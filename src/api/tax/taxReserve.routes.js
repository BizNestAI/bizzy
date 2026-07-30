// /src/api/tax/taxReserve.routes.js
import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import { runCanonicalTaxCalculation } from "../../services/tax/orchestrator/taxOrchestrator.js";
import { getLatestTaxRun } from "../../services/tax/runs/taxRun.repository.js";
import {
  createReserveAccount,
  deactivateReserveAccount,
  listReserveAccounts,
  refreshReserveAccountBalance,
  setPrimaryReserveAccount,
  updateReserveAccount,
} from "../../services/tax/reserve/taxReserveAccount.service.js";
import { TAX_TRIGGER_SOURCES } from "../../services/tax/taxDomain.js";
import { emitTaxDataChanged, TAX_CHANGE_TYPES } from "../../services/tax/taxChangeEvents.js";
import { notFoundError, validationError } from "../../services/tax/taxErrors.js";
import { assertTaxBusinessAccess, getAuthenticatedUserId } from "./taxRouteUtils.js";
import { optionalDate, optionalTaxYear, requireUuid, validateBusinessIdInput, validatePagination } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.get("/reserve", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query?.year ?? req.query?.taxYear, new Date().getFullYear());
    optionalDate(req.query?.asOfDate, "asOfDate");
    const latest = await getLatestTaxRun({ supabase, businessId, taxYear });
    if (!latest) throw notFoundError("tax_reserve_not_available", "No persisted tax calculation is available for this tax year.", { businessId, taxYear });
    return sendTaxSuccess(res, reserveFromRun(latest), { runId: latest.id || null, source: "canonical_tax_run" });
  } catch (err) {
    return sendTaxError(res, err, "tax_reserve_failed");
  }
});

router.post("/reserve/calculate", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const body = req.body || {};
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(body.year ?? body.taxYear, new Date().getFullYear());
    const canonical = await runCanonicalTaxCalculation({
      supabase,
      businessId,
      taxYear,
      asOfDate: optionalDate(body.asOfDate, "asOfDate"),
      triggerSource: body.triggerSource || TAX_TRIGGER_SOURCES.MANUAL,
      userId: getAuthenticatedUserId(req),
      persistRun: body.persistRun !== false,
      force: body.force === true,
    });
    return sendTaxSuccess(res, canonical.reserve, { runId: canonical.meta?.runId || null, source: "canonical_tax_calculation" });
  } catch (err) {
    return sendTaxError(res, err, "tax_reserve_calculation_failed");
  }
});

router.get("/reserve/accounts", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const rows = await listReserveAccounts({ supabase, businessId, includeInactive: String(req.query?.includeInactive || "").toLowerCase() === "true" });
    return sendTaxSuccess(res, { rows });
  } catch (err) {
    return sendTaxError(res, err, "tax_reserve_accounts_failed");
  }
});

router.post("/reserve/accounts", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const account = await createReserveAccount({ supabase, businessId, input: req.body || {} });
    emitTaxDataChanged({ businessId, changeType: TAX_CHANGE_TYPES.RESERVE_ACCOUNT_CREATED, entityId: account.id, userId: getAuthenticatedUserId(req), metadata: reserveAccountEventMetadata(null, account) });
    return sendTaxSuccess(res, account);
  } catch (err) {
    return sendTaxError(res, err, "tax_reserve_account_create_failed");
  }
});

router.patch("/reserve/accounts/:id", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const accountId = requireUuid(req.params.id, "id");
    const account = await updateReserveAccount({ supabase, businessId, accountId, input: req.body || {} });
    emitTaxDataChanged({ businessId, changeType: TAX_CHANGE_TYPES.RESERVE_ACCOUNT_UPDATED, entityId: account.id, userId: getAuthenticatedUserId(req), metadata: reserveAccountEventMetadata(null, account) });
    return sendTaxSuccess(res, account);
  } catch (err) {
    return sendTaxError(res, err, "tax_reserve_account_update_failed");
  }
});

router.post("/reserve/accounts/:id/set-primary", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const accountId = requireUuid(req.params.id, "id");
    const account = await setPrimaryReserveAccount({ supabase, businessId, accountId });
    emitTaxDataChanged({ businessId, changeType: TAX_CHANGE_TYPES.RESERVE_ACCOUNT_PRIMARY_CHANGED, entityId: account.id, userId: getAuthenticatedUserId(req), metadata: reserveAccountEventMetadata(null, account) });
    return sendTaxSuccess(res, account);
  } catch (err) {
    return sendTaxError(res, err, "tax_reserve_account_primary_failed");
  }
});

router.post("/reserve/accounts/:id/refresh", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const accountId = requireUuid(req.params.id, "id");
    const account = (await listReserveAccounts({ supabase, businessId, includeInactive: true })).find((row) => row.id === accountId);
    if (!account) throw notFoundError("tax_reserve_account_not_found", "Tax reserve account was not found.", { accountId });
    const balance = await refreshReserveAccountBalance({ supabase, businessId, account });
    emitTaxDataChanged({ businessId, changeType: TAX_CHANGE_TYPES.RESERVE_BALANCE_REFRESHED, entityId: account.id, userId: getAuthenticatedUserId(req), metadata: reserveAccountEventMetadata(account, { ...account, manualBalance: balance.currentReserve, currentBalance: balance.currentReserve }) });
    return sendTaxSuccess(res, { account, balance });
  } catch (err) {
    return sendTaxError(res, err, "tax_reserve_account_refresh_failed");
  }
});

router.post("/reserve/accounts/:id/deactivate", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const accountId = requireUuid(req.params.id, "id");
    const account = await deactivateReserveAccount({ supabase, businessId, accountId });
    emitTaxDataChanged({ businessId, changeType: TAX_CHANGE_TYPES.RESERVE_ACCOUNT_UPDATED, entityId: account.id, userId: getAuthenticatedUserId(req), metadata: reserveAccountEventMetadata(null, account) });
    return sendTaxSuccess(res, account);
  } catch (err) {
    return sendTaxError(res, err, "tax_reserve_account_deactivate_failed");
  }
});

router.get("/reserve/history", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = req.query?.year || req.query?.taxYear ? optionalTaxYear(req.query?.year ?? req.query?.taxYear, new Date().getFullYear()) : null;
    const pagination = validatePagination({ limit: req.query?.limit || 50, offset: req.query?.offset || 0 });
    let query = supabase
      .from("tax_reserve_snapshots")
      .select("*")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(pagination.limit || 50)
      .range(pagination.offset || 0, (pagination.offset || 0) + (pagination.limit || 50) - 1);
    if (taxYear) query = query.eq("tax_year", taxYear);
    const { data, error } = await query;
    if (error) throw validationError("tax_reserve_history_unavailable", "Tax reserve history is unavailable.", { businessId });
    return sendTaxSuccess(res, { rows: data || [], pagination: { limit: pagination.limit || 50, offset: pagination.offset || 0, count: (data || []).length } });
  } catch (err) {
    return sendTaxError(res, err, "tax_reserve_history_failed");
  }
});

export default router;

function reserveFromRun(run = {}) {
  const currentReserve = run.current_reserve == null ? null : money(run.current_reserve);
  const recommendedReserve = run.recommended_reserve == null ? null : money(run.recommended_reserve);
  const reserveGap = run.reserve_gap == null ? null : money(run.reserve_gap);
  return {
    status: reserveGap == null ? "setup_incomplete" : reserveGap <= 0 ? "on_track" : "reserve_gap",
    reserve: {
      currentReserve,
      recommendedReserve,
      reserveGap,
      surplusAmount: reserveGap == null ? null : Math.max(0, -reserveGap),
      lastVerifiedAt: run.completed_at || run.updated_at || null,
    },
    liability: {
      remainingProjectedLiability: run.remaining_projected_liability == null ? null : money(run.remaining_projected_liability),
      nextPaymentAmount: null,
      nextPaymentDate: null,
    },
    confidence: {
      score: run.confidence_score ?? null,
      level: run.confidence_level || "unavailable",
      reserveReady: run.reserve_ready === true,
    },
    warnings: run.reserve_gap == null ? [{ code: "reserve_setup_incomplete", message: "Connect or select a reserve account to track what is set aside." }] : [],
  };
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function reserveAccountEventMetadata(before, after) {
  return {
    changedFields: ["is_primary", "manual_balance", "current_balance"],
    before: pickReserveEventFields(before),
    after: pickReserveEventFields(after),
    materiality: { amount: Math.abs(Number(after?.manualBalance ?? after?.currentBalance ?? before?.manualBalance ?? before?.currentBalance ?? 0)) || null },
  };
}

function pickReserveEventFields(row = {}) {
  if (!row) return {};
  return {
    is_primary: row.isPrimary,
    manual_balance: row.manualBalance,
    current_balance: row.currentBalance,
  };
}
