import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { postSingleBookkeepingTransactionNow, runBooksPostOnce } from "../../../jobs/booksPost.cron.js";
import { applyActiveBookkeepingScope, getBookkeepingStartDate } from "../../../services/bookkeeping/bookkeepingScope.js";
import { computePostAfterForAutoPost, getAutoPostToQuickBooks } from "../../../services/bookkeeping/autoPostControl.js";
import { assertTaxBusinessAccess } from "../../tax/taxRouteUtils.js";
import { getQBOClient } from "../../../utils/qboClient.js";
import { getLatestQuickBooksTokenRow } from "../../../services/quickbooksTokenService.js";

const router = Router();
const POSTING_GRACE_HOURS = Number(process.env.BOOKS_POST_GRACE_HOURS || 24);

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

async function getHandledBacklogTransactionIds(businessId) {
  const { data: catRows, error: catErr } = await supabase
    .from("transaction_categorizations")
    .select("transaction_id")
    .eq("business_id", businessId)
    .in("status", ["approved", "auto_approved"])
    .is("qbo_txn_id", null);
  if (catErr) throw catErr;
  const ids = (catRows || []).map((row) => row.transaction_id).filter(Boolean);
  if (!ids.length) return [];

  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
  let bankQuery = supabase
    .from("bank_transactions")
    .select("id")
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .in("id", ids);
  bankQuery = applyActiveBookkeepingScope(bankQuery, bookkeepingStartDate);
  const { data: bankRows, error: bankErr } = await bankQuery;
  if (bankErr) throw bankErr;
  return (bankRows || []).map((row) => row.id).filter(Boolean);
}

router.get("/posting/auto-post", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const enabled = await getAutoPostToQuickBooks(supabase, businessId);
    const backlogIds = await getHandledBacklogTransactionIds(businessId);
    return res.json({
      ok: true,
      auto_post_to_quickbooks: enabled,
      handled_backlog_count: backlogIds.length,
      posting_grace_hours: POSTING_GRACE_HOURS,
    });
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
    const currentEnabled = await getAutoPostToQuickBooks(supabase, businessId);
    const backlogIds = await getHandledBacklogTransactionIds(businessId);

    if (enabled && !currentEnabled && !confirmBacklog) {
      return res.status(409).json({
        ok: false,
        error: backlogIds.length ? "auto_post_backlog_confirmation_required" : "auto_post_confirmation_required",
        requires_confirmation: true,
        handled_backlog_count: backlogIds.length,
        message: backlogIds.length
          ? `You have ${backlogIds.length} handled transactions waiting. Turning on Auto-post will make them eligible for QuickBooks posting after the posting grace period.`
          : "Turn on automatic QuickBooks posting?",
      });
    }

    const { data: business, error: updateErr } = await supabase
      .from("business_profiles")
      .update({ auto_post_to_quickbooks: enabled })
      .eq("id", businessId)
      .select("id,auto_post_to_quickbooks")
      .maybeSingle();
    if (updateErr) throw updateErr;

    const nowIso = new Date().toISOString();
    const postAfter = computePostAfterForAutoPost(enabled, POSTING_GRACE_HOURS);
    if (enabled && backlogIds.length) {
      const { error: scheduleErr } = await supabase
        .from("transaction_categorizations")
        .update({
          post_after: postAfter,
          post_error: null,
          updated_at: nowIso,
        })
        .eq("business_id", businessId)
        .in("transaction_id", backlogIds)
        .is("qbo_txn_id", null)
        .in("status", ["approved", "auto_approved"]);
      if (scheduleErr) throw scheduleErr;
    }
    if (!enabled && backlogIds.length) {
      const { error: clearErr } = await supabase
        .from("transaction_categorizations")
        .update({
          post_after: null,
          updated_at: nowIso,
        })
        .eq("business_id", businessId)
        .in("transaction_id", backlogIds)
        .is("qbo_txn_id", null)
        .in("status", ["approved", "auto_approved"]);
      if (clearErr) throw clearErr;
    }

    return res.json({
      ok: true,
      auto_post_to_quickbooks: business?.auto_post_to_quickbooks === true,
      handled_backlog_count: backlogIds.length,
      scheduled_backlog_count: enabled ? backlogIds.length : 0,
      posting_grace_hours: POSTING_GRACE_HOURS,
      post_after: enabled ? postAfter : null,
    });
  } catch (err) {
    console.error("[bookkeeping][auto-post-toggle] failed", err?.message || err);
    return res.status(err?.status || 500).json({ ok: false, error: err?.code || "auto_post_toggle_failed", message: err?.message || "failed" });
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

export default router;
