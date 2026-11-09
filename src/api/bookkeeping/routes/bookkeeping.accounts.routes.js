import { getPlaidAccountRecoveryStatus } from "../../../services/plaid/plaidAccountRecoveryStatus.js";
import { plaidEnvName } from "../../../services/plaid/plaidClient.js";
import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { fetchChartOfAccounts } from "../../../services/bookkeeping/qboAccounts.js";
import { getBookkeepingStartDate } from "../../../services/bookkeeping/bookkeepingScope.js";
import { countBookkeepingTransactions } from "../../../services/bookkeeping/bookkeepingTransactionFeedService.js";
import { isAdminViewRequest, sendAdminViewReadOnlyUnavailable } from "../../_shared/tenantAuth.js";
import { projectPlaidAccountConnectionState, projectPlaidSyncAvailability } from "../../../services/plaid/plaidAccountConnectionState.js";

const router = Router();

router.get("/accounts", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
    const { data: accounts, error } = await supabase
      .from("plaid_accounts")
      .select(
        "plaid_account_id,plaid_item_id,plaid_env,name,official_name,mask,type,subtype,current_balance,available_balance,limit_balance,iso_currency_code,unofficial_currency_code,is_active,connection_state,connection_state_version,disconnected_at,reconnected_at,connected_at,last_sync_at,created_at,updated_at"
      )
      .eq("business_id", businessId)
      .order("connected_at", { ascending: true, nullsLast: true })
      .order("created_at", { ascending: true, nullsLast: true })
      .order("name", { ascending: true, nullsLast: true });
    if (error) throw error;

    const itemIds = [...new Set((accounts || []).map((account) => account.plaid_item_id).filter(Boolean))];
    const { data: items, error: itemsError } = itemIds.length
      ? await supabase.from("plaid_items")
        .select("plaid_item_id,status,is_active,disconnected_at,error_code,last_success_at")
        .eq("business_id", businessId)
        .in("plaid_item_id", itemIds)
      : { data: [], error: null };
    if (itemsError) throw itemsError;
    const itemById = new Map((items || []).map((item) => [String(item.plaid_item_id), item]));

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

    const recovery = await getPlaidAccountRecoveryStatus({ db: supabase, businessId, plaidEnv: plaidEnvName });
    const transactionStats = Object.fromEntries(recovery.accounts.map(a => [a.id, {
      first_imported_transaction_date: a.recovery_status.transaction_import.first_active_transaction_date,
      latest_imported_transaction_date: a.recovery_status.transaction_import.latest_active_transaction_date,
      recovery_status: a.recovery_status,
    }]));

    const displayedAccounts = recovery.accounts.map(a => ({ ...a, plaid_account_id: a.id }));
    const reviewCountPairs = await Promise.all(
      displayedAccounts.map(async (account) => [
        account.plaid_account_id,
        await countBookkeepingTransactions({
          businessId,
          statusFilter: "needs_review",
          accountId: account.plaid_account_id,
          rangeParam: "all",
        }),
      ])
    );
    const reviewCounts = Object.fromEntries(reviewCountPairs.filter(([accountId]) => accountId));

    const mapped = displayedAccounts.map((a) => {
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
        importedTransactionCount: stats.recovery_status?.transaction_import.persisted_active_count || 0,
        recovery_status: stats.recovery_status || null,
        firstImportedTransactionDate: stats.first_imported_transaction_date || null,
        latestImportedTransactionDate: stats.latest_imported_transaction_date || null,
        bookkeepingStartDate,
        connection_state: a.connection_state === "closed_historical" ? "closed_historical"
          : stats.recovery_status?.bank_connection.state === "institution_unavailable" ? "connected"
            : stats.recovery_status?.bank_connection.state || projectPlaidAccountConnectionState({
              account: a, item: itemById.get(String(a.plaid_item_id)) || {},
            }),
        sync_availability: stats.recovery_status?.transaction_import.reason_code === "internal_transaction_persistence_failure"
          ? "internal_failure" : stats.recovery_status?.transaction_import.state === "current" ? "active"
            : stats.recovery_status?.transaction_import.state || projectPlaidSyncAvailability(itemById.get(String(a.plaid_item_id)) || {}),
        connection_state_version: a.connection_state_version || 0,
        disconnected_at: a.disconnected_at || itemById.get(String(a.plaid_item_id))?.disconnected_at || null,
        connected_at: a.connected_at || null,
        created_at: a.created_at || null,
        last_synced_at: a.last_sync_at || itemById.get(String(a.plaid_item_id))?.last_success_at || null,
      };
    });

    return res.json({
      ok: true,
      accounts: mapped,
      account_recovery: recovery,
      meta: {
        last_attempt_at: syncRun?.started_at || null,
        last_sync_at: recovery.accounts.map(a => a.recovery_status.transaction_import.last_completed_checkpoint_at).filter(Boolean).sort().at(-1) || healthRow?.plaid_last_sync_at || null,
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
  if (isAdminViewRequest(req)) {
    return sendAdminViewReadOnlyUnavailable(res, { error: "admin_view_provider_refresh_blocked", status: 403 });
  }
  try {
    const forceRefresh = req.query?.refresh === "1" || req.query?.refresh === "true";
    const coa = await fetchChartOfAccounts(businessId, { forceRefresh });
    return res.json({
      ok: true,
      accounts: coa || [],
      meta: { source: "quickbooks_chart_of_accounts", includes_subaccounts: true, refreshed: forceRefresh },
    });
  } catch (err) {
    console.error("[bookkeeping][coa] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "coa_fetch_failed", message: err?.message || "failed" });
  }
});

export default router;
