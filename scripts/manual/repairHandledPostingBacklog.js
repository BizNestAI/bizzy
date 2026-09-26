/* global process */
// Safe backlog planner/releaser. Dry-run is the default.
// BUSINESS_ID=<uuid> node scripts/manual/repairHandledPostingBacklog.js
// BUSINESS_ID=<uuid> node scripts/manual/repairHandledPostingBacklog.js --execute --transaction-id=<uuid>

import "dotenv/config";
import { supabase } from "../../src/services/supabaseAdmin.js";

const args = new Set(process.argv.slice(2));
const execute = args.has("--execute");
const transactionIds = process.argv.slice(2)
  .filter((arg) => arg.startsWith("--transaction-id="))
  .map((arg) => arg.slice("--transaction-id=".length))
  .filter(Boolean);
const businessId = process.env.BUSINESS_ID || process.env.BOOKKEEPING_AUDIT_BUSINESS_ID || "";
const accountId = process.env.PLAID_ACCOUNT_ID || "";
const batchSize = Math.max(1, Math.min(Number(process.env.BATCH_SIZE || 25), 100));
const nowIso = new Date().toISOString();

if (!businessId) throw new Error("Set BUSINESS_ID; tenant inference is intentionally disabled.");
if (execute && transactionIds.length === 0) {
  throw new Error("Execution requires one or more explicit --transaction-id=<uuid> arguments.");
}

const RETRYABLE_CODES = new Set([
  "fetch_failed", "network_error", "timeout", "qbo_rate_limited", "qbo_service_unavailable",
  "qbo_client_unavailable", "vendor_create_pending", "vendor_qbo_create_unknown",
]);
const PERMANENT_OR_REVIEW_CODES = new Set([
  "weak_memo_evidence", "probable_requires_review", "possible_qbo_duplicate",
  "match_check_unavailable", "credit_card_inflow_requires_review", "missing_final_qbo_account",
  "missing_destination_qbo_account", "missing_source_qbo_account", "inactive_source_qbo_account",
  "inactive_destination_qbo_account", "cc_payment_mapping_not_safe", "unsupported_transaction_type",
]);

function codeFor(row) {
  return String(row.meta?.post_block_reason || row.post_error || "").toLowerCase();
}

function planFor(row, intent, mapping) {
  if (row.qbo_txn_id || intent?.status === "posted" || intent?.qbo_txn_id) return "reconcile_local_from_receipt";
  if (intent && ["processing", "unknown"].includes(String(intent.status || "").toLowerCase())) {
    return "hold_for_qbo_reconciliation";
  }
  if (!mapping?.qbo_account_id) return "blocked_missing_source_mapping";
  if (!row.final_qbo_account_id && row.meta?.split_transaction_status !== "confirmed" && row.meta?.loan_payment_split_status !== "confirmed") {
    return "blocked_missing_destination";
  }
  const code = codeFor(row);
  if (PERMANENT_OR_REVIEW_CODES.has(code)) return `blocked_${code}`;
  if (row.post_after && Date.parse(row.post_after) > Date.now()) return "scheduled_future";
  if (row.post_after) return "scheduled_due";
  if (code && RETRYABLE_CODES.has(code)) return "eligible_controlled_retry";
  if (code) return `blocked_unclassified_${code}`;
  return "blocked_missing_schedule";
}

let catsQuery = supabase
  .from("transaction_categorizations")
  .select("transaction_id,business_id,status,final_qbo_account_id,final_qbo_account_name,post_after,post_error,meta,qbo_txn_id,posted_at,last_post_attempt_at")
  .eq("business_id", businessId)
  .in("status", ["approved", "auto_approved", "failed"])
  .order("post_after", { ascending: true, nullsFirst: true })
  .limit(5000);
if (transactionIds.length) catsQuery = catsQuery.in("transaction_id", transactionIds);
const { data: cats, error: catsError } = await catsQuery;
if (catsError) throw catsError;

