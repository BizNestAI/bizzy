import crypto from "crypto";
import { supabase } from "../supabaseAdmin.js";
import { runPlaidSyncForItemForBusiness } from "../plaid/plaidSyncService.js";
import { derivePendingLifecycle, pendingAgeDays, PENDING_STALE_DAYS_DEFAULT } from "./pendingTransactionLifecycle.js";
export { derivePendingLifecycle, pendingAgeDays, PENDING_STALE_DAYS_DEFAULT } from "./pendingTransactionLifecycle.js";

function fail(code, message, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function loadBase({ businessId, transactionId, db = supabase }) {
  const { data: bank, error } = await db.from("bank_transactions")
    .select("id,business_id,plaid_transaction_id,pending_transaction_id,plaid_item_id,plaid_env,plaid_account_id,physical_account_id,pending,date,authorized_date,name,merchant_name,amount,direction,raw,created_at,updated_at,last_seen_at,is_archived,archived_reason,pending_resolution_state,pending_resolution_payload,pending_resolved_at,pending_resolved_by")
    .eq("business_id", businessId).eq("id", transactionId).maybeSingle();
  if (error) throw error;
  if (!bank) throw fail("transaction_not_found", "The pending transaction no longer exists.", 404);
  const [{ data: cat, error: catError }, { data: account, error: accountError }, { data: syncRun, error: syncError }] = await Promise.all([
    db.from("transaction_categorizations").select("status,review_status,posting_status,suggested_qbo_account_id,suggested_qbo_account_name,final_qbo_account_id,final_qbo_account_name,qbo_txn_id,posted_at,reconciled_at,meta,updated_at").eq("business_id", businessId).eq("transaction_id", transactionId).maybeSingle(),
    db.from("plaid_accounts").select("plaid_account_id,name,official_name,mask,type,subtype,plaid_item_id,last_sync_at").eq("business_id", businessId).eq("plaid_account_id", bank.plaid_account_id).maybeSingle(),
    db.from("bank_sync_runs").select("status,started_at,finished_at,added_count,modified_count,removed_count,failure_code").eq("business_id", businessId).eq("plaid_item_id", bank.plaid_item_id).eq("status", "success").order("finished_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (catError) throw catError;
  if (accountError) throw accountError;
  if (syncError) throw syncError;
  const { data: replacement, error: replacementError } = await db.from("bank_transactions")
    .select("id,plaid_transaction_id,pending_transaction_id,pending,date,authorized_date,amount,name,merchant_name,updated_at")
    .eq("business_id", businessId).eq("pending_transaction_id", bank.plaid_transaction_id).eq("pending", false).eq("is_archived", false).neq("id", bank.id).limit(1).maybeSingle();
  if (replacementError) throw replacementError;
  return { bank, cat, account, syncRun, replacement };
}

export async function getPendingResolutionContext({ businessId, transactionId, staleDays = Number(process.env.PENDING_TRANSACTION_STALE_DAYS || PENDING_STALE_DAYS_DEFAULT), db = supabase }) {
  const { bank, cat, account, syncRun, replacement } = await loadBase({ businessId, transactionId, db });
  const ageDays = pendingAgeDays(bank);
  const provenance = bank.raw?.recovery_imported === true || bank.raw?.plaid_recovery_batch_id
    ? "replacement_card_recovery" : (bank.raw?.canonical_source || "normal_sync");
  const candidates = Array.isArray(cat?.meta?.qbo_duplicate_candidates) ? cat.meta.qbo_duplicate_candidates : [];
  return {
    transaction: {
      ...bank,
      merchant: bank.merchant_name || bank.name,
      pending_age_days: ageDays,
      account_name: account?.official_name || account?.name || null,
      account_mask: account?.mask || null,
      provenance,
      last_provider_update: bank.last_seen_at || bank.updated_at,
      latest_successful_item_sync_at: syncRun?.finished_at || account?.last_sync_at || null,
      suggested_gl: cat?.suggested_qbo_account_name || null,
      suggested_gl_non_final: true,
    },
    lifecycle: derivePendingLifecycle(bank, { replacement, staleDays }),
    stale_threshold_days: staleDays,
    replacement,
    replacement_found: Boolean(replacement),
    qbo_candidate_found: candidates.length > 0,
    qbo_candidates: candidates.slice(0, 5),
    has_accounting_record: Boolean(cat),
    has_posting_intent: Boolean(cat?.meta?.post_intent_id || cat?.posting_status === "posting"),
    has_qbo_receipt: Boolean(cat?.qbo_txn_id || cat?.posted_at),
    has_match: Boolean(cat?.reconciled_at || cat?.status === "matched_existing_qbo"),
  };
}

async function recordEvent({ db, businessId, transactionId, action, priorState, resultingState, actor, reason, evidence, idempotencyKey }) {
  const { error } = await db.from("pending_transaction_resolution_events").upsert({
    business_id: businessId, transaction_id: transactionId, action, prior_state: priorState,
    resulting_state: resultingState, actor_user_id: actor?.id || null, actor_label: actor?.email || actor?.label || null,
    reason: reason || null, evidence: evidence || {}, idempotency_key: idempotencyKey,
  }, { onConflict: "business_id,idempotency_key", ignoreDuplicates: true });
  if (error) throw error;
}

export async function refreshPendingStatus({ businessId, transactionId, actor, idempotencyKey = crypto.randomUUID(), db = supabase }) {
  const before = await getPendingResolutionContext({ businessId, transactionId, db });
  if (!before.transaction.plaid_item_id) throw fail("missing_plaid_item", "This transaction has no Plaid Item to refresh.");
  await runPlaidSyncForItemForBusiness(businessId, before.transaction.plaid_item_id, { force: true });
  const after = await getPendingResolutionContext({ businessId, transactionId, db });
  await recordEvent({ db, businessId, transactionId, action: "refresh_status", priorState: before.lifecycle, resultingState: after.lifecycle, actor, evidence: { provider_write: false, qbo_write: false, plaid_item_id: before.transaction.plaid_item_id }, idempotencyKey });
  return after;
}

export async function confirmPendingSettled({ businessId, transactionId, actor, statementDate, statementAmount, reason, idempotencyKey, db = supabase }) {
  const { data, error } = await db.rpc("confirm_pending_transaction_settled", {
    p_business_id: businessId, p_transaction_id: transactionId, p_actor_user_id: actor?.id || null,
    p_actor_label: actor?.email || actor?.label || null, p_statement_date: statementDate,
    p_statement_amount: statementAmount, p_reason: reason, p_idempotency_key: idempotencyKey,
    p_decision_version: 1,
  });
  if (error) throw fail(error.message, "Could not confirm settlement; no changes were made.");
  return data;
}

export async function linkPendingReplacement({ businessId, transactionId, replacementTransactionId, actor, idempotencyKey, db = supabase }) {
  const { data, error } = await db.rpc("link_pending_transaction_replacement", {
    p_business_id: businessId, p_transaction_id: transactionId, p_replacement_transaction_id: replacementTransactionId,
    p_actor_user_id: actor?.id || null, p_actor_label: actor?.email || actor?.label || null, p_idempotency_key: idempotencyKey,
  });
  if (error) throw fail(error.message, "Could not link the posted replacement; no changes were made.");
  return data;
}

export async function excludePendingAuthorization({ businessId, transactionId, actor, reason, idempotencyKey, db = supabase }) {
  const context = await getPendingResolutionContext({ businessId, transactionId, db });
  if (context.transaction.pending !== true) throw fail("transaction_not_pending", "Only a pending authorization can use this action.");
  const { data, error } = await db.rpc("exclude_bookkeeping_transaction", {
    p_business_id: businessId, p_transaction_id: transactionId, p_actor: actor?.id || actor?.email || "internal_admin",
    p_reason: reason || "Pending authorization expired or did not settle.", p_source: "monthly_review_pending_resolution", p_correlation_id: idempotencyKey,
  });
  if (error) throw error;
  await db.from("bank_transactions").update({ pending_resolution_state: "excluded_pending_authorization", pending_resolved_at: new Date().toISOString(), pending_resolved_by: actor?.id || null }).eq("business_id", businessId).eq("id", transactionId);
  await recordEvent({ db, businessId, transactionId, action: "exclude_expired_authorization", priorState: context.lifecycle, resultingState: "excluded_pending_authorization", actor, reason, evidence: { provider_write: false, qbo_write: false }, idempotencyKey });
  return data;
}
