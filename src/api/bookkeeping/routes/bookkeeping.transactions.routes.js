import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { resolvePayee } from "../../../services/bookkeeping/payeeResolver.js";
import { learnVendorRuleFromTransaction } from "../../../services/bookkeeping/vendorRuleLearner.js";
import { enqueueUnresolvedBookkeepingBacklog } from "../../../services/bookkeeping/backgroundBookkeepingProcessingService.js";
import { isCheck } from "../../../services/bookkeeping/checkDetector.js";
import { applyActiveBookkeepingScope, getBookkeepingStartDate, isTransactionInActiveBookkeepingScope } from "../../../services/bookkeeping/bookkeepingScope.js";
import {
  computeRangeStartDate,
  countBookkeepingTransactions,
  fetchBookkeepingTransactions,
  matchesTransactionStatusFilter,
  normalizeBookkeepingDate,
  normalizePostedBookTransaction,
  rangeStartDateForBookkeeping,
} from "../../../services/bookkeeping/bookkeepingTransactionFeedService.js";

/* global process */
const router = Router();

const computeRangeStart = computeRangeStartDate;
const normalizeDate = normalizeBookkeepingDate;

export {
  countBookkeepingTransactions,
  fetchBookkeepingTransactions,
  matchesTransactionStatusFilter,
  normalizePostedBookTransaction,
  rangeStartDateForBookkeeping,
};

/* ----------------------------- Grace edits ----------------------------- */
router.patch("/transactions/:transactionId", requireAuth, async (req, res) => {
  const raw = req.body || {};
  const businessId = ensureBusinessId(req, res);
  const transactionId = req.params?.transactionId;
  if (!businessId) return;
  if (!transactionId) return res.status(400).json({ ok: false, error: "missing_transaction_id" });

  try {
    const { data: current, error: curErr } = await supabase
      .from("transaction_categorizations")
      .select("status,post_after,meta,final_qbo_account_id,final_qbo_account_name")
      .eq("business_id", businessId)
      .eq("transaction_id", transactionId)
      .maybeSingle();
    if (curErr) throw curErr;
    const status = current?.status || null;
    const postAfterTs = current?.post_after ? Date.parse(current.post_after) : null;
    const nowTs = Date.now();
    const inGrace = status && ["approved", "auto_approved"].includes(status) && (postAfterTs ? postAfterTs > nowTs : false);
    if (!inGrace) {
      return res.status(400).json({ ok: false, error: "not_in_grace_window" });
    }
    const prevFinalId = current?.final_qbo_account_id || null;

    const nowIso = new Date().toISOString();
    const nextPostAfter = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
    const { data: bankTxn, error: bankErr } = await supabase
      .from("bank_transactions")
      .select("id,date,name,merchant_name,counterparty_name,transaction_type,check_number,merchant_entity_id,qbo_entity_type,qbo_entity_id,amount,direction,category_primary,personal_finance_category")
      .eq("business_id", businessId)
      .eq("is_archived", false)
      .eq("id", transactionId)
      .maybeSingle();
    if (bankErr) throw bankErr;
    if (!isTransactionInActiveBookkeepingScope(bankTxn, bookkeepingStartDate)) {
      return res.status(400).json({
        ok: false,
        error: "transaction_before_bookkeeping_start_date",
        bookkeeping_start_date: bookkeepingStartDate,
      });
    }

    const checkHit = isCheck(bankTxn || {});
    const nextFinalId = raw.final_qbo_account_id || raw.finalAccountId || raw.newAccountId || null;
    const nextFinalName = raw.final_qbo_account_name || raw.finalAccountName || raw.newAccountName || null;
    if (checkHit.is_check && !nextFinalId) {
      return res.status(400).json({ ok: false, error: "missing_final_account_for_check" });
    }
    let nextMeta = raw.meta === undefined ? (current?.meta || null) : raw.meta;
    if (checkHit.is_check) {
      const metaObj = { ...(nextMeta || {}) };
      metaObj.is_check = true;
      metaObj.check_confidence = checkHit.confidence;
      metaObj.check_reason = checkHit.reason;
      if (checkHit.check_number) metaObj.check_number = checkHit.check_number;
      metaObj.taxonomy_flags = { ...(metaObj.taxonomy_flags || {}), is_check: true };
      nextMeta = metaObj;
    }

    const updatePayload = {
      final_qbo_account_id: nextFinalId,
      final_qbo_account_name: nextFinalName,
      reason: raw.reason || null,
      meta: nextMeta,
      updated_at: nowIso,
      post_after: nextPostAfter,
      post_error: null,
    };

    const { data: updated, error: updErr } = await supabase
      .from("transaction_categorizations")
      .update(updatePayload)
      .eq("business_id", businessId)
      .eq("transaction_id", transactionId)
      .select("business_id,transaction_id,status,final_qbo_account_id,final_qbo_account_name,post_after");
    if (updErr) throw updErr;

    try {
      if (bankTxn) {
        const taxonomyType = current?.meta?.taxonomy_type || null;
        if (checkHit.is_check && nextFinalId && nextFinalId !== prevFinalId) {
          await learnVendorRuleFromTransaction({
            businessId,
            bankTxn,
            finalAccountId: updatePayload.final_qbo_account_id,
            finalAccountName: updatePayload.final_qbo_account_name,
            taxonomyType,
            options: { allowQboEntityFallback: true, learnedFrom: "check" },
          });
        } else {
          await learnVendorRuleFromTransaction({
            businessId,
            bankTxn,
            finalAccountId: updatePayload.final_qbo_account_id,
            finalAccountName: updatePayload.final_qbo_account_name,
            taxonomyType,
          });
        }
      }
    } catch (e) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[bookkeeping][grace-edit] vendor rule learn skipped", e?.message || e);
      }
    }

    try {
      await enqueueUnresolvedBookkeepingBacklog({
        businessId,
        supabase,
        limit: 100,
        now: new Date(),
      });
    } catch (e) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[bookkeeping][grace-edit] unresolved backlog enqueue skipped", e?.message || e);
      }
    }

    return res.json({ ok: true, rows: updated || [], post_after: nextPostAfter });
  } catch (err) {
    console.error("[bookkeeping][grace-edit] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "grace_edit_failed", message: err?.message || "failed" });
  }
});

