/* global process */
import crypto from "crypto";
import { Router } from "express";
import { recoverExpiredPlaidSyncLease, runPlaidSyncForBusiness } from "../../services/plaid/plaidSyncService.js";
import { supabase } from "../../services/supabaseAdmin.js";
import { requireAuth } from "../gpt/middlewares/requireAuth.js";
import { getPlaidClient, plaidEnvName } from "../../services/plaid/plaidClient.js";
import { runReconciliationOnceForBusiness } from "../../cron/reconciliation.cron.js";
import {
  redactPlaidSecrets,
  safePlaidClientMessage,
  safePlaidErrorPayload,
} from "../../services/plaid/plaidSecurity.js";
import { resolveStoredPlaidAccessToken } from "../../services/plaid/plaidTokenCrypto.js";
import {
  createLinkToken,
  createUpdateLinkToken,
  exchangePublicToken,
  getPlaidStatus,
  inspectUpdatedItemAccounts,
} from "../../services/plaid/plaidIntegrationService.js";
import { admitReplacementRecoveryBatch, bootstrapReplacementRecoveryState, confirmReplacementAccountLineage, createReplacementRecoveryPreview, getReplacementRecoveryStatus, listReplacementRecoveryRows, rebuildReplacementRecoveryPreview, releaseReplacementRecoveryHold, selectReplacementRecoveryAccount } from "../../services/plaid/plaidReplacementRecoveryService.js";
import { createRateLimiter } from "../_shared/rateLimit.js";
import { ENTITLEMENT_CAPABILITIES, requireBusinessRole, requireEntitlementCapability } from "../_shared/entitlementAuth.js";
import { consumePlaidLinkState, createPlaidLinkState } from "../../services/plaid/plaidLinkStateService.js";

const router = Router();
const primaryOwner = requireBusinessRole(["owner"]);
const integrationAdmin = requireEntitlementCapability(ENTITLEMENT_CAPABILITIES.INTEGRATION_ADMIN);
const providerSync = requireEntitlementCapability(ENTITLEMENT_CAPABILITIES.PROVIDER_SYNC);
const providerDisconnect = requireEntitlementCapability(ENTITLEMENT_CAPABILITIES.PROVIDER_DISCONNECT);
const plaidMutationRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.PLAID_ROUTE_RATE_LIMIT_PER_MINUTE || 20),
  code: "plaid_rate_limited",
  message: "Too many Plaid requests. Try again shortly.",
});

function readBusinessId(req) {
  return (
    req.business?.id ||
    req.auth?.businessId ||
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
  const adminKey = process.env.ADMIN_API_KEY && req.headers?.["x-admin-key"] === process.env.ADMIN_API_KEY;
  if (adminKey) return true;
  return process.env.NODE_ENV !== "production" && process.env.PLAID_DELETE_DATA_ENABLED === "true";
}

router.get("/status", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    const status = await getPlaidStatus({ businessId });
    return res.json(status);
  } catch (err) {
    console.error("[plaid] status failed", redactPlaidSecrets(err?.message || err));
    return res.status(500).json({ ok: false, error: "plaid_status_failed" });
  }
});

router.post("/link-token", requireAuth, plaidMutationRateLimit, primaryOwner, integrationAdmin, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const userId = req.auth?.userId || req.user?.id || req.user?.user_id || null;
    const linkSession = await createPlaidLinkState({ businessId, userId, db: supabase });
    const linkToken = await createLinkToken({ businessId, userId });
    if (!linkToken) throw new Error("link_token_missing");
    return res.json({ ok: true, link_token: linkToken, link_session: linkSession });
  } catch (err) {
    console.error("[plaid] link token failed", redactPlaidSecrets(err?.message || err));
    return res.status(500).json({ ok: false, error: "plaid_link_token_failed" });
  }
});

router.post("/items/:plaidItemId/update-link-token", requireAuth, plaidMutationRateLimit, primaryOwner, integrationAdmin, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await createUpdateLinkToken({
      businessId,
      userId: req.auth?.userId || req.user?.id || null,
      plaidItemId: req.params.plaidItemId,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    const code = error?.message === "plaid_item_not_found" ? "plaid_item_not_found" : "plaid_update_link_token_failed";
    return res.status(code === "plaid_item_not_found" ? 404 : 500).json({ ok: false, error: code, message: safePlaidClientMessage(error, code) });
  }
});

router.post("/items/:plaidItemId/repair-complete", requireAuth, plaidMutationRateLimit, primaryOwner, integrationAdmin, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await inspectUpdatedItemAccounts({ businessId, plaidItemId: req.params.plaidItemId });
    return res.json({ ok: true, ...result });
  } catch (error) {
    const code = error?.code || error?.message || "plaid_repair_inspection_failed";
    return res.status(code === "plaid_item_not_found" ? 404 : 500).json({ ok: false, error: code,
      message: code === "plaid_recovery_state_persistence_failed"
        ? "The connection was repaired, but durable replacement recovery could not be saved. Verify the recovery migration before continuing."
        : "The repaired connection could not be inspected safely." });
  }
});

