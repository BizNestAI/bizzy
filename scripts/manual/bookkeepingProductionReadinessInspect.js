/* global process */
// Read-only production readiness inspection for merchant-learning/backlog rollout.
// Usage: BUSINESS_ID="<uuid>" node scripts/manual/bookkeepingProductionReadinessInspect.js

import "dotenv/config";

import { supabase } from "../../src/services/supabaseAdmin.js";
import { normalizeMerchantIdentity } from "../../src/services/bookkeeping/merchantNormalization.js";

const businessId = process.env.BUSINESS_ID || process.env.BOOKKEEPING_AUDIT_BUSINESS_ID || "";
const now = new Date();
const nowIso = now.toISOString();

if (!businessId) {
  console.error("Set BUSINESS_ID. This script is read-only and will not infer a tenant.");
  process.exit(1);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function amountDirection(txn = {}) {
  const raw = String(txn.direction || "").toUpperCase();
  if (raw === "INFLOW" || raw === "OUTFLOW") return raw;
  const amount = Number(txn.amount || 0);
  if (amount > 0) return "INFLOW";
  if (amount < 0) return "OUTFLOW";
  return "UNKNOWN";
}

function textOf(txn = {}, cat = {}) {
  return [
    txn.name,
    txn.merchant_name,
    txn.counterparty_name,
    cat.final_qbo_account_name,
    cat.suggested_qbo_account_name,
    cat.meta?.taxonomy_type,
    cat.meta?.post_block_reason,
  ].filter(Boolean).join(" ").toLowerCase();
}

function isProtectedWorkflow(txn = {}, cat = {}) {
  const meta = cat.meta || {};
  const text = textOf(txn, cat);
  const taxonomyType = String(meta.taxonomy_type || "").toLowerCase();
  if (amountDirection(txn) === "INFLOW") return { protected: true, reason: "incoming_deposit" };
  if (txn.pending === true || meta.pending === true) return { protected: true, reason: "pending" };
  if (txn.accounting_review_required === true) return { protected: true, reason: "plaid_accounting_review_required" };
  if (txn.check_number || meta.is_check === true || taxonomyType === "check") return { protected: true, reason: "check" };
  if (taxonomyType === "cc_payment" || /credit card payment|cc payment|epay|autopay|thank you/.test(text)) {
    return { protected: true, reason: "credit_card_payment" };
  }
  if (taxonomyType.includes("transfer") || /transfer|xfer/.test(text)) return { protected: true, reason: "transfer" };
  if (taxonomyType === "refund" || /refund|chargeback|reversal/.test(text)) return { protected: true, reason: "refund" };
  if (taxonomyType === "payroll" || /payroll|salary|wages/.test(text)) return { protected: true, reason: "payroll" };
  if (taxonomyType === "tax_payment" || /\birs\b|tax payment|estimated tax|payroll tax/.test(text)) return { protected: true, reason: "tax_payment" };
  if (/loan|principal|interest|liability|owner draw|owner contribution|fixed asset|equipment purchase/.test(text)) {
    return { protected: true, reason: "liability_owner_fixed_asset_or_loan" };
  }
  if (meta.possible_qbo_duplicate === true || meta.duplicate_risk === true) return { protected: true, reason: "possible_qbo_duplicate" };
  return { protected: false, reason: null };
}

function postSchedule(cat = {}) {
  if (!cat.post_after) return "none";
  const ts = Date.parse(cat.post_after);
  if (!Number.isFinite(ts)) return "invalid";
  return ts <= now.getTime() ? "due" : "future";
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function safeMeta(cat = {}) {
  return cat.meta?.safe_to_auto_post === true;
}

function sourceMapped(txn = {}, mappings = new Map()) {
  return Boolean(txn.plaid_account_id && mappings.has(txn.plaid_account_id));
}

function classifyCanonical(row, mappings = new Map(), postedMap = new Map(), intentMap = new Map()) {
  const { cat, txn } = row;
  const protectedResult = isProtectedWorkflow(txn, cat);
  if (protectedResult.protected) return { bucket: "protected_workflow", reason: protectedResult.reason };
  if (String(cat.status || "").toLowerCase() === "failed") return { bucket: "failed_requires_review", reason: cat.post_error || "failed" };
  if (cat.qbo_txn_id || postedMap.has(cat.transaction_id)) {
    return { bucket: "other_explicitly_explained_state", reason: "already_represented_in_qbo" };
  }
  const activeIntent = intentMap.get(cat.transaction_id);
  if (activeIntent && ["claimed", "pending", "processing", "posting"].includes(String(activeIntent.status || "").toLowerCase())) {
    return { bucket: "other_explicitly_explained_state", reason: `active_posting_intent_${activeIntent.status}` };
  }
  const schedule = postSchedule(cat);
  if (safeMeta(cat) && sourceMapped(txn, mappings) && schedule === "due") return { bucket: "scheduled_due", reason: "safe_due" };
  if (safeMeta(cat) && sourceMapped(txn, mappings) && schedule === "future") return { bucket: "scheduled_future", reason: "safe_future" };
  if (safeMeta(cat) && sourceMapped(txn, mappings) && schedule === "none") return { bucket: "eligible_unscheduled", reason: "safe_unscheduled" };
  return { bucket: "unsafe_not_scheduled", reason: cat.post_error || cat.meta?.post_block_reason || "not_currently_safe" };
}

async function selectOptional(table, select, buildQuery = (query) => query) {
  const { data, error } = await buildQuery(supabase.from(table).select(select));
  if (error) {
    const message = String(error.message || "");
    if (error.code === "42P01" || error.code === "42703" || message.includes("does not exist")) {
      return { data: [], error: null, unavailable: true, reason: message || error.code };
    }
    throw error;
  }
  return { data: data || [], error: null };
}

async function fetchHandledRows() {
  const { data: cats, error } = await supabase
    .from("transaction_categorizations")
    .select("transaction_id,business_id,status,final_qbo_account_id,final_qbo_account_name,post_after,post_error,meta,qbo_txn_id")
    .eq("business_id", businessId)
    .in("status", ["approved", "auto_approved", "failed"])
    .is("qbo_txn_id", null)
    .limit(5000);
  if (error) throw error;
  const ids = asArray(cats).map((row) => row.transaction_id).filter(Boolean);
  const { data: txns, error: txnError } = await supabase
    .from("bank_transactions")
    .select("id,business_id,plaid_account_id,date,name,merchant_name,counterparty_name,merchant_entity_id,amount,direction,pending,is_archived,transaction_type,check_number,accounting_review_required,category_primary,personal_finance_category")
    .eq("business_id", businessId)
    .in("id", ids)
    .limit(5000);
  if (txnError) throw txnError;
  const txnById = new Map(asArray(txns).filter((row) => row.is_archived !== true).map((row) => [row.id, row]));
  return asArray(cats)
    .map((cat) => ({ cat, txn: txnById.get(cat.transaction_id) }))
    .filter((row) => row.txn);
}

async function fetchMappings(rows) {
  const accountIds = Array.from(new Set(rows.map((row) => row.txn.plaid_account_id).filter(Boolean)));
  if (!accountIds.length) return new Map();
  const { data, error } = await supabase
    .from("plaid_qbo_account_mappings")
    .select("plaid_account_id,qbo_account_id,qbo_account_name,qbo_account_type")
    .eq("business_id", businessId)
    .in("plaid_account_id", accountIds);
  if (error) throw error;
  return new Map(asArray(data).map((row) => [row.plaid_account_id, row]));
}

async function fetchAccountCache(rows) {
  const accountIds = Array.from(new Set(rows.map((row) => row.cat.final_qbo_account_id).filter(Boolean)));
  if (!accountIds.length) return new Map();
  const result = await selectOptional("qbo_accounts_cache", "qbo_account_id,name,account_type,active", (query) =>
    query.eq("business_id", businessId).in("qbo_account_id", accountIds)
  );
  return new Map(asArray(result.data).map((row) => [String(row.qbo_account_id), row]));
}

async function fetchPostedAndIntents(rows) {
  const ids = rows.map((row) => row.cat.transaction_id).filter(Boolean);
  const posted = await selectOptional("qbo_posted_transactions", "*", (query) => query.eq("business_id", businessId).in("transaction_id", ids).limit(5000));
  const attempts = await selectOptional("bookkeeping_post_attempts", "*", (query) => query.eq("business_id", businessId).order("created_at", { ascending: false }).limit(1000));
  return {
    posted,
    attempts,
    postedMap: new Map(
      asArray(posted.data)
        .filter((row) => row.qbo_txn_id || String(row.status || "").toLowerCase() === "posted")
        .map((row) => [row.transaction_id, row])
    ),
    intentMap: new Map(asArray(posted.data).map((row) => [row.transaction_id, row])),
  };
}

function workerVisibility(row) {
  const { cat } = row;
  if (!["approved", "auto_approved", "failed"].includes(String(cat.status || "").toLowerCase())) return false;
  if (cat.qbo_txn_id) return false;
  return Boolean(cat.post_after && Date.parse(cat.post_after) <= now.getTime());
}

function workerSkipReason(row, mappings = new Map()) {
  const { cat, txn } = row;
  const protectedResult = isProtectedWorkflow(txn, cat);
  if (!workerVisibility(row)) return "not_due_or_not_visible";
  if (!sourceMapped(txn, mappings)) return "missing_qbo_account_mapping";
  if (protectedResult.protected) return protectedResult.reason;
  if (String(cat.status || "").toLowerCase() === "auto_approved" && !safeMeta(cat)) return "auto_approved_without_safe_flag";
  if (String(cat.status || "").toLowerCase() === "approved" && !safeMeta(cat) && cat.meta?.auto_approve_reason !== "manual_user") {
    return "approved_without_safe_or_manual_authority";
  }
  return "preclaim_candidate";
}

function summarizeAttempts(attempts = []) {
  const byStatus = {};
  const byError = {};
  let latestSuccess = null;
  let latestAttempt = null;
  for (const attempt of attempts) {
    increment(byStatus, String(attempt.status || "unknown"));
    if (attempt.error_message) increment(byError, String(attempt.error_message));
    const timestamp = attempt.created_at || attempt.attempted_at || attempt.updated_at || null;
    if (timestamp && (!latestAttempt || timestamp > latestAttempt)) latestAttempt = timestamp;
    const status = String(attempt.status || "").toLowerCase();
    if (["posted", "success", "succeeded"].includes(status) && timestamp && (!latestSuccess || timestamp > latestSuccess)) {
      latestSuccess = timestamp;
    }
  }
  return { latest_attempt_at: latestAttempt, latest_success_at: latestSuccess, by_status: byStatus, by_error: byError };
}

function canaryCandidate(row, mappings, accounts, postedMap, intentMap) {
  const canonical = classifyCanonical(row, mappings, postedMap, intentMap);
  if (canonical.bucket !== "scheduled_due") return null;
  const skipReason = workerSkipReason(row, mappings);
  if (skipReason !== "preclaim_candidate") return null;
  if (row.cat.meta?.posting_in_progress === true || row.cat.meta?.post_intent_id) return null;
  const account = accounts.get(String(row.cat.final_qbo_account_id));
  const accountType = String(account?.account_type || row.cat.meta?.final_qbo_account_type || row.cat.meta?.qbo_account_type || "").toLowerCase();
  const name = String(row.cat.final_qbo_account_name || "").toLowerCase();
  if (accountType && !["expense", "cost of goods sold"].includes(accountType)) return null;
  if (/asset|liabil|loan|owner|tax|payroll|uncategorized|suspense/.test(name)) return null;
  const normalized = normalizeMerchantIdentity(row.txn.merchant_name || row.txn.counterparty_name || row.txn.name || "");
  return {
    transaction_id: row.cat.transaction_id,
    date: row.txn.date,
    amount: row.txn.amount,
    normalized_merchant: normalized.normalized,
    merchant: row.txn.merchant_name || row.txn.counterparty_name || row.txn.name || null,
    selected_qbo_account: {
      id: row.cat.final_qbo_account_id,
      name: row.cat.final_qbo_account_name,
      type: account?.account_type || null,
      active: account?.active ?? null,
    },
    classification_source: row.cat.meta?.auto_approve_reason || row.cat.meta?.suggestion_source || row.cat.status,
    learned_rule_evidence: {
      vendor_rule_id: row.cat.meta?.vendor_rule_id || null,
      source_type: row.cat.meta?.vendor_rule_source_type || null,
      match_specificity: row.cat.meta?.vendor_rule_match_specificity || null,
    },
    duplicate_preflight_result: "local_duplicate_evidence_clear; live_qbo_duplicate_preflight_runs_in_worker_before_post",
    why_safe: "ordinary outflow, due post_after, safe_to_auto_post true, source account mapped, no local QBO receipt/active intent, no protected workflow evidence",
  };
}

const rows = await fetchHandledRows();
const mappings = await fetchMappings(rows);
const accounts = await fetchAccountCache(rows);
const { posted, attempts, postedMap, intentMap } = await fetchPostedAndIntents(rows);

const buckets = {};
const reasons = {};
const crossTab = {};
const worker = {
  cron_expected_enabled: process.env.DISABLE_BOOKS_POST_CRON !== "true",
  expected_cadence_minutes: Number(process.env.BOOKS_POST_CRON_MINUTES || 10),
  due_rows_visible_to_worker: 0,
  preclaim_candidates: 0,
  skipped_by_reason: {},
};
const evaluations = [];

for (const row of rows) {
  const canonical = classifyCanonical(row, mappings, postedMap, intentMap);
  increment(buckets, canonical.bucket);
  increment(reasons, canonical.reason);
  const schedule = postSchedule(row.cat);
  const key = `${canonical.bucket}:${schedule}`;
  increment(crossTab, key);
  const skip = workerSkipReason(row, mappings);
  if (workerVisibility(row)) {
    worker.due_rows_visible_to_worker += 1;
    if (skip === "preclaim_candidate") worker.preclaim_candidates += 1;
    else increment(worker.skipped_by_reason, skip);
  }
  evaluations.push({
    transaction_id: row.cat.transaction_id,
    date: row.txn.date,
    amount: row.txn.amount,
    status: row.cat.status,
    post_after: row.cat.post_after,
    bucket: canonical.bucket,
    reason: canonical.reason,
    worker_skip_reason: skip,
  });
}

const attemptSummary = summarizeAttempts(asArray(attempts.data));
const canaryCandidates = evaluations
  .map((evaluation) => canaryCandidate(rows.find((row) => row.cat.transaction_id === evaluation.transaction_id), mappings, accounts, postedMap, intentMap))
  .filter(Boolean)
  .slice(0, 3);

let health = null;
try {
  const res = await fetch("https://bizzy-production.up.railway.app/healthz");
  health = { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
} catch (error) {
  health = { ok: false, error: error?.message || "health_fetch_failed" };
}

console.log(JSON.stringify({
  ok: true,
  read_only: true,
  business_id: businessId,
  inspected_at: nowIso,
  canonical_handled_unposted_count: rows.length,
  canonical_buckets: buckets,
  canonical_reasons: reasons,
  schedule_cross_tab: crossTab,
  worker_read_only_diagnosis: {
    ...worker,
    attempts_table_available: attempts.unavailable !== true,
    posted_intents_table_available: posted.unavailable !== true,
    attempt_summary: attemptSummary,
    qbo_posted_transactions_for_backlog_count: asArray(posted.data).length,
    active_intent_like_rows: asArray(posted.data).filter((row) => ["claimed", "pending", "processing", "posting"].includes(String(row.status || "").toLowerCase())).length,
  },
  deployment_health: health,
  canary_candidates: canaryCandidates,
  sample_evaluations: evaluations.slice(0, 25),
}, null, 2));
