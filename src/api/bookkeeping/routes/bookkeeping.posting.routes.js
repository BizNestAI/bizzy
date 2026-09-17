/* global process */
import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { postSingleBookkeepingTransactionNow, runBooksPostOnce } from "../../../jobs/booksPost.cron.js";
import {
  getAutoPostSettings,
  getCanonicalPostingBacklogSummary,
  getMerchantBacklogGroups,
  persistMerchantBacklogGroupApprovalOperation,
  postReadyBacklogTransactions,
  previewAutoPostBacklog,
  releaseAutoPostBacklogScope,
  requestMerchantGroupPostingRetryNow,
  setAutoPostEnabled,
} from "../../../services/bookkeeping/autoPostControl.js";
import { assertTaxBusinessAccess } from "../../tax/taxRouteUtils.js";
import { getQBOClient } from "../../../utils/qboClient.js";
import { getLatestQuickBooksTokenRow } from "../../../services/quickbooksTokenService.js";
import { emitTaxDataChanged, TAX_CHANGE_TYPES } from "../../../services/tax/taxChangeEvents.js";
import { runLiveDuplicatePreflight } from "../../../services/bookkeeping/qboDuplicatePreflightService.js";
import { MONTHLY_REVIEW_STAFF_ROLES, requireInternalRole } from "../../_shared/internalStaffAuth.js";

const router = Router();
const POSTING_GRACE_HOURS = Number(process.env.BOOKS_POST_GRACE_HOURS || 24);

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function routeTiming(startMs) {
  return Math.max(0, nowMs() - startMs);
}

function setNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  res.set("Vary", "Authorization, x-business-id, x-bizzi-admin-view");
}

function normalizeQboTxnType(value = "") {
  const normalized = String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
  if (normalized === "purchase") return "Purchase";
  if (normalized === "deposit") return "Deposit";
  if (normalized === "creditcardcharge" || normalized === "creditcardexpense") return "CreditCardCharge";
  if (normalized === "creditcardpayment") return "CreditCardPayment";
  return value ? String(value) : "";
}

function nestedQboMethod(qbo, txnType, method) {
  const keys = {
    Purchase: ["purchase"],
    Deposit: ["deposit"],
    CreditCardCharge: ["creditcardcharge", "creditCardCharge"],
    CreditCardPayment: ["creditcardpayment", "creditCardPayment"],
  }[txnType] || [];
  for (const key of keys) {
    if (typeof qbo?.[key]?.[method] === "function") return qbo[key][method].bind(qbo[key]);
  }
  return null;
}

function unwrapQboTransactionResponse(resp, txnType) {
  if (!resp || typeof resp !== "object") return resp;
  return resp[txnType] || resp[txnType.charAt(0).toLowerCase() + txnType.slice(1)] || resp;
}

