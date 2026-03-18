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

  if (t === "depository") return "depository";
  if (t === "credit") return "credit";

  // fallback for common subtypes
  if (["checking", "savings", "money market", "cd"].includes(st)) return "depository";
  if (st.includes("credit")) return "credit";

  return null;
}

function mapRailToPostingCategory(rail) {
  if (rail === "depository") return "Bank";
  if (rail === "credit") return "CreditCard";
  return "NotUsed";
}

router.get("/account-mappings", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    const { data: plaidAccounts, error: acctErr } = await supabase
      .from("plaid_accounts")
      .select("plaid_account_id,name,official_name,mask,type,subtype,is_active")
      .eq("business_id", businessId);
    if (acctErr) throw acctErr;

    const { data: mappings, error: mapErr } = await supabase
      .from("plaid_qbo_account_mappings")
      .select("plaid_account_id,qbo_account_id,qbo_account_name,qbo_account_type")
      .eq("business_id", businessId);
    if (mapErr) throw mapErr;
    const mappingByPlaid = (mappings || []).reduce((acc, row) => {
      acc[row.plaid_account_id] = row;
      return acc;
    }, {});

    const qboAccounts = await fetchChartOfAccounts(businessId);

    const accounts = (plaidAccounts || []).map((acct) => {
      const mapping = mappingByPlaid[acct.plaid_account_id] || null;
      const rail = getPlaidPostingRail(acct.type, acct.subtype);
      const postingCategory = mapRailToPostingCategory(rail);
      const requiresMapping = postingCategory !== "NotUsed";
      const qboOptionsHint =
        postingCategory === "NotUsed" ? null : { type_needed: postingCategory };
      const eligibleQbo =
        postingCategory === "Bank"
          ? qboAccounts.filter((a) => normalizeType(a?.type) === "Bank")
          : postingCategory === "CreditCard"
          ? qboAccounts.filter((a) => normalizeType(a?.type) === "CreditCard")
          : [];
      const suggestedRaw =
        !mapping && requiresMapping
          ? suggestQboAccountForPlaidAccount(acct, eligibleQbo)
          : null;
      const suggested =
        !mapping &&
        requiresMapping &&
        suggestedRaw?.confidence === "high"
          ? suggestedRaw
          : null;
      return {
        plaid_account_id: acct.plaid_account_id,
        plaid_name: acct.name || acct.official_name || null,
        plaid_type: acct.type || null,
        plaid_subtype: acct.subtype || null,
        mask: acct.mask || null,
        is_active: acct.is_active,
        posting_category: postingCategory,
        requires_mapping: requiresMapping,
        mapped: Boolean(mapping?.qbo_account_id),
        qbo_account_id: mapping?.qbo_account_id || null,
        qbo_account_name: mapping?.qbo_account_name || null,
        qbo_account_type: mapping?.qbo_account_type || null,
        suggested: suggested || null,
        qbo_options_hint: qboOptionsHint,
      };
    });

    return res.json({ ok: true, accounts });
  } catch (err) {
    console.error("[bookkeeping][account-mappings] fetch failed", err?.message || err);
    return res
      .status(500)
      .json({ ok: false, error: "account_mappings_fetch_failed", message: err?.message || "failed" });
  }
});

router.post("/account-mappings", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  const body = req.body || {};
  const plaidAccountId = body.plaid_account_id || body.plaidAccountId || null;
  const qboAccountIdRaw = body.qbo_account_id ?? body.qboAccountId ?? null;
  const qboAccountName = body.qbo_account_name ?? body.qboAccountName ?? null;
  const qboAccountTypeRaw = body.qbo_account_type ?? body.qboAccountType ?? null;

  if (!plaidAccountId) {
    return res.status(400).json({ ok: false, error: "missing_plaid_account_id" });
  }
  const { data: plaidAccount, error: plaidErr } = await supabase
    .from("plaid_accounts")
    .select("plaid_account_id,type,subtype,is_active")
    .eq("business_id", businessId)
    .eq("plaid_account_id", plaidAccountId)
    .maybeSingle();
  if (plaidErr) {
    return res.status(500).json({ ok: false, error: "account_mapping_upsert_failed", message: plaidErr?.message || "failed" });
  }
  if (!plaidAccount) {
    return res.status(400).json({ ok: false, error: "invalid_plaid_account" });
  }

  const isClearRequest =
    qboAccountIdRaw === "__none__" ||
    qboAccountIdRaw === "" ||
    qboAccountIdRaw === null;

  if (isClearRequest) {
    try {
      const { error } = await supabase
        .from("plaid_qbo_account_mappings")
        .delete()
        .eq("business_id", businessId)
        .eq("plaid_account_id", plaidAccountId);
      if (error) throw error;

      return res.json({
        ok: true,
        mapping: null,
        plaid_account_id: plaidAccountId,
      });
    } catch (err) {
      console.error("[bookkeeping][account-mappings] clear failed", err?.message || err);
      return res
        .status(500)
        .json({ ok: false, error: "account_mapping_clear_failed", message: err?.message || "failed" });
    }
  }

  const qboAccounts = await fetchChartOfAccounts(businessId);
  const target = (qboAccounts || []).find((a) => String(a.id) === String(qboAccountIdRaw));
  if (!target) {
    return res.status(400).json({ ok: false, error: "invalid_qbo_account" });
  }

  const normalizedType = normalizeType(qboAccountTypeRaw || target.type);
  if (!normalizedType) {
    return res.status(400).json({ ok: false, error: "invalid_qbo_account_type" });
  }
  if (normalizedType !== "Bank" && normalizedType !== "CreditCard") {
    return res.status(400).json({ ok: false, error: "invalid_qbo_account_type" });
  }

  try {
    const row = {
      business_id: businessId,
      plaid_account_id: plaidAccountId,
      qbo_account_id: String(target.id),
      qbo_account_name: qboAccountName || target.name || null,
      qbo_account_type: normalizedType,
      source: "manual",
      confidence: "high",
    };

    const { error } = await supabase
      .from("plaid_qbo_account_mappings")
      .upsert(row, { onConflict: "business_id,plaid_account_id" });
    if (error) throw error;

    return res.json({
      ok: true,
      mapping: {
        plaid_account_id: plaidAccountId,
        qbo_account_id: String(target.id),
        qbo_account_name: row.qbo_account_name,
        qbo_account_type: row.qbo_account_type,
      },
    });
  } catch (err) {
    console.error("[bookkeeping][account-mappings] upsert failed", err?.message || err);
    return res
      .status(500)
      .json({ ok: false, error: "account_mapping_upsert_failed", message: err?.message || "failed" });
  }
});

export default router;
