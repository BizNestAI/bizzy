import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { applyActiveBookkeepingScope, getBookkeepingStartDate } from "../../../services/bookkeeping/bookkeepingScope.js";

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
    const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
    // Correctness-first implementation:
    // fetch the posted categorizations in posted_at order, apply bank-row filters,
    // then paginate the fully filtered result set. This can later move to an RPC/view
    // if posted transaction volume grows large enough to require DB-side pagination.
    const { data: catRows, error: catErr } = await supabase
      .from("transaction_categorizations")
      .select(
        "transaction_id,posted_at,qbo_txn_id,qbo_txn_type,final_qbo_account_id,final_qbo_account_name,status"
      )
      .eq("business_id", businessId)
      .eq("status", "posted")
      .not("qbo_txn_id", "is", null)
      .order("posted_at", { ascending: false, nullsLast: true });
    if (catErr) throw catErr;

    const candidateRows = catRows || [];
    const candidateIds = candidateRows.map((c) => c.transaction_id).filter(Boolean);
    if (!candidateIds.length) {
      return res.json({
        ok: true,
        items: [],
        meta: { limit, offset, count: 0, total: 0, has_more: false },
      });
    }

    // Step C: fetch matching active bank rows with optional filters before pagination
    let bankQuery = supabase
      .from("bank_transactions")
      .select(
        "id,plaid_account_id,plaid_transaction_id,date,name,merchant_name,counterparty_name,amount,signed_amount,direction"
      )
      .eq("business_id", businessId)
      .eq("is_archived", false)
      .in("id", candidateIds);
    bankQuery = applyActiveBookkeepingScope(bankQuery, bookkeepingStartDate);
    if (plaidAccountId) bankQuery = bankQuery.eq("plaid_account_id", plaidAccountId);
    if (dateFrom) bankQuery = bankQuery.gte("date", dateFrom);
    if (dateTo) bankQuery = bankQuery.lte("date", dateTo);

    const { data: bankRows, error: bankErr } = await bankQuery;
    if (bankErr) throw bankErr;

    // Step D/E: preserve posted_at ordering from categorizations and only keep matched bank rows
    const bankMap = new Map((bankRows || []).map((row) => [row.id, row]));
    const filteredItems = candidateRows
      .map((cat) => {
        const row = bankMap.get(cat.transaction_id);
        if (!row) return null;
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

    // Step F: paginate after all filters are applied
    const totalFiltered = filteredItems.length;
    const pagedItems = filteredItems.slice(offset, offset + limit);
    const hasMore = offset + limit < totalFiltered;

    if (process.env.NODE_ENV !== "production") {
      console.info("[reconciled-transactions] filtered result", {
        businessId,
        candidate_count: candidateRows.length,
        matched_bank_count: (bankRows || []).length,
        total_filtered: totalFiltered,
        returned_count: pagedItems.length,
        limit,
        offset,
      });
    }

    return res.json({
      ok: true,
      items: pagedItems,
      meta: {
        limit,
        offset,
        count: pagedItems.length,
        total: totalFiltered,
        has_more: hasMore,
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
