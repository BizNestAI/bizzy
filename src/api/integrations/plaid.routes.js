import { Router } from "express";
import { runPlaidSyncForBusiness } from "../../services/plaid/plaidSyncService.js";
import { supabase } from "../../services/supabaseAdmin.js";
import { requireAuth } from "../gpt/middlewares/requireAuth.js";
import { getPlaidClient } from "../../services/plaid/plaidClient.js";
import { runReconciliationOnceForBusiness } from "../../cron/reconciliation.cron.js";
import {
  createLinkToken,
  exchangePublicToken,
  getPlaidStatus,
} from "../../services/plaid/plaidIntegrationService.js";

const router = Router();

function readBusinessId(req) {
  const b = req.body || {};
  const q = req.query || {};
  const h = req.headers || {};
  return (
    b.business_id ||
    b.businessId ||
    q.business_id ||
    q.businessId ||
    h["x-business-id"] ||
    req.user?.business_id ||
    null
  );
}

function ensureBusinessId(req, res) {
  const businessId = readBusinessId(req);
  if (!businessId) {
    res.status(400).json({ ok: false, error: "missing_business_id" });
    return null;
  }
  return businessId;
}

function allowDeleteData(req) {
  const requested = req.body?.deleteData === true;
  if (!requested) return false;
  const adminHeader = String(req.headers?.["x-bizzi-admin"] || "").toLowerCase() === "true";
  const adminKey = process.env.ADMIN_API_KEY && req.headers?.["x-admin-key"] === process.env.ADMIN_API_KEY;
  const flagEnabled = process.env.PLAID_DELETE_DATA_ENABLED === "true";
  return adminHeader || adminKey || flagEnabled;
}

router.get("/status", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    const status = await getPlaidStatus({ businessId });
    return res.json(status);
  } catch (err) {
    console.error("[plaid] status failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "plaid_status_failed" });
  }
});

router.post("/link-token", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const userId = req.user?.id || req.user?.user_id || null;
    const linkToken = await createLinkToken({ businessId, userId });
    if (!linkToken) throw new Error("link_token_missing");
    return res.json({ ok: true, link_token: linkToken });
  } catch (err) {
    console.error("[plaid] link token failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "plaid_link_token_failed" });
  }
});

router.post("/exchange", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const publicToken = req.body?.public_token;
  if (!publicToken) {
    return res.status(400).json({ ok: false, error: "missing_public_token", message: "public_token is required" });
  }
  try {
    const metadata = req.body?.metadata || null;
    const result = await exchangePublicToken({
      businessId,
      userId: req.user?.id || null,
      publicToken,
      metadata,
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    const plaidErr = err?.response?.data || err?.data || null;
    console.error("[plaid][exchange] failed", {
      business_id: businessId,
      has_public_token: !!publicToken,
      plaid: plaidErr,
      message: err?.message,
    });
    return res.status(500).json({
      ok: false,
      error: "plaid_exchange_failed",
      message:
        plaidErr?.error_message ||
        plaidErr?.display_message ||
        err?.message ||
        "exchange_failed",
      plaid: plaidErr || null,
    });
  }
});

router.post("/sync", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await runPlaidSyncForBusiness(businessId, { force: true });
    // Best-effort reconciliation refresh after sync; throttled in helper.
    runReconciliationOnceForBusiness(businessId, { force: false, preferQboBalance: false }).catch(() => {});
    return res.json(result);
  } catch (err) {
    const plaid = err?.response?.data || err?.data || null;
    const supa = err?.supabase || err?.cause || null;
    console.error("[plaid][sync] failed", {
      business_id: businessId,
      message: err?.message,
      plaid,
      supabase: supa,
      stack: err?.stack,
    });
    return res.status(500).json({
      ok: false,
      error: "plaid_sync_failed",
      message:
        plaid?.error_message ||
        plaid?.display_message ||
        supa?.message ||
        err?.message ||
        "sync_failed",
      plaid: plaid || null,
      supabase: supa || null,
    });
  }
});