async function fetchExistingQboTransaction(qbo, txnType, txnId) {
  const normalizedType = normalizeQboTxnType(txnType);
  const directMethod = `get${normalizedType}`;
  const candidates = [
    typeof qbo?.[directMethod] === "function" ? qbo[directMethod].bind(qbo) : null,
    nestedQboMethod(qbo, normalizedType, "get"),
    nestedQboMethod(qbo, normalizedType, "findById"),
  ].filter(Boolean);
  if (!candidates.length) throw new Error(`qbo_get_not_supported_${normalizedType}`);
  let lastError = null;
  for (const fn of candidates) {
    try {
      return await new Promise((resolve, reject) => {
        fn(txnId, (err, resp) => {
          if (err) return reject(err);
          resolve(unwrapQboTransactionResponse(resp, normalizedType));
        });
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`qbo_transaction_not_found_${normalizedType}`);
}

router.get("/posting/auto-post", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  setNoStoreHeaders(res);

  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const settings = await getAutoPostSettings({
      db: supabase,
      businessId,
      graceHours: POSTING_GRACE_HOURS,
      includeBacklogSummary: false,
      includeBacklogPreview: false,
    });
    return res.json({ ok: true, ...settings });
  } catch (err) {
    console.error("[bookkeeping][auto-post-status] failed", err?.message || err);
    return res.status(err?.status || 500).json({ ok: false, error: err?.code || "auto_post_status_failed", message: err?.message || "failed" });
  }
});

router.patch("/posting/auto-post", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const enabled = req.body?.enabled === true || req.body?.auto_post_to_quickbooks === true;
    const confirmBacklog = req.body?.confirm_backlog === true;
    const settings = await setAutoPostEnabled({
      db: supabase,
      businessId,
      enabled,
      confirmBacklog,
      scopeMode: req.body?.scope_mode || req.body?.auto_post_scope_mode || null,
      effectiveDate: req.body?.effective_date || req.body?.auto_post_effective_date || null,
      previewAcknowledged: req.body?.preview_acknowledged === true,
      previewFingerprint: req.body?.preview_fingerprint || null,
      requestedBy: req.user?.id || req.user?.sub || null,
      graceHours: POSTING_GRACE_HOURS,
    });
    return res.json(settings);
  } catch (err) {
    if (err?.status === 409 && err?.requires_confirmation === true) {
      return res.status(409).json({
        ok: false,
        error: err.code || "auto_post_confirmation_required",
        requires_confirmation: true,
        handled_backlog_count: Number(err.handled_backlog_count || 0),
        message: err.message || "Turn on automatic QuickBooks posting?",
      });
    }
    console.error("[bookkeeping][auto-post-toggle] failed", err?.message || err);
    return res.status(err?.status || 500).json({ ok: false, error: err?.code || "auto_post_toggle_failed", message: err?.message || "failed" });
  }
});

router.get("/posting/backlog/preview", requireAuth, requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES), async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  setNoStoreHeaders(res);

  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const preview = await previewAutoPostBacklog({
      db: supabase,
      businessId,
      rangeStart: req.query?.range_start || null,
      rangeEnd: req.query?.range_end || null,
      effectiveDate: req.query?.effective_date || req.query?.range_start || null,
      transactionIds: Array.isArray(req.query?.transaction_id)
        ? req.query.transaction_id
        : req.query?.transaction_id
          ? [req.query.transaction_id]
          : [],
    });
    return res.json(preview);
  } catch (err) {
    console.error("[bookkeeping][backlog-preview] failed", err?.message || err);
    return res.status(err?.status || 500).json({
      ok: false,
      error: err?.code || "auto_post_backlog_preview_failed",
      message: err?.message || "failed",
    });
  }
});

router.get("/posting/backlog/summary", requireAuth, requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES), async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  setNoStoreHeaders(res);

  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const summary = await getCanonicalPostingBacklogSummary({
      db: supabase,
      businessId,
      rangeStart: req.query?.range_start || null,
      rangeEnd: req.query?.range_end || null,
      effectiveDate: req.query?.effective_date || req.query?.range_start || null,
    });
    return res.json(summary);
  } catch (err) {
    console.error("[bookkeeping][backlog-summary] failed", err?.message || err);
    return res.status(err?.status || 500).json({
      ok: false,
      error: err?.code || "posting_backlog_summary_failed",
      message: err?.message || "failed",
    });
  }
});

router.get("/posting/backlog/merchant-groups", requireAuth, requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES), async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  setNoStoreHeaders(res);

  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const groups = await getMerchantBacklogGroups({
      db: supabase,
      businessId,
      rangeStart: req.query?.range_start || null,
      rangeEnd: req.query?.range_end || null,
      effectiveDate: req.query?.effective_date || req.query?.range_start || null,
      limit: req.query?.limit || 50,
    });
    return res.json(groups);
  } catch (err) {
    console.error("[bookkeeping][merchant-groups] failed", err?.message || err);
    return res.status(err?.status || 500).json({
      ok: false,
      error: err?.code || "merchant_groups_failed",
      message: err?.message || "failed",
    });
  }
});

