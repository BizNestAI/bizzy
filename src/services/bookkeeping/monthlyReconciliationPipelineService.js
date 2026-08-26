import { supabase } from "../supabaseAdmin.js";
import { deriveQboPostingLifecycle } from "./qboPostingLifecycle.js";
import { formatPlaidAccountDisplayLabel } from "./postingTraceDisplay.js";
import {
  derivePipelineStatus,
  finalizePipelineTotals,
  summarizePipelineStatuses,
} from "./reconciliationPipelineStatus.js";

function monthBounds(month) {
  const [year, monthNumber] = String(month).split("-").map(Number);
  const start = new Date(Date.UTC(year, monthNumber - 1, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
  return [start, end];
}

function normalizeAccountName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function toDateString(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

async function safeRows(factory, label = "Monthly reconciliation pipeline query") {
  try {
    const { data, error } = await factory();
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  } catch (e) {
    const message = `${label} could not be loaded: ${e?.message || e}`;
    console.warn("[monthly-reconciliation-pipeline] read skipped", message);
    const rows = [];
    Object.defineProperty(rows, "__evidence_error", {
      value: message,
      enumerable: false,
    });
    return rows;
  }
}

export function removeSupersededPendingPlaidRows(rows = []) {
  const activePostedPendingRefs = new Set(
    (rows || [])
      .filter((row) => row?.pending !== true && row?.pending_transaction_id)
      .map((row) => String(row.pending_transaction_id))
  );
  return (rows || []).filter((row) => {
    if (row?.pending === true && row?.plaid_transaction_id && activePostedPendingRefs.has(String(row.plaid_transaction_id))) {
      return false;
    }
    return true;
  });
}

export async function loadAuthoritativeMonthlyPlaidTransactions(businessId, start, end) {
  const rows = await safeRows(() =>
    supabase
      .from("bank_transactions")
      .select("id,plaid_account_id,plaid_transaction_id,pending_transaction_id,date,name,merchant_name,counterparty_name,amount,signed_amount,direction,pending,is_archived")
      .eq("business_id", businessId)
      .eq("is_archived", false)
      .not("plaid_transaction_id", "is", null)
      .not("plaid_account_id", "is", null)
      .gte("date", start)
      .lt("date", end)
      .order("date", { ascending: true }),
    "Authoritative monthly Plaid transactions"
  );
  return removeSupersededPendingPlaidRows(rows);
}

async function loadPlaidAccountLabels(businessId, plaidAccountIds = []) {
  const ids = Array.from(new Set((plaidAccountIds || []).filter(Boolean).map(String)));
  if (!businessId || !ids.length) return new Map();

  const accountRows = await safeRows(() =>
    supabase
      .from("plaid_accounts")
      .select("plaid_account_id,plaid_item_id,name,official_name,mask,type,subtype,is_active")
      .eq("business_id", businessId)
      .in("plaid_account_id", ids),
    "Monthly reconciliation Plaid accounts"
  );
  const itemIds = Array.from(new Set((accountRows || []).map((row) => row.plaid_item_id).filter(Boolean)));
  const itemRows = itemIds.length
    ? await safeRows(() =>
        supabase
          .from("plaid_items")
          .select("plaid_item_id,institution_name")
          .eq("business_id", businessId)
          .in("plaid_item_id", itemIds),
        "Monthly reconciliation Plaid items"
      )
    : [];
  const institutionByItemId = new Map((itemRows || []).map((row) => [String(row.plaid_item_id), row.institution_name || null]));
  return new Map((accountRows || []).map((row) => [
    String(row.plaid_account_id),
    formatPlaidAccountDisplayLabel({
      ...row,
      institution_name: institutionByItemId.get(String(row.plaid_item_id)) || null,
    }),
  ]));
}

async function loadReconciliationItemsForMonthlyPipeline(businessId, month, transactionIds = []) {
  const ids = Array.from(new Set((transactionIds || []).filter(Boolean).map(String)));
  if (!businessId || !ids.length) return new Map();
  const [start, end] = monthBounds(month);
  const runs = await safeRows(() =>
    supabase
      .from("reconciliation_runs")
      .select("id,period_start,last_checked_at,created_at")
      .eq("business_id", businessId)
      .or(`period_start.gte.${start},last_checked_at.gte.${start},created_at.gte.${start}`)
      .order("last_checked_at", { ascending: false, nullsLast: true })
      .limit(5),
    "Monthly reconciliation runs"
  );
  const run = runs.find((item) => {
    const periodStart = toDateString(item.period_start || item.created_at || item.last_checked_at);
    return !periodStart || periodStart < end;
  }) || runs[0] || null;
  if (!run?.id) return new Map();

  const items = await safeRows(() =>
    supabase
      .from("reconciliation_items")
      .select("id,bank_transaction_id,status,note,details,qbo_txn_id,qbo_txn_type,reconciled_at,posted_at")
      .eq("business_id", businessId)
      .eq("run_id", run.id)
      .in("bank_transaction_id", ids),
    "Monthly reconciliation items"
  );
  return new Map((items || []).filter((row) => row.bank_transaction_id).map((row) => [String(row.bank_transaction_id), row]));
}

export function buildMonthlyPipelineRow({
  row,
  cat = {},
  plaidAccountLabels = new Map(),
  accountById = new Map(),
  accountByName = new Map(),
  reconciliationItem = null,
} = {}) {
  const accountId = cat.final_qbo_account_id || cat.suggested_qbo_account_id || null;
  const accountName = cat.final_qbo_account_name || cat.suggested_qbo_account_name || "Uncategorized";
  const chartAccount = accountId ? accountById.get(String(accountId)) : accountByName.get(normalizeAccountName(accountName));
  const qboSyncStatus = deriveQboPostingLifecycle(cat);
  const pipelineStatus = derivePipelineStatus({
    bank: row,
    cat,
    reconciliationItem,
  });
  const amount = Number(row.signed_amount ?? row.amount ?? 0);
  return {
    id: `recon-${row.id}`,
    transaction_id: row.id,
    bank_transaction_id: row.id,
    plaid_transaction_id: row.plaid_transaction_id || null,
    plaid_date: row.date,
    txn_date: row.date,
    payee: row.counterparty_name || row.merchant_name || row.name || "",
    merchant: row.counterparty_name || row.merchant_name || "",
    description: row.name || "",
    amount: Number.isFinite(amount) ? amount : 0,
    direction: row.direction || (Number(amount) < 0 ? "outflow" : Number(amount) > 0 ? "inflow" : null),
    plaid_account_id: row.plaid_account_id || null,
    bank_account: plaidAccountLabels.get(String(row.plaid_account_id)) || "Financial account",
    bizzi_gl_account: chartAccount?.name || accountName || "Uncategorized",
    category_name: chartAccount?.name || accountName || "Uncategorized",
    qbo_txn_id: cat.qbo_txn_id || null,
    qbo_txn_type: cat.qbo_txn_type || null,
    qbo_lifecycle_status: qboSyncStatus,
    qbo_sync_status: qboSyncStatus,
    reconciliation_item_status: reconciliationItem?.status || null,
    pipeline_status: pipelineStatus,
    pipeline_status_key: pipelineStatus.key,
    pipeline_status_label: pipelineStatus.label,
    pipeline_exception_detail: pipelineStatus.exception_reason || null,
    status: pipelineStatus.key,
    details: {
      pipeline_status: pipelineStatus,
      pending: row.pending === true,
      reconciliation_item_status: reconciliationItem?.status || null,
      reconciliation_item_id: reconciliationItem?.id || null,
      qbo_lifecycle_status: qboSyncStatus,
    },
  };
}

function applyPipelineFilters(rows = [], opts = {}) {
  let filtered = rows;
  if (opts.plaid_account_id) {
    filtered = filtered.filter((row) => String(row.plaid_account_id || "") === String(opts.plaid_account_id));
  }
  if (opts.status && opts.status !== "all") {
    const statusSet = new Set(String(opts.status).split(",").map((item) => item.trim()).filter(Boolean));
    filtered = filtered.filter((row) => statusSet.has(row.pipeline_status_key));
  }
  const search = String(opts.search || "").trim().toLowerCase();
  if (search) {
    filtered = filtered.filter((row) =>
      [row.payee, row.merchant, row.description, row.bizzi_gl_account, row.bank_account]
        .some((value) => String(value || "").toLowerCase().includes(search))
    );
  }
  return filtered;
}

export async function loadMonthlyReconciliationPipeline(businessId, opts = {}) {
  const month = opts.month || (opts.date_from ? String(opts.date_from).slice(0, 7) : new Date().toISOString().slice(0, 7));
  const [start, end] = opts.date_from && opts.date_to
    ? [opts.date_from, opts.date_to]
    : monthBounds(month);
  const canonicalRows = await loadAuthoritativeMonthlyPlaidTransactions(businessId, start, end);
  const transactionIds = canonicalRows.map((row) => row.id).filter(Boolean);
  const catRows = transactionIds.length
    ? await safeRows(() =>
        supabase
          .from("transaction_categorizations")
          .select("transaction_id,status,suggested_qbo_account_id,suggested_qbo_account_name,suggested_canonical_account_key,final_qbo_account_id,final_qbo_account_name,final_canonical_account_key,qbo_txn_id,qbo_txn_type,posted_at,post_after,confidence,reason,post_error,meta,last_post_attempt_at")
          .eq("business_id", businessId)
          .in("transaction_id", transactionIds),
        "Monthly reconciliation categorizations"
      )
    : [];
  const catByTxn = new Map(catRows.map((row) => [row.transaction_id, row]));
  const plaidAccountLabels = await loadPlaidAccountLabels(
    businessId,
    canonicalRows.map((row) => row.plaid_account_id).filter(Boolean)
  );
  const reconciliationItemByTxn = await loadReconciliationItemsForMonthlyPipeline(businessId, month, transactionIds);
  const accountById = opts.accountById || new Map();
  const accountByName = opts.accountByName || new Map();
  const rows = canonicalRows
    .slice()
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
    .map((row) => buildMonthlyPipelineRow({
      row,
      cat: catByTxn.get(row.id) || {},
      plaidAccountLabels,
      accountById,
      accountByName,
      reconciliationItem: reconciliationItemByTxn.get(String(row.id)) || null,
    }));
  const totals = finalizePipelineTotals(summarizePipelineStatuses(rows));
  const filteredRows = applyPipelineFilters(rows, opts);
  const offset = Math.max(0, Number(opts.offset || 0));
  const limit = Number(opts.limit || 0);
  const pagedRows = limit > 0 ? filteredRows.slice(offset, offset + limit) : filteredRows;
  return {
    month,
    start,
    end,
    rows: pagedRows,
    all_rows: rows,
    total: filteredRows.length,
    totals,
    source_contract: {
      source_tables: ["bank_transactions", "transaction_categorizations", "reconciliation_items"],
      population_basis: "canonical active Plaid-backed bank_transactions for selected month",
      status_basis: "Unified reconciliation pipeline status over Books Review, QBO posting, and reconciliation_items authority",
    },
  };
}

export default {
  loadAuthoritativeMonthlyPlaidTransactions,
  loadMonthlyReconciliationPipeline,
  removeSupersededPendingPlaidRows,
  buildMonthlyPipelineRow,
};