const ids = (cats || []).map((row) => row.transaction_id);
const { data: txns, error: txnsError } = ids.length
  ? await supabase.from("bank_transactions").select("id,plaid_account_id,date,name,amount,pending,is_archived").eq("business_id", businessId).in("id", ids)
  : { data: [], error: null };
if (txnsError) throw txnsError;
const txnMap = new Map((txns || []).map((row) => [row.id, row]));
const accountIds = [...new Set((txns || []).map((row) => row.plaid_account_id).filter(Boolean))];
const { data: mappings, error: mappingsError } = accountIds.length
  ? await supabase.from("plaid_qbo_account_mappings").select("plaid_account_id,qbo_account_id,qbo_account_name,qbo_account_type").eq("business_id", businessId).in("plaid_account_id", accountIds)
  : { data: [], error: null };
if (mappingsError) throw mappingsError;
const mappingMap = new Map((mappings || []).map((row) => [row.plaid_account_id, row]));
const { data: intents, error: intentsError } = ids.length
  ? await supabase.from("qbo_posted_transactions").select("transaction_id,status,qbo_txn_id,qbo_txn_type,request_id,lease_expires_at,last_error,updated_at").eq("business_id", businessId).in("transaction_id", ids)
  : { data: [], error: null };
if (intentsError && !["42P01", "42703"].includes(intentsError.code)) throw intentsError;
const intentMap = new Map((intents || []).map((row) => [row.transaction_id, row]));

const plan = (cats || [])
  .map((cat) => {
    const txn = txnMap.get(cat.transaction_id);
    if (!txn || txn.pending || txn.is_archived || (accountId && txn.plaid_account_id !== accountId)) return null;
    const intent = intentMap.get(cat.transaction_id) || null;
    return {
      transaction_id: cat.transaction_id,
      plaid_account_id: txn.plaid_account_id,
      date: txn.date,
      amount: txn.amount,
      description: txn.name,
      current_status: cat.status,
      post_after: cat.post_after,
      error_code: codeFor(cat) || null,
      intent_status: intent?.status || null,
      intent_request_id: intent?.request_id || null,
      action: planFor(cat, intent, mappingMap.get(txn.plaid_account_id)),
    };
  })
  .filter(Boolean);

const counts = plan.reduce((out, row) => ({ ...out, [row.action]: (out[row.action] || 0) + 1 }), {});
const release = plan.filter((row) => row.action === "eligible_controlled_retry");

if (execute) {
  const notEligible = plan.filter((row) => !["eligible_controlled_retry", "scheduled_due"].includes(row.action));
  if (notEligible.length) throw new Error(`Refusing unsafe release: ${JSON.stringify(notEligible)}`);
  for (let index = 0; index < release.length; index += batchSize) {
    const batch = release.slice(index, index + batchSize);
    for (const row of batch) {
      const { data: current, error: readError } = await supabase
        .from("transaction_categorizations")
        .select("post_after,post_error,meta,qbo_txn_id")
        .eq("business_id", businessId).eq("transaction_id", row.transaction_id).maybeSingle();
      if (readError) throw readError;
      if (!current || current.qbo_txn_id || current.post_after || !RETRYABLE_CODES.has(codeFor(current))) {
        throw new Error(`State changed; refusing ${row.transaction_id}`);
      }
      const meta = { ...(current.meta || {}), next_post_attempt_at: nowIso, backlog_released_at: nowIso };
      const { error: updateError } = await supabase.from("transaction_categorizations")
        .update({ post_after: nowIso, post_error: null, meta })
        .eq("business_id", businessId).eq("transaction_id", row.transaction_id)
        .is("qbo_txn_id", null).is("post_after", null);
      if (updateError) throw updateError;
    }
  }
}

console.log(JSON.stringify({ mode: execute ? "execute" : "dry-run", business_id: businessId, account_id: accountId || null, counts, rows: plan }, null, 2));