router.post("/posting/backlog/merchant-groups/approve", requireAuth, requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES), async (req, res) => {
  const routeStartMs = nowMs();
  const stageTimings = {};
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    let stageStartMs = nowMs();
    await assertTaxBusinessAccess({ req, businessId, supabase });
    stageTimings.auth_ms = routeTiming(stageStartMs);
    const common = {
      db: supabase,
      businessId,
      actorId: req.user?.id || req.user?.sub || null,
      selectedQboAccountId: req.body?.selected_qbo_account_id || req.body?.qbo_account_id || null,
      rememberForFuture: req.body?.remember_for_future !== false,
      groupSnapshotToken: req.body?.group_snapshot_token || req.body?.snapshot_token || null,
      transactionIds: Array.isArray(req.body?.transaction_ids) ? req.body.transaction_ids : [],
      exclusionIds: Array.isArray(req.body?.exclusion_ids) ? req.body.exclusion_ids : [],
      expectedRowVersions: req.body?.expected_row_versions || {},
      idempotencyKey: req.get("Idempotency-Key") || req.body?.idempotency_key || null,
    };
    stageStartMs = nowMs();
    const decision = await persistMerchantBacklogGroupApprovalOperation(common);
    stageTimings.accept_operation_ms = routeTiming(stageStartMs);
    return res.status(202).json({
      ...decision,
      stage_timings_ms: stageTimings,
      response_ms: routeTiming(routeStartMs),
      status_url: `/api/bookkeeping/posting/backlog/merchant-groups/operations/${encodeURIComponent(decision.operation_id)}?business_id=${encodeURIComponent(businessId)}`,
    });
  } catch (err) {
    console.error("[bookkeeping][merchant-group-approve] failed", {
      business_id: businessId,
      error: err?.code || err?.message || String(err),
      response_ms: routeTiming(routeStartMs),
      stage_timings_ms: stageTimings,
    });
    return res.status(err?.status || 500).json({
      ok: false,
      error: err?.code || "merchant_group_approval_failed",
      message: "Could not save this posting decision.",
      response_ms: routeTiming(routeStartMs),
    });
  }
});