router.post("/items/:plaidItemId/recovery-bootstrap", requireAuth, plaidMutationRateLimit, primaryOwner, integrationAdmin, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await bootstrapReplacementRecoveryState({ businessId, plaidItemId: req.params.plaidItemId,
      actorUserId: req.auth?.userId || req.user?.id || null });
    return res.json({ ok: true, plaid_item_id: req.params.plaidItemId, orchestration: result });
  } catch (error) {
    return res.status(error?.status || 500).json({ ok: false, error: error?.code || "plaid_recovery_bootstrap_failed", message: error?.message || "Recovery state could not be reconstructed." });
  }
});

router.post("/items/:plaidItemId/recovery-account", requireAuth, plaidMutationRateLimit, primaryOwner, integrationAdmin, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await selectReplacementRecoveryAccount({ businessId, plaidItemId: req.params.plaidItemId,
      plaidAccountId: req.body?.plaid_account_id, actorUserId: req.auth?.userId || req.user?.id || null });
    return res.json({ ok: true, plaid_item_id: req.params.plaidItemId, orchestration: result });
  } catch (error) {
    return res.status(error?.status || 500).json({ ok: false, error: error?.code || "replacement_account_selection_failed", message: error?.message || "The replacement account could not be selected." });
  }
});

router.post("/items/:plaidItemId/recovery-preview", requireAuth, plaidMutationRateLimit, primaryOwner, integrationAdmin, providerSync, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const cutoffDate = String(req.body?.cutoff_date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDate)) return res.status(400).json({ ok: false, error: "invalid_recovery_cutoff_date" });
  try {
    const result = await createReplacementRecoveryPreview({
      businessId, plaidItemId: req.params.plaidItemId, cutoffDate,
      actorUserId: req.auth?.userId || req.user?.id || null,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(error?.status || 500).json({ ok: false, error: error?.code || "plaid_recovery_preview_failed", message: "The recovery preview could not be staged. No transactions were imported and the cursor was not advanced." });
  }
});

router.get("/items/:plaidItemId/recovery-status", requireAuth, primaryOwner, integrationAdmin, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    return res.json({ ok: true, ...(await getReplacementRecoveryStatus({ businessId, plaidItemId: req.params.plaidItemId })) });
  } catch (error) {
    return res.status(error?.status || 500).json({ ok: false, error: error?.code || error?.message || "plaid_recovery_status_failed", message: "Recovery status could not be loaded. Try again." });
  }
});

router.post("/items/:plaidItemId/confirm-lineage", requireAuth, plaidMutationRateLimit, primaryOwner, integrationAdmin, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await confirmReplacementAccountLineage({
      businessId, plaidItemId: req.params.plaidItemId,
      candidateId: req.body?.candidate_id, priorPlaidAccountId: req.body?.prior_plaid_account_id,
      actorUserId: req.auth?.userId || req.user?.id || null,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(error?.status || 500).json({ ok: false, error: error?.code || "lineage_confirmation_failed", message: error?.message || "Account lineage could not be confirmed." });
  }
});

router.get("/items/:plaidItemId/recovery-batches/:batchId/rows", requireAuth, primaryOwner, integrationAdmin, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const requestId = String(req.get("x-request-id") || crypto.randomUUID());
  res.set("x-request-id", requestId);
  try {
    return res.json({ ok: true, request_id: requestId, ...(await listReplacementRecoveryRows({ businessId, plaidItemId: req.params.plaidItemId, batchId: req.params.batchId,
      page: req.query.page, pageSize: req.query.page_size, search: req.query.search, dateFrom: req.query.date_from, dateTo: req.query.date_to, sort: req.query.sort })) });
  } catch (error) {
    console.warn("[plaid-recovery] row review failed", { request_id: requestId, business_id: businessId, plaid_item_id: req.params.plaidItemId,
      batch_id: req.params.batchId, code: error?.code || "recovery_rows_failed", details: error?.details || null });
    return res.status(error?.status || 500).json({ ok: false, request_id: requestId, error: error?.code || "recovery_rows_failed",
      message: error?.message || "Recovery transactions could not be loaded.", details: error?.details || undefined });
  }
});

