import fetch from "node-fetch";
import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { withQuickBooksAuth } from "../quickbooksTokenService.js";
import { qbApiBase, qboEnvName } from "../../utils/qboEnv.js";
import { normalizeQboPurchaseExpenseRow } from "../jobCosting/qboJobCostingSyncService.js";

const PAGE_SIZE = 1000;
const MINOR_VERSION = "75";

export class ProcessorFeeRefreshError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "ProcessorFeeRefreshError";
    this.code = code;
    this.details = details;
  }
}

function dateOnly(value) {
  const parsed = new Date(`${String(value || "").slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new ProcessorFeeRefreshError("invalid_bank_transaction_date");
  return parsed;
}

function shiftDate(value, days) {
  const parsed = dateOnly(value);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function minorUnits(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(Math.abs(amount) * 100) : null;
}

export async function queryPurchasePage({ realmId, accessToken, dateFrom, dateTo, startPosition, fetchImpl }) {
  const query = `select * from Purchase where TxnDate >= '${dateFrom}' and TxnDate <= '${dateTo}' STARTPOSITION ${startPosition} MAXRESULTS ${PAGE_SIZE}`;
  const url = `${qbApiBase}/v3/company/${encodeURIComponent(realmId)}/query?${new URLSearchParams({ query, minorversion: MINOR_VERSION })}`;
  let response;
  try {
    response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  } catch (error) {
    throw new ProcessorFeeRefreshError("qbo_purchase_query_failed", { page_start: startPosition, cause: error.message });
  }
  if (!response.ok) throw new ProcessorFeeRefreshError(response.status === 401 ? "qbo_auth_refresh_failed" : "qbo_purchase_query_failed", { status: response.status, page_start: startPosition });
  const json = await response.json();
  const rows = json?.QueryResponse?.Purchase;
  if (rows !== undefined && !Array.isArray(rows)) throw new ProcessorFeeRefreshError("qbo_purchase_pagination_incomplete", { page_start: startPosition });
  return rows || [];
}

export async function fetchAllPurchasePages({ realmId, accessToken, dateFrom, dateTo, fetchImpl = fetch }) {
  const purchases = [];
  let pages = 0;
  for (let startPosition = 1; ; startPosition += PAGE_SIZE) {
    const page = await queryPurchasePage({ realmId, accessToken, dateFrom, dateTo, startPosition, fetchImpl });
    pages += 1;
    purchases.push(...page);
    if (page.length < PAGE_SIZE) return { purchases, pages, complete: true };
  }
}

export async function refreshProcessorFeeQboEvidence({ businessId, bankTransactionId, db = defaultSupabase, fetchImpl = fetch, authRunner = withQuickBooksAuth, now = new Date() } = {}) {
  const { data: bankTxn, error: bankError } = await db.from("bank_transactions")
    .select("id,business_id,date,amount,signed_amount,direction")
    .eq("business_id", businessId).eq("id", bankTransactionId).maybeSingle();
  if (bankError) throw new ProcessorFeeRefreshError("bank_transaction_lookup_failed", { code: bankError.code || null });
  if (!bankTxn) throw new ProcessorFeeRefreshError("bank_transaction_not_found");
  const amountMinor = minorUnits(bankTxn.signed_amount ?? bankTxn.amount);
  const dateFrom = shiftDate(bankTxn.date, -3);
  const dateTo = shiftDate(bankTxn.date, 3);

  try {
    return await authRunner(businessId, async (accessToken, context) => {
    const realmId = context?.realmId;
    if (!realmId) throw new ProcessorFeeRefreshError("qbo_cache_wrong_realm");
    const { data: run, error: runError } = await db.from("qbo_entity_sync_runs").insert({
      business_id: businessId, realm_id: realmId, qbo_env: qboEnvName, mode: "targeted_processor_fee",
      trigger_source: "user_retry", status: "running", started_at: now.toISOString(),
      entity_counts: { Purchase: { fetched: 0, matched_amount: 0, pages: 0, complete: false } },
    }).select("id").maybeSingle();
    if (runError) throw new ProcessorFeeRefreshError("qbo_expense_cache_migration_missing", { code: runError.code || null });

    try {
      const { purchases, pages } = await fetchAllPurchasePages({ realmId, accessToken, dateFrom, dateTo, fetchImpl });
      const rows = purchases.map((purchase) => normalizeQboPurchaseExpenseRow({ businessId, realmId, purchase, now }));
      if (rows.length) {
        const write = await db.from("qbo_expense_transactions").upsert(rows, { onConflict: "business_id,realm_id,qbo_entity_type,qbo_entity_id" });
        if (write.error) throw new ProcessorFeeRefreshError("qbo_expense_cache_write_failed", { code: write.error.code || null });
      }
      const matchedAmount = rows.filter((row) => Number(row.amount_minor) === amountMinor).length;
      const counts = { Purchase: { fetched: rows.length, matched_amount: matchedAmount, pages, complete: true } };
      const finish = await db.from("qbo_entity_sync_runs").update({ status: "succeeded", finished_at: new Date().toISOString(), entity_counts: counts, fetched_count: rows.length, errors_count: 0 }).eq("id", run.id);
      if (finish.error) throw new ProcessorFeeRefreshError("qbo_expense_cache_write_failed", { code: finish.error.code || null });
      return { ok: true, status: "refresh_complete", business_id: businessId, realm_id: realmId, date_from: dateFrom, date_to: dateTo, amount_minor: amountMinor, entity_counts: counts };
    } catch (error) {
      await db.from("qbo_entity_sync_runs").update({ status: "failed", finished_at: new Date().toISOString(), last_error: error.code || "qbo_purchase_query_failed", errors_count: 1 }).eq("id", run.id);
      throw error;
    }
    });
  } catch (error) {
    if (error instanceof ProcessorFeeRefreshError) throw error;
    if (/quickbooks_(?:not_connected|needs_reconnect)|refresh/i.test(error?.message || "")) {
      throw new ProcessorFeeRefreshError("qbo_auth_refresh_failed");
    }
    throw new ProcessorFeeRefreshError("qbo_purchase_query_failed", { cause: error?.message || null });
  }
}