router.post("/disconnect-item", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const plaidItemId = req.body?.plaid_item_id || req.body?.item_id || null;
  if (!plaidItemId) {
    return res.status(400).json({ ok: false, error: "missing_plaid_item_id" });
  }

  try {
    const plaid = getPlaidClient();
    const { data: item, error: itemErr } = await supabase
      .from("plaid_items")
      .select("plaid_item_id,plaid_access_token")
      .eq("business_id", businessId)
      .eq("plaid_item_id", plaidItemId)
      .maybeSingle();
    if (itemErr) throw itemErr;
    if (!item?.plaid_item_id) {
      return res.status(404).json({ ok: false, error: "plaid_item_not_found" });
    }

    if (plaid && item?.plaid_access_token) {
      try {
        await plaid.itemRemove({ access_token: item.plaid_access_token });
      } catch (e) {
        console.warn("[plaid][disconnect-item] item_remove failed", e?.message || e);
      }
    }

    const destructive = allowDeleteData(req);
    if (destructive) {
      const { data: accounts, error: acctErr } = await supabase
        .from("plaid_accounts")
        .select("plaid_account_id")
        .eq("business_id", businessId)
        .eq("plaid_item_id", plaidItemId);
      if (acctErr) throw acctErr;

      const accountIds = (accounts || []).map((a) => a.plaid_account_id).filter(Boolean);
      let removedTransactions = 0;
      if (accountIds.length) {
        const { data: txnRows, error: txnErr } = await supabase
          .from("bank_transactions")
          .select("id")
          .eq("business_id", businessId)
          .in("plaid_account_id", accountIds);
        if (txnErr) throw txnErr;
        const txnIds = (txnRows || []).map((t) => t.id).filter(Boolean);
        if (txnIds.length) {
          await supabase
            .from("transaction_categorizations")
            .delete()
            .eq("business_id", businessId)
            .in("transaction_id", txnIds);
        }
        const { data: deletedTxns } = await supabase
          .from("bank_transactions")
          .delete()
          .eq("business_id", businessId)
          .in("plaid_account_id", accountIds)
          .select("id");
        removedTransactions = Array.isArray(deletedTxns) ? deletedTxns.length : 0;
        await supabase
          .from("plaid_accounts")
          .delete()
          .eq("business_id", businessId)
          .eq("plaid_item_id", plaidItemId);
      }

      await supabase
        .from("bank_sync_runs")
        .delete()
        .eq("business_id", businessId)
        .eq("plaid_item_id", plaidItemId);
      await supabase
        .from("plaid_items")
        .delete()
        .eq("business_id", businessId)
        .eq("plaid_item_id", plaidItemId);

      return res.json({
        ok: true,
        plaid_item_id: plaidItemId,
        removed_accounts: accountIds.length,
        removed_transactions: removedTransactions,
        delete_data: true,
      });
    }

    const nowIso = new Date().toISOString();
    await supabase
      .from("plaid_items")
      .update({
        is_active: false,
        status: "disconnected",
        disconnected_at: nowIso,
        plaid_access_token: null,
        cursor: null,
        updated_at: nowIso,
      })
      .eq("business_id", businessId)
      .eq("plaid_item_id", plaidItemId);
    await supabase
      .from("plaid_accounts")
      .update({
        is_active: false,
        disconnected_at: nowIso,
        updated_at: nowIso,
      })
      .eq("business_id", businessId)
      .eq("plaid_item_id", plaidItemId);

    return res.json({
      ok: true,
      plaid_item_id: plaidItemId,
      disconnected_at: nowIso,
      delete_data: false,
    });
  } catch (err) {
    console.error("[plaid][disconnect-item] failed", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "plaid_disconnect_item_failed",
      message: err?.message || "disconnect_item_failed",
    });
  }
});

router.post("/disconnect", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const plaid = getPlaidClient();

  try {
    const { data: items, error: itemsErr } = await supabase
      .from("plaid_items")
      .select("plaid_item_id,plaid_access_token,id")
      .eq("business_id", businessId);
    if (itemsErr) throw itemsErr;

    const errors = [];
    let removedItems = 0;

    for (const item of items || []) {
      if (plaid && item?.plaid_access_token) {
        try {
          await plaid.itemRemove({ access_token: item.plaid_access_token });
          removedItems += 1;
        } catch (e) {
          errors.push({
            item_id: item.plaid_item_id,
            message: e?.response?.data?.error_message || e?.message || "item_remove_failed",
          });
        }
      } else {
        removedItems += 1; // count locally removed even if we skip itemRemove
      }
    }

    const destructive = allowDeleteData(req);
    if (destructive) {
      // Delete in dependency-safe order
      await supabase.from("transaction_categorizations").delete().eq("business_id", businessId);
      const { data: txnDeleted } = await supabase
        .from("bank_transactions")
        .delete()
        .eq("business_id", businessId)
        .select("id");
      await supabase.from("plaid_accounts").delete().eq("business_id", businessId);
      await supabase.from("bank_sync_runs").delete().eq("business_id", businessId);
      const { data: itemsDeleted } = await supabase
        .from("plaid_items")
        .delete()
        .eq("business_id", businessId)
        .select("plaid_item_id");

      const removed_transactions = Array.isArray(txnDeleted) ? txnDeleted.length : 0;
      const removed_items =
        removedItems || (Array.isArray(itemsDeleted) ? itemsDeleted.length : 0);

      console.info("[plaid][disconnect]", {
        business_id: businessId,
        items_found: (items || []).length,
        removed_items,
        removed_transactions,
      });

      return res.json({
        ok: true,
        removed_items,
        removed_transactions,
        errors: errors.length ? errors : undefined,
        delete_data: true,
      });
    }

    const nowIso = new Date().toISOString();
    await supabase
      .from("plaid_items")
      .update({
        is_active: false,
        status: "disconnected",
        disconnected_at: nowIso,
        plaid_access_token: null,
        cursor: null,
        updated_at: nowIso,
      })
      .eq("business_id", businessId);
    await supabase
      .from("plaid_accounts")
      .update({
        is_active: false,
        disconnected_at: nowIso,
        updated_at: nowIso,
      })
      .eq("business_id", businessId);

    console.info("[plaid][disconnect]", {
      business_id: businessId,
      items_found: (items || []).length,
      disconnected_items: (items || []).length,
    });

    return res.json({
      ok: true,
      disconnected_items: (items || []).length,
      errors: errors.length ? errors : undefined,
      delete_data: false,
    });
  } catch (err) {
    console.error("[plaid][disconnect] failed", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "plaid_disconnect_failed",
      message: err?.message || "disconnect_failed",
    });
  }
});

export default router;
