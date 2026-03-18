import { Router } from "express";
import { supabase } from "../../../services/supabaseAdmin.js";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { fetchChartOfAccounts } from "../../../services/bookkeeping/qboAccounts.js";
import { suggestQboAccountForPlaidAccount } from "../../../services/bookkeeping/accountMapping.js";

const router = Router();

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

router.get("/mapping-status", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    const nowIso = new Date().toISOString();
    const { data: catRows, error: catErr } = await supabase
      .from("transaction_categorizations")
      .select("transaction_id,status,post_after,qbo_txn_id")
      .eq("business_id", businessId)
      .in("status", ["approved", "auto_approved", "failed"])
      .not("post_after", "is", null)
      .neq("status", "posted")
      .is("qbo_txn_id", null);
    if (catErr) throw catErr;

    const filteredCats = (catRows || []).filter((row) => {
      if (!row?.post_after) return false;
      const postTs = Date.parse(row.post_after);
      if (Number.isNaN(postTs)) return false;
      return postTs <= Date.parse(nowIso) + 48 * 60 * 60 * 1000; // optional 48h window
    });
    const txnIds = filteredCats.map((c) => c.transaction_id).filter(Boolean);
    if (!txnIds.length) {
      return res.json({
        ok: true,
        needs_mapping: false,
        unmapped_plaid_account_ids: [],
        unmapped_account_count: 0,
        affected_txn_count: 0,
      });
    }

    const { data: bankRows, error: bankErr } = await supabase
      .from("bank_transactions")
      .select("id,plaid_account_id")
      .eq("business_id", businessId)
      .in("id", txnIds);
    if (bankErr) throw bankErr;

    const plaidIds = Array.from(
      new Set((bankRows || []).map((b) => b.plaid_account_id).filter(Boolean))
    );
    if (!plaidIds.length) {
      return res.json({
        ok: true,
        needs_mapping: false,
        unmapped_plaid_account_ids: [],
        unmapped_account_count: 0,
        affected_txn_count: 0,
      });
    }

    let { data: mappings, error: mapErr } = await supabase
      .from("plaid_qbo_account_mappings")
      .select("plaid_account_id,source")
      .eq("business_id", businessId)
      .in("plaid_account_id", plaidIds);
    if (mapErr) throw mapErr;

    const mappedIds = new Set((mappings || []).map((m) => m.plaid_account_id));
    const manualMappedIds = new Set(
      (mappings || [])
        .filter((m) => String(m?.source || "").toLowerCase() === "manual")
        .map((m) => m.plaid_account_id)
    );
    let unmappedIds = plaidIds.filter((id) => !mappedIds.has(id));

    if (unmappedIds.length) {
      const { data: plaidAccounts, error: acctErr } = await supabase
        .from("plaid_accounts")
        .select("plaid_account_id,name,official_name,mask,type,subtype")
        .eq("business_id", businessId)
        .in("plaid_account_id", unmappedIds);
      if (acctErr) throw acctErr;

      const qboAccounts = await fetchChartOfAccounts(businessId);
      const qboEligibleBank = (qboAccounts || []).filter(
        (acct) => normalizeType(acct?.type) === "Bank"
      );
      const qboEligibleCredit = (qboAccounts || []).filter(
        (acct) => normalizeType(acct?.type) === "CreditCard"
      );

      const postablePlaidIds = new Set();
      const autoRows = (plaidAccounts || [])
        .map((acct) => {
          const plaidRail = getPlaidPostingRail(acct?.type, acct?.subtype);
          if (!plaidRail) return null;
          postablePlaidIds.add(acct.plaid_account_id);
          if (manualMappedIds.has(acct.plaid_account_id)) return null;

          const eligibleQbo =
            plaidRail === "depository" ? qboEligibleBank : qboEligibleCredit;
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
        const { error: upsertErr } = await supabase
          .from("plaid_qbo_account_mappings")
          .upsert(autoRows, { onConflict: "business_id,plaid_account_id" });
        if (upsertErr) throw upsertErr;

        const { data: refreshed, error: refreshErr } = await supabase
          .from("plaid_qbo_account_mappings")
          .select("plaid_account_id")
          .eq("business_id", businessId)
          .in("plaid_account_id", unmappedIds);
        if (refreshErr) throw refreshErr;
        const refreshedIds = new Set((refreshed || []).map((m) => m.plaid_account_id));
        unmappedIds = unmappedIds.filter((id) => !refreshedIds.has(id));
      }
      unmappedIds = unmappedIds.filter((id) => postablePlaidIds.has(id));
    }

    const affectedTxnCount = (bankRows || []).filter((row) => unmappedIds.includes(row.plaid_account_id)).length;

    return res.json({
      ok: true,
      needs_mapping: unmappedIds.length > 0,
      unmapped_plaid_account_ids: unmappedIds,
      unmapped_account_count: unmappedIds.length,
      affected_txn_count: affectedTxnCount,
    });
  } catch (err) {
    console.error("[bookkeeping][mapping-status] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "mapping_status_fetch_failed", message: err?.message || "failed" });
  }
});

export default router;
