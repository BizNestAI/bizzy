import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";

const router = Router();

function clampLimit(n) {
  const num = Number.parseInt(n, 10);
  if (Number.isNaN(num)) return 50;
  return Math.min(200, Math.max(1, num));
}

function clampOffset(n) {
  const num = Number.parseInt(n, 10);
  if (Number.isNaN(num) || num < 0) return 0;
  return num;
}

function parseDate(d) {
  if (!d) return null;
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(d);
  return ok ? d : null;
}

router.get("/reconciled-transactions", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  const limit = clampLimit(req.query?.limit);
  const offset = clampOffset(req.query?.offset);
  const plaidAccountId = req.query?.plaid_account_id || null;
  const dateFrom = parseDate(req.query?.date_from);
  const dateTo = parseDate(req.query?.date_to);

  try {
    // Step A: fetch posted categorizations
    const { data: catRows, error: catErr } = await supabase
      .from("transaction_categorizations")
      .select(
        "transaction_id,posted_at,qbo_txn_id,qbo_txn_type,final_qbo_account_id,final_qbo_account_name,status"
      )
      .eq("business_id", businessId)
      .eq("status", "posted")
      .not("qbo_txn_id", "is", null)
      .order("posted_at", { ascending: false, nullsLast: true })
      .range(offset, offset + limit - 1);
    if (catErr) throw catErr;

    const ids = (catRows || []).map((c) => c.transaction_id).filter(Boolean);
    if (!ids.length) {
      return res.json({
        ok: true,
        items: [],
        meta: { limit, offset, count: 0, has_more: false },
      });
    }

    // Step B: fetch bank rows with optional filters
    let bankQuery = supabase
      .from("bank_transactions")
      .select(
        "id,plaid_account_id,plaid_transaction_id,date,name,merchant_name,counterparty_name,amount,signed_amount,direction"
      )
      .eq("business_id", businessId)
      .in("id", ids);
    if (plaidAccountId) bankQuery = bankQuery.eq("plaid_account_id", plaidAccountId);
    if (dateFrom) bankQuery = bankQuery.gte("date", dateFrom);
    if (dateTo) bankQuery = bankQuery.lte("date", dateTo);

    const { data: bankRows, error: bankErr } = await bankQuery;
    if (bankErr) throw bankErr;

    const catMap = new Map((catRows || []).map((c) => [c.transaction_id, c]));
    const items = (bankRows || [])
      .map((row) => {
        const cat = catMap.get(row.id);
        if (!cat) return null;
        return {
          id: row.id,
          plaid_account_id: row.plaid_account_id,
          plaid_transaction_id: row.plaid_transaction_id,
          date: row.date,
          name: row.name,
          merchant: row.counterparty_name || row.merchant_name || null,
          amount: row.signed_amount ?? row.amount ?? null,
          direction: row.direction || null,
          category: {
            final_qbo_account_id: cat.final_qbo_account_id,
            final_qbo_account_name: cat.final_qbo_account_name,
          },
          posted_at: cat.posted_at || null,
          qbo_txn_id: cat.qbo_txn_id,
          qbo_txn_type: cat.qbo_txn_type || null,
          label: "Posted & Matched",
        };
      })
      .filter(Boolean);

    return res.json({
      ok: true,
      items,
      meta: {
        limit,
        offset,
        count: items.length,
        has_more: (catRows || []).length === limit,
      },
    });
  } catch (err) {
    console.error("[reconciled-transactions] failed", err?.message || err);
    return res
      .status(500)
      .json({ ok: false, error: "reconciled_transactions_failed", message: err?.message || "failed" });
  }
});

export default router;
