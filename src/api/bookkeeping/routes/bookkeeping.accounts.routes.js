import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { fetchChartOfAccounts } from "../../../services/bookkeeping/qboAccounts.js";
import { applyActiveBookkeepingScope, getBookkeepingStartDate } from "../../../services/bookkeeping/bookkeepingScope.js";

const router = Router();

function normalizeName(name = "") {
  return (name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

router.get("/accounts", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
    const { data: accounts, error } = await supabase
      .from("plaid_accounts")
      .select(
        "plaid_account_id,name,official_name,mask,type,subtype,current_balance,available_balance,limit_balance,iso_currency_code,unofficial_currency_code,is_active,connected_at,created_at,updated_at"
      )
      .eq("business_id", businessId)
      .eq("is_active", true)
      .order("connected_at", { ascending: true, nullsLast: true })
      .order("created_at", { ascending: true, nullsLast: true })
      .order("name", { ascending: true, nullsLast: true });
    if (error) throw error;

    const { data: healthRow } = await supabase
      .from("bookkeeping_health")
      .select("plaid_last_sync_at")
      .eq("business_id", businessId)
      .maybeSingle();
    const { data: syncRun } = await supabase
      .from("bank_sync_runs")
      .select("finished_at,started_at,status")
      .eq("business_id", businessId)
      .order("finished_at", { ascending: false, nullsLast: true })
      .limit(1)
      .maybeSingle();

    let txnStatusQuery = supabase
      .from("bank_transactions")
      .select("plaid_account_id,date,transaction_categorizations(status)")
      .eq("business_id", businessId)
      .eq("is_archived", false);
    txnStatusQuery = applyActiveBookkeepingScope(txnStatusQuery, bookkeepingStartDate);
    const { data: txnStatusData, error: txnErr } = await txnStatusQuery;
    if (txnErr) throw txnErr;

    const { data: importedTxnData, error: importedTxnErr } = await supabase
      .from("bank_transactions")
      .select("plaid_account_id,date")
      .eq("business_id", businessId)
      .eq("is_archived", false);
    if (importedTxnErr) throw importedTxnErr;

    const reviewCounts = {};
    const transactionStats = {};
    (importedTxnData || []).forEach((row) => {
      const acct = row.plaid_account_id;
      if (!acct) return;
      const stats = transactionStats[acct] || {
        first_imported_transaction_date: null,
        latest_imported_transaction_date: null,
        imported_transaction_count: 0,
      };
      stats.imported_transaction_count += 1;
      if (row.date) {
        if (!stats.first_imported_transaction_date || row.date < stats.first_imported_transaction_date) {
          stats.first_imported_transaction_date = row.date;
        }
        if (!stats.latest_imported_transaction_date || row.date > stats.latest_imported_transaction_date) {
          stats.latest_imported_transaction_date = row.date;
        }
      }
      transactionStats[acct] = stats;
    });
    (txnStatusData || []).forEach((row) => {
      const acct = row.plaid_account_id;
      if (!acct) return;
      const status = row.transaction_categorizations?.[0]?.status || null;
      const needsReview = !status || status === "needs_review" || status === "uncategorized";
      if (needsReview) {
        reviewCounts[acct] = (reviewCounts[acct] || 0) + 1;
      }
    });

    const mapped = (accounts || []).map((a) => {
      const balance = a?.current_balance ?? a?.available_balance ?? a?.limit_balance ?? null;
      const stats = transactionStats[a.plaid_account_id] || {};
      return {
        id: a.plaid_account_id,
        name: a.name || a.official_name || "Bank account",
        mask: a.mask || null,
        type: a.type || null,
        subtype: a.subtype || null,
        balance: balance != null ? Number(balance) : null,
        currency: a?.iso_currency_code || null,
        toReview: reviewCounts[a.plaid_account_id] || 0,
        importedTransactionCount: stats.imported_transaction_count || 0,
        firstImportedTransactionDate: stats.first_imported_transaction_date || null,
        latestImportedTransactionDate: stats.latest_imported_transaction_date || null,
        bookkeepingStartDate,
        connected_at: a.connected_at || null,
        created_at: a.created_at || null,
        last_synced_at: null,
      };
    });

    return res.json({
      ok: true,
      accounts: mapped,
      meta: {
        last_sync_at: syncRun?.finished_at || syncRun?.started_at || healthRow?.plaid_last_sync_at || null,
        bookkeeping_start_date: bookkeepingStartDate,
      },
    });
  } catch (err) {
    console.error("[bookkeeping][accounts] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "accounts_fetch_failed", message: err?.message || "failed" });
  }
});

router.get("/qbo/coa", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const coa = await fetchChartOfAccounts(businessId);
    return res.json({ ok: true, accounts: coa || [] });
  } catch (err) {
    console.error("[bookkeeping][coa] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "coa_fetch_failed", message: err?.message || "failed" });
  }
});

export default router;
