import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { postSingleBookkeepingTransactionNow, runBooksPostOnce } from "../../../jobs/booksPost.cron.js";
import { applyActiveBookkeepingScope, getBookkeepingStartDate } from "../../../services/bookkeeping/bookkeepingScope.js";
import { computePostAfterForAutoPost, getAutoPostToQuickBooks } from "../../../services/bookkeeping/autoPostControl.js";
import { assertTaxBusinessAccess } from "../../tax/taxRouteUtils.js";

const router = Router();
const POSTING_GRACE_HOURS = Number(process.env.BOOKS_POST_GRACE_HOURS || 24);

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
    const result = await postSingleBookkeepingTransactionNow({ businessId, transactionId });
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

export default router;