router.post("/items/:plaidItemId/recovery-batches/:batchId/rebuild", requireAuth, plaidMutationRateLimit, primaryOwner, integrationAdmin, providerSync, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const requestId = String(req.get("x-request-id") || crypto.randomUUID());
  res.set("x-request-id", requestId);
  try {
    console.info("[plaid-recovery] controlled rebuild requested", { request_id: requestId, business_id: businessId,
      plaid_item_id: req.params.plaidItemId, batch_id: req.params.batchId });
    const result = await rebuildReplacementRecoveryPreview({
      businessId,
      plaidItemId: req.params.plaidItemId,
      batchId: req.params.batchId,
      actorUserId: req.auth?.userId || req.user?.id || null,
      idempotencyKey: String(req.body?.idempotency_key || ""),
    });
    console.info("[plaid-recovery] controlled rebuild completed", { request_id: requestId, business_id: businessId,
      plaid_item_id: req.params.plaidItemId, source_batch_id: req.params.batchId, batch_id: result?.batch_id,
      status: result?.status, eligible_count: result?.summary?.new_after_cutoff });
    return res.status(result?.processing ? 202 : 200).json({ ok: true, request_id: requestId, ...result });
  } catch (error) {
    console.warn("[plaid-recovery] controlled rebuild failed", { request_id: requestId, business_id: businessId,
      plaid_item_id: req.params.plaidItemId, batch_id: req.params.batchId, code: error?.code || "recovery_rebuild_failed" });
    return res.status(error?.status || 500).json({ ok: false, request_id: requestId,
      error: error?.code || "recovery_rebuild_failed",
      message: error?.message || "The recovery preview could not be rebuilt. Nothing was imported and the cursor was preserved." });
  }
});

router.post("/items/:plaidItemId/recovery-batches/:batchId/admit", requireAuth, plaidMutationRateLimit, primaryOwner, integrationAdmin, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await admitReplacementRecoveryBatch({ businessId, plaidItemId: req.params.plaidItemId, batchId: req.params.batchId,
      selectedRowIds: req.body?.selected_row_ids, actorUserId: req.auth?.userId || req.user?.id || null });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(error?.status || 500).json({ ok: false, error: error?.code || "recovery_admission_failed", message: error?.message || "Recovery transactions could not be admitted." });
  }
});

router.post("/items/:plaidItemId/recover-expired-lease", requireAuth, plaidMutationRateLimit, primaryOwner, integrationAdmin, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await recoverExpiredPlaidSyncLease({ businessId, plaidItemId: req.params.plaidItemId, actorUserId: req.auth?.userId || req.user?.id || null });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(error?.status || 500).json({ ok: false, error: error?.message || "plaid_sync_lease_recovery_failed", message: error?.message === "plaid_sync_lease_active" ? "A live synchronization worker still owns this connection." : "The expired synchronization lease could not be recovered." });
  }
});

router.post("/recovery-batches/:batchId/release-posting-hold", requireAuth, primaryOwner, integrationAdmin, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await releaseReplacementRecoveryHold({ businessId, batchId: req.params.batchId, actorUserId: req.auth?.userId || req.user?.id || null });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(error?.status || 500).json({ ok: false, error: error?.code || "plaid_recovery_hold_release_failed", message: error?.message || "The posting hold could not be released." });
  }
});

router.post("/exchange", requireAuth, plaidMutationRateLimit, primaryOwner, integrationAdmin, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const publicToken = req.body?.public_token;
  const linkSession = req.body?.link_session;
  if (!publicToken) {
    return res.status(400).json({ ok: false, error: "missing_public_token", message: "public_token is required" });
  }
  try {
    await consumePlaidLinkState({
      state: linkSession,
      businessId,
      userId: req.auth?.userId || req.user?.id || null,
      db: supabase,
    });
    const metadata = req.body?.metadata || null;
    const result = await exchangePublicToken({
      businessId,
      userId: req.auth?.userId || req.user?.id || null,
      publicToken,
      metadata,
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[plaid][exchange] failed", {
      business_id: businessId,
      has_public_token: !!publicToken,
      plaid: redactPlaidSecrets(safePlaidErrorPayload(err)),
      message: err?.message,
    });
    return res.status(500).json({
      ok: false,
      error: "plaid_exchange_failed",
      message: safePlaidClientMessage(err, "exchange_failed"),
    });
  }
});

router.post("/sync", requireAuth, plaidMutationRateLimit, providerSync, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await runPlaidSyncForBusiness(businessId, { force: true });
    // Best-effort ledger refresh after Plaid sync so newly imported source
    // transactions appear in the monthly reconciliation audit immediately.
    runReconciliationOnceForBusiness(businessId, { force: true, preferQboBalance: false }).catch(() => {});
    return res.json(result);
  } catch (err) {
    const supa = err?.supabase || err?.cause || null;
    console.error("[plaid][sync] failed", {
      business_id: businessId,
      message: err?.message,
      plaid: redactPlaidSecrets(safePlaidErrorPayload(err)),
      supabase: redactPlaidSecrets(supa?.message || supa || null),
    });
    return res.status(500).json({
      ok: false,
      error: "plaid_sync_failed",
      message: safePlaidClientMessage(err, supa?.message || "sync_failed"),
    });
  }
});