router.get("/posting/backlog/merchant-groups/operations/:operationId", requireAuth, requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES), async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  setNoStoreHeaders(res);

  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const operationId = String(req.params?.operationId || "").trim();
    if (!operationId) return res.status(400).json({ ok: false, error: "missing_operation_id", message: "Missing operation id." });
    const { data, error } = await supabase
      .from("transaction_categorizations")
      .select("transaction_id,status,post_after,qbo_txn_id,post_error,meta,updated_at")
      .eq("business_id", businessId)
      .contains("meta", { merchant_group_operation_id: operationId })
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    const activeStates = new Set(["accepted", "decision_processing", "decision_saved", "checking_duplicates", "safety_checking", "posting"]);
    const terminalStates = new Set(["retry_scheduled", "blocked", "failed", "posted"]);
    const rowOperationState = (row) => {
      if (row?.qbo_txn_id) return "posted";
      if (row?.meta?.posting_in_progress === true) return "posting";
      return row?.meta?.merchant_group_operation_state || "unknown";
    };
    const currentTimeMs = Date.now();
    const rowPostAfterMs = (row) => {
      const value = Date.parse(row?.post_after || "");
      return Number.isFinite(value) ? value : null;
    };
    const rowDueForPosting = (row) => {
      const postAfterMs = rowPostAfterMs(row);
      return postAfterMs !== null && postAfterMs <= currentTimeMs;
    };
    const states = rows.reduce((acc, row) => {
      const state = rowOperationState(row);
      acc[state] = (acc[state] || 0) + 1;
      return acc;
    }, {});
    const rowUpdatedAtMs = rows
      .map((row) => Date.parse(row?.updated_at || ""))
      .filter((value) => Number.isFinite(value));
    const lastUpdatedAtMs = rowUpdatedAtMs.length ? Math.max(...rowUpdatedAtMs) : null;
    const rowIsActive = (row) => activeStates.has(rowOperationState(row)) || rowDueForPosting(row);
    const rowLeaseExpired = (row) => {
      const leaseExpiresAtMs = Date.parse(row?.meta?.merchant_group_operation_lease_expires_at || "");
      return Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs <= currentTimeMs;
    };
    const active = rows.some(rowIsActive);
    const stale = rows.length > 0 && rows.every((row) => rowIsActive(row) && rowLeaseExpired(row));
    const terminal = rows.length > 0 && rows.every((row) => {
      const state = rowOperationState(row);
      if (row.qbo_txn_id || terminalStates.has(state)) return true;
      if (state === "scheduled") return !rowDueForPosting(row);
      return false;
    });
    return res.json({
      ok: true,
      operation_id: operationId,
      row_count: rows.length,
      states,
      terminal,
      active,
      stale,
      last_update_at: lastUpdatedAtMs ? new Date(lastUpdatedAtMs).toISOString() : null,
      rows: rows.map((row) => ({
        transaction_id: row.transaction_id,
        state: rowOperationState(row),
        stage: row?.meta?.posting_in_progress === true ? "posting" : row?.meta?.merchant_group_operation_stage || row?.meta?.merchant_group_operation_state || "unknown",
        status: row.status,
        updated_at: row.updated_at || null,
        post_after: row.post_after || null,
        posted: Boolean(row.qbo_txn_id),
        post_error: row.post_error || null,
        failure_code: row?.meta?.merchant_group_operation_failure_code || null,
        failure_message: row?.meta?.merchant_group_operation_failure_message || null,
        requested_at: row?.meta?.merchant_group_requested_at || null,
        claimed_at: row?.meta?.merchant_group_operation_claimed_at || null,
        lease_expires_at: row?.meta?.merchant_group_operation_lease_expires_at || null,
        active: rowIsActive(row),
        stale: rowIsActive(row) && rowLeaseExpired(row),
        next_post_attempt_at: row?.meta?.next_post_attempt_at || null,
        qbo_txn_id: row.qbo_txn_id || null,
      })),
    });
  } catch (err) {
    console.error("[bookkeeping][merchant-group-approve-operation-status] failed", err?.message || err);
    return res.status(err?.status || 500).json({
      ok: false,
      error: err?.code || "merchant_group_operation_status_failed",
      message: "Could not load posting operation status.",
    });
  }
});

router.post("/posting/backlog/merchant-groups/operations/:operationId/retry-now", requireAuth, requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES), async (req, res) => {
  const routeStartMs = nowMs();
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  setNoStoreHeaders(res);

  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const operationId = String(req.params?.operationId || "").trim();
    const transactionIds = Array.isArray(req.body?.transaction_ids) ? req.body.transaction_ids : [];
    if (!operationId) return res.status(400).json({ ok: false, error: "missing_operation_id", message: "Missing operation id." });
    const result = await requestMerchantGroupPostingRetryNow({
      db: supabase,
      businessId,
      operationId,
      transactionIds,
      actorId: req.user?.id || req.user?.sub || null,
    });
    return res.status(202).json({
      ...result,
      response_ms: routeTiming(routeStartMs),
      status_url: `/api/bookkeeping/posting/backlog/merchant-groups/operations/${encodeURIComponent(operationId)}?business_id=${encodeURIComponent(businessId)}`,
    });
  } catch (err) {
    console.error("[bookkeeping][merchant-group-retry-now] failed", {
      business_id: businessId,
      operation_id: req.params?.operationId || null,
      error: err?.code || err?.message || String(err),
      response_ms: routeTiming(routeStartMs),
    });
    return res.status(err?.status || 500).json({
      ok: false,
      error: err?.code || "merchant_group_retry_failed",
      message: "Could not request this posting retry.",
      response_ms: routeTiming(routeStartMs),
    });
  }
});

router.post("/posting/backlog/post-ready", requireAuth, requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES), async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const result = await postReadyBacklogTransactions({
      db: supabase,
      businessId,
      transactionIds: Array.isArray(req.body?.transaction_ids) ? req.body.transaction_ids : [],
      duplicatePreflight: runLiveDuplicatePreflight,
    });
    return res.json(result);
  } catch (err) {
    console.error("[bookkeeping][post-ready-backlog] failed", err?.message || err);
    return res.status(err?.status || 500).json({
      ok: false,
      error: err?.code || "post_ready_backlog_failed",
      message: err?.message || "failed",
    });
  }
});