/* ----------------------------- Transactions ----------------------------- */
router.get("/transactions/counts", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  const accountId = req.query?.account_id || req.query?.plaid_account_id || null;
  const rangeParam = (req.query?.range || "this_month").toLowerCase();

  try {
    const [needsReview, handled, posted] = await Promise.all([
      countBookkeepingTransactions({ businessId, statusFilter: "needs_review", accountId, rangeParam }),
      countBookkeepingTransactions({ businessId, statusFilter: "handled", accountId, rangeParam }),
      countBookkeepingTransactions({ businessId, statusFilter: "posted", accountId, rangeParam }),
    ]);
    const counts = { needs_review: needsReview, handled, posted };

    return res.json({ ok: true, counts });
  } catch (err) {
    console.error("[bookkeeping][transaction-counts] failed", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "transaction_counts_fetch_failed",
      message: err?.message || "failed",
    });
  }
});

router.get("/transactions", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  const statusFilter = (req.query?.status || "needs_review").toLowerCase();
  const accountId = req.query?.account_id || req.query?.plaid_account_id || null;
  const rangeParam = (req.query?.range || "this_month").toLowerCase();
  const page = Math.max(parseInt(req.query?.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query?.page_size, 10) || 25, 1), 200);

  try {
    const { rows, totalCount } = await fetchBookkeepingTransactions({
      businessId,
      statusFilter,
      accountId,
      rangeParam,
      page,
      pageSize,
    });

    if (process.env.NODE_ENV !== "production") {
      console.info("[bookkeeping][transactions] returning", { count: rows.length, sample: rows[0] });
    }

    return res.json({
      ok: true,
      rows,
      totalCount,
      total_count: totalCount,
      meta: {
        page,
        page_size: pageSize,
        total_count: totalCount,
        page_count: Math.max(1, Math.ceil(totalCount / pageSize)),
      },
    });
  } catch (err) {
    console.error("[bookkeeping][transactions] failed", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "transactions_fetch_failed",
      message: err?.message || "failed",
    });
  }
});

/* ----------------------------- Payee enrichment ----------------------------- */
router.post("/enrich-counterparties", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  const body = req.body || {};
  const txnIds = Array.isArray(body.transaction_ids) ? body.transaction_ids : null;
  const rangeParam = (body.range || req.query?.range || "last_30").toLowerCase();
  const accountId = body.account_id || req.query?.account_id || null;
  const rangeStart = txnIds ? null : computeRangeStart(rangeParam);

  try {
    const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
    let txQuery = supabase
      .from("bank_transactions")
      .select(
        "id,business_id,plaid_account_id,plaid_transaction_id,date,name,merchant_name,merchant_entity_id,counterparties,direction,counterparty_name,counterparty_source,counterparty_confidence,canonical_vendor_id,qbo_entity_type,qbo_entity_id"
      )
      .eq("business_id", businessId)
      .eq("is_archived", false);
    if (txnIds && txnIds.length) {
      txQuery.in("id", txnIds);
    } else {
      if (rangeStart) txQuery.gte("date", normalizeDate(rangeStart));
      if (accountId) txQuery.eq("plaid_account_id", accountId);
    }
    txQuery = applyActiveBookkeepingScope(txQuery, bookkeepingStartDate);

    const { data: txns, error: txErr } = await txQuery;
    if (txErr) throw txErr;
    if (!txns || !txns.length) return res.json({ ok: true, updated: 0, skipped: 0, total: 0 });

    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (const row of txns) {
      if ((row.counterparty_source || "").toLowerCase() === "user_override") {
        skipped += 1;
        continue;
      }
      let result;
      try {
        result = await resolvePayee({ businessId, txn: row });
      } catch (err) {
        errors.push({ id: row.id, error: err?.message || String(err) });
        continue;
      }
      if (!result) {
        skipped += 1;
        continue;
      }

      const nextPayload = {
        counterparty_name: result.counterpartyName || null,
        counterparty_source: result.source || null,
        counterparty_confidence: result.confidence || null,
        qbo_entity_type: result.qbo_entity_type || null,
        qbo_entity_id: result.qbo_entity_id || null,
      };

      const changed = Object.entries(nextPayload).some(([key, val]) => {
        const current = row[key] == null ? null : row[key];
        const next = val == null ? null : val;
        return current !== next;
      });
      if (!changed) {
        skipped += 1;
        continue;
      }

      const { error: updErr } = await supabase
        .from("bank_transactions")
        .update(nextPayload)
        .eq("business_id", businessId)
        .eq("id", row.id);
      if (updErr) {
        errors.push({ id: row.id, error: updErr?.message || String(updErr) });
      } else {
        updated += 1;
      }
    }

    return res.json({ ok: true, updated, skipped, total: txns.length, errors });
  } catch (err) {
    console.error("[bookkeeping][enrich-counterparties] failed", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "enrich_counterparties_failed",
      message: err?.message || "failed",
    });
  }
});

export default router;