router.post("/disconnect-item", requireAuth, primaryOwner, providerDisconnect, async (req, res) => {
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
      .eq("plaid_env", plaidEnvName)
      .eq("plaid_item_id", plaidItemId)
      .maybeSingle();
    if (itemErr) throw itemErr;
    if (!item?.plaid_item_id) {
      return res.status(404).json({ ok: false, error: "plaid_item_not_found" });
    }

    if (plaid && item?.plaid_access_token) {
      try {
        const accessToken = await resolveStoredPlaidAccessToken({
          storedToken: item.plaid_access_token,
          persistEncrypted: async (encrypted) => {
            await supabase
              .from("plaid_items")
              .update({ plaid_access_token: encrypted, updated_at: new Date().toISOString() })
              .eq("business_id", businessId)
              .eq("plaid_env", plaidEnvName)
              .eq("plaid_item_id", plaidItemId);
          },
        });
        await plaid.itemRemove({ access_token: accessToken });
      } catch (e) {
        console.warn("[plaid][disconnect-item] item_remove failed", redactPlaidSecrets(e?.message || e));
      }
    }

    const destructive = allowDeleteData(req);
    if (destructive) {
      const { data: accounts, error: acctErr } = await supabase
        .from("plaid_accounts")
        .select("plaid_account_id")
        .eq("business_id", businessId)
        .eq("plaid_env", plaidEnvName)
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
          .eq("plaid_env", plaidEnvName)
          .eq("plaid_item_id", plaidItemId);
      }

      await supabase
        .from("bank_sync_runs")
        .delete()
        .eq("business_id", businessId)
        .eq("plaid_env", plaidEnvName)
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
      .eq("plaid_env", plaidEnvName)
      .eq("plaid_item_id", plaidItemId);
    await supabase
      .from("plaid_accounts")
      .update({
        is_active: false,
        disconnected_at: nowIso,
        updated_at: nowIso,
      })
      .eq("business_id", businessId)
      .eq("plaid_env", plaidEnvName)
      .eq("plaid_item_id", plaidItemId);

    return res.json({
      ok: true,
      plaid_item_id: plaidItemId,
      disconnected_at: nowIso,
      delete_data: false,
    });
  } catch (err) {
    console.error("[plaid][disconnect-item] failed", redactPlaidSecrets(err?.message || err));
    return res.status(500).json({
      ok: false,
      error: "plaid_disconnect_item_failed",
      message: "disconnect_item_failed",
    });
  }
});

router.post("/disconnect", requireAuth, primaryOwner, providerDisconnect, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const plaid = getPlaidClient();

  try {
    const { data: items, error: itemsErr } = await supabase
      .from("plaid_items")
      .select("plaid_item_id,plaid_access_token,id")
      .eq("business_id", businessId)
      .eq("plaid_env", plaidEnvName);
    if (itemsErr) throw itemsErr;

    const errors = [];
    let removedItems = 0;

    for (const item of items || []) {
      if (plaid && item?.plaid_access_token) {
        try {
          const accessToken = await resolveStoredPlaidAccessToken({
            storedToken: item.plaid_access_token,
            persistEncrypted: async (encrypted) => {
              await supabase
                .from("plaid_items")
                .update({ plaid_access_token: encrypted, updated_at: new Date().toISOString() })
                .eq("business_id", businessId)
                .eq("plaid_env", plaidEnvName)
                .eq("plaid_item_id", item.plaid_item_id);
            },
          });
          await plaid.itemRemove({ access_token: accessToken });
          removedItems += 1;
        } catch (e) {
          errors.push({
            item_id: item.plaid_item_id,
            message: safePlaidClientMessage(e, "item_remove_failed"),
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
      await supabase.from("plaid_accounts").delete().eq("business_id", businessId).eq("plaid_env", plaidEnvName);
      await supabase.from("bank_sync_runs").delete().eq("business_id", businessId);
      const { data: itemsDeleted } = await supabase
        .from("plaid_items")
        .delete()
        .eq("business_id", businessId)
        .eq("plaid_env", plaidEnvName)
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
      .eq("business_id", businessId)
      .eq("plaid_env", plaidEnvName);
    await supabase
      .from("plaid_accounts")
      .update({
        is_active: false,
        disconnected_at: nowIso,
        updated_at: nowIso,
      })
      .eq("business_id", businessId)
      .eq("plaid_env", plaidEnvName);

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
    console.error("[plaid][disconnect] failed", redactPlaidSecrets(err?.message || err));
    return res.status(500).json({
      ok: false,
      error: "plaid_disconnect_failed",
      message: "disconnect_failed",
    });
  }
});

export default router;
