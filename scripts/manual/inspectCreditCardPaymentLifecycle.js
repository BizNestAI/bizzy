/* global process */
/* Read-only by default. A repair requires both --apply and the exact transaction id. */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { classifyBookkeepingLifecycle } from "../../src/services/bookkeeping/bookkeepingLifecycleClassifier.js";

const args = new Set(process.argv.slice(2));
const incidentBusinessId = "cffc2183-e77c-4148-a206-d5192e090925";
const incidentTransactionId = "c54988c5-ea58-491c-a899-72a07c1d6c22";
const businessId = process.env.BUSINESS_ID;
const transactionId = process.env.TRANSACTION_ID;
if (!businessId || !transactionId) throw new Error("BUSINESS_ID and TRANSACTION_ID are required");
if (businessId !== incidentBusinessId || transactionId !== incidentTransactionId) {
  throw new Error("repair_refused_not_exact_discover_incident");
}
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const [{ data: transaction, error: txError }, { data: categorization, error: catError }, { data: pairs, error: pairError }] = await Promise.all([
  db.from("bank_transactions").select("id,business_id,plaid_account_id,plaid_transaction_id,date,name,amount,signed_amount,direction,pending,is_archived,qbo_entity_type,qbo_entity_id,updated_at").eq("business_id", businessId).eq("id", transactionId).maybeSingle(),
  db.from("transaction_categorizations").select("transaction_id,status,review_status,posting_status,reviewed_at,decided_at,posted_at,reconciled_at,post_after,post_error,qbo_txn_id,qbo_txn_type,meta,updated_at").eq("business_id", businessId).eq("transaction_id", transactionId).maybeSingle(),
  db.from("credit_card_payment_pairs").select("id,status,checking_transaction_id,credit_card_transaction_id,qbo_txn_id,post_error,updated_at").eq("business_id", businessId).or(`checking_transaction_id.eq.${transactionId},credit_card_transaction_id.eq.${transactionId}`),
]);
if (txError || catError || pairError) throw txError || catError || pairError;
if (!transaction) throw new Error("transaction_not_found");
const activePair = (pairs || []).find((pair) => pair.status !== "voided") || null;
const merged = { ...transaction, ...(categorization || {}) };
console.log(JSON.stringify({ transaction, categorization, pairs, activePair, lifecycle: classifyBookkeepingLifecycle(merged), dryRunRepair: activePair ? "none: active pair exists" : "reopen exact transaction in Needs Review and clear stale posting schedule/error only" }, null, 2));

if (args.has("--apply")) {
  if (activePair) throw new Error("repair_refused_active_pair_exists");
  const repairedMeta = { ...(categorization?.meta || {}) };
  [
    "auto_approve_reason", "auto_handled_reason", "auto_handle_decision", "posting_in_progress", "next_post_attempt_at",
    "cc_payment_pair_id", "cc_payment_pair_role", "cc_payment_pair_txn_id", "cc_payment_pair_status",
    "cc_payment_pair_confidence", "cc_payment_pair_ambiguous", "cc_payment_pair_candidates",
    "cc_payment_bank_qbo_account_id", "cc_payment_bank_qbo_account_name",
    "cc_payment_cc_qbo_account_id", "cc_payment_cc_qbo_account_name",
    "cc_payment_transfer_target_qbo_account_id", "cc_payment_transfer_target_qbo_account_name",
  ].forEach((key) => delete repairedMeta[key]);
  Object.assign(repairedMeta, {
    taxonomy_type: "cc_payment",
    taxonomy_subtype: "credit_card_payment",
    post_block_reason: "cc_payment_pair_requires_confirmation",
    safe_to_auto_handle: false,
    safe_to_auto_post: false,
    cc_payment_mapping_confidence: "manual_review",
    cc_payment_mapping_notes: "voided_pair_requires_rematch",
    review_reopen_authorized: true,
    review_reopen_reason: "exact_cc_payment_orphan_repair",
  });
  const { error } = await db.from("transaction_categorizations").update({
    status: "needs_review",
    review_status: "needs_review",
    posting_status: "not_scheduled",
    post_after: null,
    post_error: null,
    meta: repairedMeta,
  }).eq("business_id", businessId).eq("transaction_id", transactionId);
  if (error) throw error;
  console.log(JSON.stringify({ repaired: true, businessId, transactionId }));
}
