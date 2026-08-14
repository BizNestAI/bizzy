import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { resolvePayee } from "../../../services/bookkeeping/payeeResolver.js";
import { learnVendorRuleFromTransaction } from "../../../services/bookkeeping/vendorRuleLearner.js";
import { isCheck } from "../../../services/bookkeeping/checkDetector.js";

/* global process */
const router = Router();

function firstDayOfMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function computeRangeStart(range) {
  const now = new Date();
  switch (range) {
    case "last_30": {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return d;
    }
    case "last_90": {
      const d = new Date(now);
      d.setDate(d.getDate() - 90);
      return d;
    }
    case "all":
      return null;
    case "this_month":
    default:
      return firstDayOfMonth();
  }
}

function normalizeDate(d) {
  if (!d) return null;
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function matchesTransactionStatusFilter(statusFilter, cat = {}) {
  const status = cat?.status || "needs_review";
  const isCheckTxn = cat?.meta?.is_check === true;
  const handledView = statusFilter === "approved" || statusFilter === "handled";
  const postedView = statusFilter === "posted";

  if (postedView) {
    const hasQbo = Boolean(cat?.qbo_txn_id);
    return status === "posted" || hasQbo;
  }

  if (handledView) {
    return ["approved", "auto_approved"].includes(status);
  }

  if (!status || status === "needs_review" || status === "uncategorized") return true;
  if (status === "auto_approved" && isCheckTxn) return true;
  return false;
}

function normalizeBookkeepingTransactionRow(row, cat = {}, acctName = null) {
  const suggestedId = cat.suggested_qbo_account_id || null;
  const suggestedName = cat.suggested_qbo_account_name || null;
  const finalId = cat.final_qbo_account_id || null;
  const finalName = cat.final_qbo_account_name || null;
  const amount = Number(row.amount || 0);
  const dir = row.direction || (amount < 0 ? "OUTFLOW" : amount > 0 ? "INFLOW" : "UNKNOWN");
  return {
    id: row.id,
    plaidTransactionId: row.plaid_transaction_id || null,
    plaidAccountId: row.plaid_account_id || null,
    plaid_account_id: row.plaid_account_id || null,
    date: row.date,
    vendor: row.counterparty_name || row.merchant_name || "",
    payee: row.counterparty_name || row.merchant_name || "",
    description: row.name || "",
    amount,
    signed_amount: amount,
    direction: dir,
    currentAccount: acctName,
    suggestedAccountId: suggestedId,
    suggestedAccountName: suggestedName,
    final_qbo_account_id: finalId,
    final_qbo_account_name: finalName,
    glAccountId: finalId || suggestedId || null,
    glAccountName: finalName || suggestedName || null,
    confidence: cat.confidence || null,
    reason: cat.reason || null,
    status: cat.status || "needs_review",
    payeeSource: row.counterparty_source || null,
    payeeConfidence: row.counterparty_confidence || null,
    qboEntityType: row.qbo_entity_type || null,
    qboEntityId: row.qbo_entity_id || null,
    is_check: cat.meta?.is_check === true,
    check_number: cat.meta?.check_number || null,
    vendor_rule_id: cat.meta?.vendor_rule_id || null,
    suggestion_source: cat.meta?.suggestion_source || null,
    vendor_rule_match_reason: cat.meta?.vendor_rule_match_reason || null,
    posted_at: cat.posted_at || null,
    reconciled_at: cat.reconciled_at || null,
    qbo_txn_type: cat.qbo_txn_type || null,
    qbo_txn_id: cat.qbo_txn_id || null,
    post_after: cat.post_after || null,
  };
}

// Job Costing uses posted Books transactions as the source of truth.
export function normalizePostedBookTransaction(row = {}) {
  const bankMemo =
    row.bank_memo ||
    row.memo ||
    row.transaction_memo ||
    row.plaid_memo ||
    row.original_description ||
    row.originalDescription ||
    row.name ||
    row.description ||
    "";

  return {
    id: row.id,
    transaction_id: row.id,
    date: row.date,
    vendor: row.vendor || row.payee || "",
    payee: row.payee || row.vendor || "",
    description: bankMemo,
    memo: bankMemo,
    bank_memo: bankMemo,
    original_description: row.original_description || row.originalDescription || row.name || row.description || "",
    amount: Number(row.amount || 0),
    direction: row.direction || (Number(row.amount || 0) < 0 ? "OUTFLOW" : "INFLOW"),
    final_qbo_account_id: row.final_qbo_account_id || row.glAccountId || null,
    final_qbo_account_name: row.final_qbo_account_name || row.glAccountName || null,
    gl_account_id: row.final_qbo_account_id || row.glAccountId || null,
    gl_account: row.final_qbo_account_name || row.glAccountName || "Uncategorized",
    qbo_txn_id: row.qbo_txn_id || null,
    qbo_txn_type: row.qbo_txn_type || null,
    posted_at: row.posted_at || null,
    plaid_account_id: row.plaid_account_id || row.plaidAccountId || null,
    status: row.status || "posted",
  };
}

export async function fetchBookkeepingTransactions({
  businessId,
  statusFilter = "needs_review",
  accountId = null,
  rangeParam = "this_month",
  page = 1,
  pageSize = 25,
} = {}) {
  // Step A: fetch bank transactions
  const txQuery = supabase
    .from("bank_transactions")
    .select(
      "id,plaid_account_id,plaid_transaction_id,date,name,merchant_name,counterparties,counterparty_name,counterparty_source,counterparty_confidence,qbo_entity_type,qbo_entity_id,amount,signed_amount,direction,pending,category_primary,category_detailed,personal_finance_category"
    )
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .order("date", { ascending: false });

  const rangeStart = computeRangeStart(rangeParam);
  if (rangeStart) txQuery.gte("date", normalizeDate(rangeStart));
  if (accountId) txQuery.eq("plaid_account_id", accountId);

  const { data: baseRows, error: txErr } = await txQuery;
  if (txErr) throw txErr;

  // Step B: fetch categorizations separately
  const ids = (baseRows || []).map((r) => r.id);
  let catMap = {};
  if (ids.length) {
    const { data: catRows, error: catErr } = await supabase
      .from("transaction_categorizations")
      .select(
        "transaction_id,status,suggested_qbo_account_id,suggested_qbo_account_name,confidence,reason,final_qbo_account_id,final_qbo_account_name,post_after,qbo_txn_id,qbo_txn_type,posted_at,reconciled_at,post_error,last_post_attempt_at,meta"
      )
      .eq("business_id", businessId)
      .in("transaction_id", ids);
    if (catErr) throw catErr;
    catMap = (catRows || []).reduce((acc, row) => {
      acc[row.transaction_id] = row;
      return acc;
    }, {});
  }

  // Step C: fetch plaid accounts for display name
  const uniqueAccountIds = Array.from(new Set((baseRows || []).map((row) => row.plaid_account_id).filter(Boolean)));
  let accountMap = {};
  if (uniqueAccountIds.length) {
    const { data: acctRows, error: acctErr } = await supabase
      .from("plaid_accounts")
      .select("plaid_account_id,name,official_name")
      .eq("business_id", businessId)
      .in("plaid_account_id", uniqueAccountIds);
    if (acctErr) throw acctErr;
    accountMap = (acctRows || []).reduce((acc, row) => {
      acc[row.plaid_account_id] = row.name || row.official_name || null;
      return acc;
    }, {});
  }

  const filtered = (baseRows || []).filter((row) => matchesTransactionStatusFilter(statusFilter, catMap[row.id] || {}));
  const totalCount = filtered.length;
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const pageRows = filtered.slice(start, end);

  const rows = pageRows.map((row) => normalizeBookkeepingTransactionRow(row, catMap[row.id] || {}, accountMap[row.plaid_account_id] || null));
  return { rows, totalCount };
}

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
    const { data: bankTxn, error: bankErr } = await supabase
      .from("bank_transactions")
      .select("id,name,merchant_name,counterparty_name,transaction_type,check_number,merchant_entity_id,qbo_entity_type,qbo_entity_id,amount,direction,category_primary,personal_finance_category")
      .eq("business_id", businessId)
      .eq("is_archived", false)
      .eq("id", transactionId)
      .maybeSingle();
    if (bankErr) throw bankErr;

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
    const txQuery = supabase
      .from("bank_transactions")
      .select("id")
      .eq("business_id", businessId)
      .eq("is_archived", false);

    const rangeStart = computeRangeStart(rangeParam);
    if (rangeStart) txQuery.gte("date", normalizeDate(rangeStart));
    if (accountId) txQuery.eq("plaid_account_id", accountId);

    const { data: baseRows, error: txErr } = await txQuery;
    if (txErr) throw txErr;

    const ids = (baseRows || []).map((row) => row.id);
    let catMap = {};
    if (ids.length) {
      const { data: catRows, error: catErr } = await supabase
        .from("transaction_categorizations")
        .select("transaction_id,status,qbo_txn_id,meta")
        .eq("business_id", businessId)
        .in("transaction_id", ids);
      if (catErr) throw catErr;
      catMap = (catRows || []).reduce((acc, row) => {
        acc[row.transaction_id] = row;
        return acc;
      }, {});
    }

    const counts = { needs_review: 0, handled: 0, posted: 0 };
    (baseRows || []).forEach((row) => {
      const cat = catMap[row.id] || {};
      if (matchesTransactionStatusFilter("needs_review", cat)) counts.needs_review += 1;
      if (matchesTransactionStatusFilter("handled", cat)) counts.handled += 1;
      if (matchesTransactionStatusFilter("posted", cat)) counts.posted += 1;
    });

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
    const txQuery = supabase
      .from("bank_transactions")
      .select(
        "id,business_id,plaid_account_id,plaid_transaction_id,date,name,merchant_name,merchant_entity_id,counterparties,direction,counterparty_name,counterparty_source,counterparty_confidence,qbo_entity_type,qbo_entity_id"
      )
      .eq("business_id", businessId)
      .eq("is_archived", false);
    if (txnIds && txnIds.length) {
      txQuery.in("id", txnIds);
    } else {
      if (rangeStart) txQuery.gte("date", normalizeDate(rangeStart));
      if (accountId) txQuery.eq("plaid_account_id", accountId);
    }

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
