import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { suggestQboAccountForPlaidAccount } from "../../../services/bookkeeping/accountMapping.js";
import { applyActiveBookkeepingScope, getBookkeepingStartDate } from "../../../services/bookkeeping/bookkeepingScope.js";
import { isAdminViewRequest } from "../../_shared/tenantAuth.js";
import { assertTaxBusinessAccess } from "../../tax/taxRouteUtils.js";

const router = Router();
const POSTGREST_IN_BATCH_SIZE = 50;

function normalizeType(val = "") {
  const normalized = (val || "").replace(/[\s\-_]+/g, "").toLowerCase();
  if (normalized === "bank") return "Bank";
  if (normalized === "creditcard") return "CreditCard";
  return null;
}

function getPlaidPostingRail(type, subtype) {
  const t = String(type || "").trim().toLowerCase();
  const st = String(subtype || "").trim().toLowerCase();

  // Primary source: Plaid 'type'
  if (t === "depository") return "depository";
  if (t === "credit") return "credit";

  // Fallback: derive from subtype if type missing/odd
  if (["checking", "savings", "money market", "cd"].includes(st)) return "depository";
  if (st.includes("credit")) return "credit";

  return null;
}

function chunk(values = [], size = POSTGREST_IN_BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function emptyMappingStatus(extra = {}) {
  return {
    ok: true,
    needs_mapping: false,
    unmapped_plaid_account_ids: [],
    unmapped_account_count: 0,
    affected_txn_count: 0,
    ...extra,
  };
}

function wrapMappingDbError(operation, error) {
  if (!error) return error;
  const wrapped = new Error(`${operation}: ${error?.message || String(error)}`);
  wrapped.code = error?.code || operation;
  wrapped.status = error?.status || 500;
  wrapped.cause = error;
  return wrapped;
}

async function fetchChartOfAccountsForAutoMapping(businessId) {
  const mod = await import("../../../services/bookkeeping/qboAccounts.js");
  return mod.fetchChartOfAccounts(businessId);
}

async function fetchDuePostingCategorizationRows(db, businessId, nowIso) {
  const cutoffIso = new Date(Date.parse(nowIso) + 48 * 60 * 60 * 1000).toISOString();
  let query = db
    .from("transaction_categorizations")
    .select("transaction_id,status,post_after,qbo_txn_id")
    .eq("business_id", businessId)
    .in("status", ["approved", "auto_approved", "failed"])
    .not("post_after", "is", null)
    .neq("status", "posted")
    .is("qbo_txn_id", null);
  if (typeof query.lte === "function") query = query.lte("post_after", cutoffIso);
  const { data: catRows, error: catErr } = await query;
  if (catErr) throw wrapMappingDbError("mapping_status_categorizations_fetch_failed", catErr);

  return (catRows || []).filter((row) => {
    if (!row?.post_after || !row?.transaction_id) return false;
    const postTs = Date.parse(row.post_after);
    return !Number.isNaN(postTs) && postTs <= Date.parse(cutoffIso);
  });
}

async function fetchBankRowsForTransactions(db, businessId, txnIds = [], bookkeepingStartDate = null) {
  const rows = [];
  for (const ids of chunk(txnIds)) {
    const bankBaseQuery = db
      .from("bank_transactions")
      .select("id,plaid_account_id,date")
      .eq("business_id", businessId)
      .eq("is_archived", false)
      .in("id", ids);
    const { data, error } = await applyActiveBookkeepingScope(bankBaseQuery, bookkeepingStartDate);
    if (error) throw wrapMappingDbError("mapping_status_bank_transactions_fetch_failed", error);
    rows.push(...(data || []));
  }
  return rows;
}

async function fetchMappingsForPlaidIds(db, businessId, plaidIds = [], columns = "plaid_account_id,source") {
  const rows = [];
  for (const ids of chunk(plaidIds)) {
    const { data, error } = await db
      .from("plaid_qbo_account_mappings")
      .select(columns)
      .eq("business_id", businessId)
      .in("plaid_account_id", ids);
    if (error) throw wrapMappingDbError("mapping_status_account_mappings_fetch_failed", error);
    rows.push(...(data || []));
  }
  return rows;
}

async function fetchPlaidAccountsForIds(db, businessId, plaidIds = [], columns = "plaid_account_id,type,subtype") {
  const rows = [];
  for (const ids of chunk(plaidIds)) {
    const { data, error } = await db
      .from("plaid_accounts")
      .select(columns)
      .eq("business_id", businessId)
      .in("plaid_account_id", ids);
    if (error) throw wrapMappingDbError("mapping_status_plaid_accounts_fetch_failed", error);
    rows.push(...(data || []));
  }
  return rows;
}

async function upsertAutoMappings(db, rows = []) {
  for (const batch of chunk(rows)) {
    const { error } = await db
      .from("plaid_qbo_account_mappings")
      .upsert(batch, { onConflict: "business_id,plaid_account_id" });
    if (error) throw wrapMappingDbError("mapping_status_auto_mapping_upsert_failed", error);
  }
}

export async function fetchMappingStatus({
  db = supabase,
  businessId,
  bookkeepingStartDate = null,
  nowIso = new Date().toISOString(),
  allowAutoMap = true,
  adminViewCacheOnly = false,
}) {
  const catRows = await fetchDuePostingCategorizationRows(db, businessId, nowIso);
  const txnIds = catRows.map((c) => c.transaction_id).filter(Boolean);
  if (!txnIds.length) return emptyMappingStatus(adminViewCacheOnly ? { admin_view_cache_only: true } : {});

  const bankRows = await fetchBankRowsForTransactions(db, businessId, txnIds, bookkeepingStartDate);
  const plaidIds = Array.from(new Set((bankRows || []).map((b) => b.plaid_account_id).filter(Boolean)));
  if (!plaidIds.length) return emptyMappingStatus(adminViewCacheOnly ? { admin_view_cache_only: true } : {});

  let mappings = await fetchMappingsForPlaidIds(db, businessId, plaidIds, "plaid_account_id,source");
  const mappedIds = new Set((mappings || []).map((m) => m.plaid_account_id));
  const manualMappedIds = new Set(
    (mappings || [])
      .filter((m) => String(m?.source || "").toLowerCase() === "manual")
      .map((m) => m.plaid_account_id)
  );
  let unmappedIds = plaidIds.filter((id) => !mappedIds.has(id));

  if (unmappedIds.length && allowAutoMap) {
    try {
      const plaidAccounts = await fetchPlaidAccountsForIds(
        db,
        businessId,
        unmappedIds,
        "plaid_account_id,name,official_name,mask,type,subtype"
      );

      const qboAccounts = await fetchChartOfAccountsForAutoMapping(businessId);
      const qboEligibleBank = (qboAccounts || []).filter((acct) => normalizeType(acct?.type) === "Bank");
      const qboEligibleCredit = (qboAccounts || []).filter((acct) => normalizeType(acct?.type) === "CreditCard");

      const postablePlaidIds = new Set();
      const autoRows = (plaidAccounts || [])
        .map((acct) => {
          const plaidRail = getPlaidPostingRail(acct?.type, acct?.subtype);
          if (!plaidRail) return null;
          postablePlaidIds.add(acct.plaid_account_id);
          if (manualMappedIds.has(acct.plaid_account_id)) return null;

          const eligibleQbo = plaidRail === "depository" ? qboEligibleBank : qboEligibleCredit;
          const suggestion = suggestQboAccountForPlaidAccount(acct, eligibleQbo);
          if (!suggestion || !suggestion.qbo_account_id) return null;
          if (suggestion.confidence !== "high") return null;
          const normalizedType = normalizeType(suggestion.qbo_account_type);
          if (!normalizedType) return null;
          if (plaidRail === "depository" && normalizedType !== "Bank") return null;
          if (plaidRail === "credit" && normalizedType !== "CreditCard") return null;

          return {
            business_id: businessId,
            plaid_account_id: acct.plaid_account_id,
            qbo_account_id: String(suggestion.qbo_account_id),
            qbo_account_name: suggestion.qbo_account_name || null,
            qbo_account_type: normalizedType,
            source: "auto",
            confidence: suggestion.confidence,
          };
        })
        .filter(Boolean);

      if (autoRows.length) {
        await upsertAutoMappings(db, autoRows);
        mappings = await fetchMappingsForPlaidIds(db, businessId, unmappedIds, "plaid_account_id");
        const refreshedIds = new Set((mappings || []).map((m) => m.plaid_account_id));
        unmappedIds = unmappedIds.filter((id) => !refreshedIds.has(id));
      }
      unmappedIds = unmappedIds.filter((id) => postablePlaidIds.has(id));
    } catch (err) {
      console.warn("[bookkeeping][mapping-status] auto-mapping degraded", err?.message || err);
      const plaidAccounts = await fetchPlaidAccountsForIds(db, businessId, unmappedIds, "plaid_account_id,type,subtype");
      const postablePlaidIds = new Set(
        (plaidAccounts || [])
          .filter((acct) => Boolean(getPlaidPostingRail(acct?.type, acct?.subtype)))
          .map((acct) => acct.plaid_account_id)
      );
      unmappedIds = unmappedIds.filter((id) => postablePlaidIds.has(id));
    }
  } else if (unmappedIds.length) {
    const plaidAccounts = await fetchPlaidAccountsForIds(db, businessId, unmappedIds, "plaid_account_id,type,subtype");
    const postablePlaidIds = new Set(
      (plaidAccounts || [])
        .filter((acct) => Boolean(getPlaidPostingRail(acct?.type, acct?.subtype)))
        .map((acct) => acct.plaid_account_id)
    );
    unmappedIds = unmappedIds.filter((id) => postablePlaidIds.has(id));
  }

  const affectedTxnCount = (bankRows || []).filter((row) => unmappedIds.includes(row.plaid_account_id)).length;
  return {
    ok: true,
    needs_mapping: unmappedIds.length > 0,
    unmapped_plaid_account_ids: unmappedIds,
    unmapped_account_count: unmappedIds.length,
    affected_txn_count: affectedTxnCount,
    ...(adminViewCacheOnly ? { admin_view_cache_only: true } : {}),
  };
}

export async function fetchAdminViewPersistedMappingStatus(options = {}) {
  return fetchMappingStatus({ ...options, allowAutoMap: false, adminViewCacheOnly: true });
}

router.get("/mapping-status", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const nowIso = new Date().toISOString();
    const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
    if (isAdminViewRequest(req)) {
      return res.json(await fetchAdminViewPersistedMappingStatus({ businessId, bookkeepingStartDate, nowIso }));
    }
    return res.json(await fetchMappingStatus({ businessId, bookkeepingStartDate, nowIso }));
  } catch (err) {
    console.error("[bookkeeping][mapping-status] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "mapping_status_fetch_failed", message: err?.message || "failed" });
  }
});

export default router;