router.post("/posting/backlog/release", requireAuth, requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES), async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const result = await releaseAutoPostBacklogScope({
      db: supabase,
      businessId,
      requestedBy: req.user?.id || req.user?.sub || null,
      rangeStart: req.body?.range_start || null,
      rangeEnd: req.body?.range_end || null,
      transactionIds: Array.isArray(req.body?.transaction_ids) ? req.body.transaction_ids : [],
      previewFingerprint: req.body?.preview_fingerprint || null,
      metadata: {
        source: "bookkeeping_backlog_release",
        preview_acknowledged: req.body?.preview_acknowledged === true,
      },
    });
    return res.json(result);
  } catch (err) {
    console.error("[bookkeeping][backlog-release] failed", err?.message || err);
    return res.status(err?.status || 500).json({
      ok: false,
      error: err?.code || "auto_post_backlog_release_failed",
      message: err?.message || "failed",
    });
  }
});

router.post("/posting/run", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const force = req.body?.force === true || req.query?.force === "true";
    const summary = await runBooksPostOnce({ businessId, force });
    return res.json({
      ok: summary?.ok !== false,
      error: summary?.ok === false ? summary?.error || "posting_run_failed" : null,
      message: summary?.ok === false ? summary?.error || "Posting run failed." : null,
      summary,
    });
  } catch (err) {
    console.error("[bookkeeping][posting-run] failed", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "posting_run_failed",
      message: err?.message || "failed",
    });
  }
});

router.post("/posting/transactions/:transactionId", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const transactionId = req.params?.transactionId;
  if (!transactionId) return res.status(400).json({ ok: false, error: "missing_transaction_id" });

  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const confirmPostAnyway =
      req.body?.confirm_post_anyway === true ||
      req.body?.post_anyway === true ||
      req.body?.confirmPostAnyway === true;
    const result = await postSingleBookkeepingTransactionNow({ businessId, transactionId, confirmPostAnyway });
    return res.json(result);
  } catch (err) {
    console.error("[bookkeeping][manual-post] failed", {
      businessId,
      transactionId,
      message: err?.message || String(err),
    });
    return res.status(err?.status || 500).json({
      ok: false,
      error: err?.message || "manual_post_failed",
      message: err?.message || "Posting to QuickBooks failed.",
    });
  }
});

router.post("/posting/transactions/:transactionId/link-existing", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const transactionId = req.params?.transactionId;
  const qboTxnId = req.body?.qbo_txn_id || req.body?.qboTxnId || null;
  const qboTxnType = normalizeQboTxnType(req.body?.qbo_txn_type || req.body?.qboTxnType || null);
  if (!transactionId) return res.status(400).json({ ok: false, error: "missing_transaction_id" });
  if (!qboTxnId || !qboTxnType) return res.status(400).json({ ok: false, error: "missing_qbo_transaction" });

  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const nowIso = new Date().toISOString();
    const { data: cat, error: catErr } = await supabase
      .from("transaction_categorizations")
      .select("transaction_id,status,meta")
      .eq("business_id", businessId)
      .eq("transaction_id", transactionId)
      .maybeSingle();
    if (catErr) throw catErr;
    if (!cat?.meta?.possible_qbo_duplicate) {
      return res.status(409).json({ ok: false, error: "qbo_duplicate_review_required" });
    }

    const { data: receipt, error: receiptErr } = await supabase
      .from("qbo_posted_transactions")
      .select("id,request_id,realm_id,qbo_env,status,qbo_txn_id")
      .eq("business_id", businessId)
      .eq("transaction_id", transactionId)
      .maybeSingle();
    if (receiptErr) throw receiptErr;
    if (!receipt?.id) return res.status(409).json({ ok: false, error: "qbo_posting_intent_not_found" });

    const tokenRow = await getLatestQuickBooksTokenRow(businessId);
    if (!tokenRow?.realm_id) return res.status(409).json({ ok: false, error: "quickbooks_not_connected" });
    if (receipt.realm_id && receipt.realm_id !== tokenRow.realm_id) {
      return res.status(409).json({ ok: false, error: "qbo_realm_mismatch" });
    }

    const qbo = await getQBOClient(businessId);
    if (!qbo) return res.status(409).json({ ok: false, error: "qbo_client_unavailable" });
    const existingQboTxn = await fetchExistingQboTransaction(qbo, qboTxnType, qboTxnId);
    const fetchedId = existingQboTxn?.Id || existingQboTxn?.id || null;
    if (String(fetchedId || "") !== String(qboTxnId)) {
      return res.status(404).json({ ok: false, error: "qbo_transaction_not_found" });
    }

    const { data: linkedReceipt, error: linkErr } = await supabase
      .from("qbo_posted_transactions")
      .update({
        status: "posted",
        qbo_txn_id: qboTxnId,
        qbo_txn_type: qboTxnType,
        qbo_sync_token: existingQboTxn?.SyncToken || existingQboTxn?.syncToken || null,
        posted_at: nowIso,
        processing_started_at: null,
        lease_expires_at: null,
        last_error: null,
        error: null,
        response_summary: {
          linked_existing_qbo_transaction: true,
          linked_by_user: true,
        },
        response: existingQboTxn || null,
        updated_at: nowIso,
      })
      .eq("business_id", businessId)
      .eq("transaction_id", transactionId)
      .eq("id", receipt.id)
      .select("id,request_id")
      .maybeSingle();
    if (linkErr) throw linkErr;
    if (!linkedReceipt?.id) return res.status(409).json({ ok: false, error: "qbo_posting_intent_not_found" });

    const { error: updateErr } = await supabase
      .from("transaction_categorizations")
      .update({
        status: "posted",
        qbo_txn_id: qboTxnId,
        qbo_txn_type: qboTxnType,
        posted_at: nowIso,
        reconciled_at: nowIso,
        post_error: null,
        post_after: null,
        last_post_attempt_at: nowIso,
        meta: {
          ...(cat.meta || {}),
          posting_in_progress: false,
          linked_existing_qbo_transaction: true,
          qbo_request_id: linkedReceipt.request_id || null,
        },
      })
      .eq("business_id", businessId)
      .eq("transaction_id", transactionId);
    if (updateErr) throw updateErr;

    const { data: bankTxn } = await supabase
      .from("bank_transactions")
      .select("date,amount")
      .eq("business_id", businessId)
      .eq("id", transactionId)
      .maybeSingle();
    emitTaxDataChanged({
      businessId,
      taxYear: taxYearFromDate(bankTxn?.date || nowIso),
      changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_POSTED,
      entityId: transactionId,
      userId: req.user?.id || null,
      metadata: {
        source: "bookkeeping_link_existing_qbo",
        changedFields: ["status", "qbo_txn_id", "qbo_txn_type", "posted_at"],
        after: {
          status: "posted",
          qboTxnId,
          qboTxnType,
          postedAt: nowIso,
          effectiveDate: bankTxn?.date || null,
        },
        materiality: { amount: Math.abs(Number(bankTxn?.amount || 0)) || null, transactionCount: 1 },
      },
    });

    return res.json({
      ok: true,
      transaction_id: transactionId,
      status: "posted",
      qbo_txn_id: qboTxnId,
      qbo_txn_type: qboTxnType,
      posted_at: nowIso,
      linked_existing_qbo_transaction: true,
    });
  } catch (err) {
    console.error("[bookkeeping][link-existing-qbo] failed", {
      businessId,
      transactionId,
      message: err?.message || String(err),
    });
    return res.status(err?.status || 500).json({
      ok: false,
      error: err?.message || "link_existing_qbo_failed",
      message: err?.message || "Failed to link existing QuickBooks transaction.",
    });
  }
});

function taxYearFromDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.getFullYear() : new Date().getFullYear();
}

export default router;
