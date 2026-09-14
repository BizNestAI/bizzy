/* global process */
// Read-only bookkeeping audit.
// Usage: BUSINESS_ID="<uuid>" [PLAID_ACCOUNT_ID="<plaid-account-id>"] node scripts/manual/bookkeepingExpenseAuditDryRun.js

import "dotenv/config";

import { supabase } from "../../src/services/supabaseAdmin.js";
import { getAutoPostPolicy, previewAutoPostBacklog } from "../../src/services/bookkeeping/autoPostControl.js";
import { countBookkeepingTransactions } from "../../src/services/bookkeeping/bookkeepingTransactionFeedService.js";
import { normalizeMerchantIdentity } from "../../src/services/bookkeeping/merchantNormalization.js";

const businessId = process.env.BUSINESS_ID || process.env.BOOKKEEPING_AUDIT_BUSINESS_ID || "";
const accountId = process.env.PLAID_ACCOUNT_ID || process.env.BOOKKEEPING_AUDIT_PLAID_ACCOUNT_ID || null;
const rangeParam = process.env.BOOKKEEPING_AUDIT_RANGE || "all";

if (!businessId) {
  console.error("Set BUSINESS_ID or BOOKKEEPING_AUDIT_BUSINESS_ID. This script will not infer a tenant.");
  process.exit(1);
}

function dollars(value) {
  const n = Number(value || 0);
  return Math.round(n * 100) / 100;
}

function addBucket(map, key, amount = 0) {
  const bucket = map.get(key) || { count: 0, dollars: 0 };
  bucket.count += 1;
  bucket.dollars = dollars(bucket.dollars + Math.abs(Number(amount || 0)));
  map.set(key, bucket);
}

function monthKey(date) {
  return String(date || "unknown").slice(0, 7) || "unknown";
}

function direction(row = {}) {
  const raw = String(row.direction || "").toUpperCase();
  if (raw === "INFLOW" || raw === "OUTFLOW") return raw;
  const amount = Number(row.amount || 0);
  if (amount > 0) return "INFLOW";
  if (amount < 0) return "OUTFLOW";
  return "UNKNOWN";
}

function blockerFor({ cat = {}, txn = {}, bookkeepingStartDate = null } = {}) {
  const meta = cat.meta || {};
  const text = [txn.name, txn.merchant_name, txn.counterparty_name].filter(Boolean).join(" ").toLowerCase();
  if (txn.pending === true) return "pending";
  if (bookkeepingStartDate && txn.date && txn.date < bookkeepingStartDate) return "historical_scope_hold";
  if (cat.qbo_txn_id || meta.matched_existing_qbo === true) return "already_represented_in_qbo";
  if (meta.possible_qbo_duplicate === true || meta.duplicate_risk === true) return "qbo_duplicate_possible";
  if (direction(txn) === "INFLOW") return "incoming_deposit_match_required";
  if (/credit card payment|cc payment|epay|autopay|thank you/.test(text) || meta.taxonomy_type === "cc_payment") {
    return "credit_card_payment_match_required";
  }
  if (/transfer|xfer/.test(text) || meta.taxonomy_type === "transfer_internal") return "transfer_match_required";
  if (meta.is_check === true || txn.check_number) return "check_payee_required";
  if (!cat.final_qbo_account_id && !cat.suggested_qbo_account_id) return "qbo_account_missing";
  if (meta.protected_review_reason) return meta.protected_review_reason;
  if (meta.merchant_account_intent_conflict === true) return "classification_requires_confirmation";
  if (meta.auto_handle_decision?.reason) return meta.auto_handle_decision.reason;
  if (!normalizeMerchantIdentity(txn.merchant_name || txn.counterparty_name || txn.name || "").normalized) return "unknown_merchant";
  if (String(cat.confidence || "").toLowerCase() !== "high") return "low_classification_confidence";
  return "other";
}

async function getBusinessPolicy() {
  const policy = await getAutoPostPolicy(supabase, businessId);
  return policy;
}

async function getCounts() {
  const statuses = ["needs_review", "handled", "posted", "matched", "pending"];
  const entries = await Promise.all(
    statuses.map(async (status) => [
      status,
      await countBookkeepingTransactions({ businessId, statusFilter: status, accountId, rangeParam, db: supabase }),
    ])
  );
  return Object.fromEntries(entries);
}

async function fetchRows(statuses) {
  let query = supabase
    .from("transaction_categorizations")
    .select("transaction_id,business_id,status,confidence,suggested_qbo_account_id,suggested_qbo_account_name,final_qbo_account_id,final_qbo_account_name,meta,qbo_txn_id,post_after,post_error")
    .eq("business_id", businessId)
    .in("status", statuses)
    .limit(5000);
  const { data: cats, error: catError } = await query;
  if (catError) throw catError;
  const ids = (cats || []).map((row) => row.transaction_id).filter(Boolean);
  if (!ids.length) return [];
  let txnQuery = supabase
    .from("bank_transactions")
    .select("id,business_id,plaid_account_id,date,name,merchant_name,counterparty_name,amount,direction,pending,is_archived,transaction_type,check_number")
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .in("id", ids);
  if (accountId) txnQuery = txnQuery.eq("plaid_account_id", accountId);
  const { data: txns, error: txnError } = await txnQuery;
  if (txnError) throw txnError;
  const txnById = new Map((txns || []).map((row) => [row.id, row]));
  return (cats || [])
    .map((cat) => ({ cat, txn: txnById.get(cat.transaction_id) }))
    .filter((row) => row.txn);
}

function summarizeBlockers(rows, bookkeepingStartDate) {
  const byBlocker = new Map();
  const byAccount = new Map();
  const byMonth = new Map();
  const byDirection = new Map();
  for (const row of rows) {
    const blocker = blockerFor({ ...row, bookkeepingStartDate });
    addBucket(byBlocker, blocker, row.txn.amount);
    addBucket(byAccount, row.txn.plaid_account_id || "unknown", row.txn.amount);
    addBucket(byMonth, monthKey(row.txn.date), row.txn.amount);
    addBucket(byDirection, direction(row.txn), row.txn.amount);
  }
  const obj = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return { by_blocker: obj(byBlocker), by_account: obj(byAccount), by_month: obj(byMonth), by_direction: obj(byDirection) };
}

function summarizeHandled(rows) {
  const byStatus = new Map();
  const byMonth = new Map();
  const byPostSchedule = new Map();
  const bySafety = new Map();
  const byPostError = new Map();
  const byAccount = new Map();
  const nowTs = Date.now();
  for (const row of rows) {
    const status = String(row.cat.status || "unknown").toLowerCase();
    const meta = row.cat.meta || {};
    addBucket(byStatus, status, row.txn.amount);
    addBucket(byMonth, monthKey(row.txn.date), row.txn.amount);
    addBucket(byAccount, row.txn.plaid_account_id || "unknown", row.txn.amount);
    const postTs = row.cat.post_after ? Date.parse(row.cat.post_after) : null;
    const postSchedule =
      !row.cat.post_after ? "post_after_null" :
        Number.isFinite(postTs) && postTs <= nowTs ? "post_after_due" :
          Number.isFinite(postTs) ? "post_after_future" : "post_after_invalid";
    addBucket(byPostSchedule, postSchedule, row.txn.amount);
    const safety =
      meta.safe_to_auto_post === true ? "safe_to_auto_post_true" :
        meta.auto_approve_reason === "manual_user" ? "manual_user_override" :
          meta.safe_to_auto_post === false ? "safe_to_auto_post_false" : "safe_to_auto_post_missing";
    addBucket(bySafety, safety, row.txn.amount);
    if (row.cat.post_error) addBucket(byPostError, String(row.cat.post_error), row.txn.amount);
  }
  const obj = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return {
    by_status: obj(byStatus),
    by_month: obj(byMonth),
    by_account: obj(byAccount),
    by_post_schedule: obj(byPostSchedule),
    by_safety: obj(bySafety),
    by_post_error: obj(byPostError),
  };
}

async function fetchVendorRuleSummary() {
  const { data, error } = await supabase
    .from("vendor_rules")
    .select("id,match_type,rule_kind,confidence,direction_hint,usage_count,default_qbo_account_id,notes")
    .eq("business_id", businessId)
    .limit(5000);
  if (error) throw error;
  const byMatchType = new Map();
  const byRuleKind = new Map();
  const byConfidence = new Map();
  let withDefaultAccount = 0;
  let normalizedNotes = 0;
  let usageTotal = 0;
  for (const rule of data || []) {
    addBucket(byMatchType, rule.match_type || "unknown");
    addBucket(byRuleKind, rule.rule_kind || "unknown");
    addBucket(byConfidence, rule.confidence || "unknown");
    if (rule.default_qbo_account_id) withDefaultAccount += 1;
    if (String(rule.notes || "").includes("normalized_merchant:")) normalizedNotes += 1;
    usageTotal += Number(rule.usage_count || 0);
  }
  const obj = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return {
    total: data?.length || 0,
    with_default_account: withDefaultAccount,
    with_normalized_notes: normalizedNotes,
    usage_total: usageTotal,
    by_match_type: obj(byMatchType),
    by_rule_kind: obj(byRuleKind),
    by_confidence: obj(byConfidence),
  };
}

const policy = await getBusinessPolicy();
const counts = await getCounts();
const rows = await fetchRows(["needs_review", "uncategorized", "approved", "auto_approved", "failed"]);
const actionable = rows.filter(({ cat, txn }) => ["needs_review", "uncategorized"].includes(String(cat.status || "").toLowerCase()) && txn.pending !== true);
const handled = rows.filter(({ cat }) => ["approved", "auto_approved", "failed"].includes(String(cat.status || "").toLowerCase()));
const historicalHandled = handled.filter(({ txn }) => policy.bookkeeping_start_date && txn.date < policy.bookkeeping_start_date);
const vendorRules = await fetchVendorRuleSummary();
let backlogPreview = null;
try {
  backlogPreview = await previewAutoPostBacklog({
    db: supabase,
    businessId,
    effectiveDate: policy.auto_post_effective_date || policy.bookkeeping_start_date || "0001-01-01",
  });
} catch (err) {
  backlogPreview = { error: err?.message || "preview_failed" };
}

console.log(JSON.stringify({
  ok: true,
  read_only: true,
  business_id: businessId,
  plaid_account_id: accountId,
  range: rangeParam,
  policy: {
    enabled: policy.enabled,
    bookkeeping_start_date: policy.bookkeeping_start_date,
    auto_post_effective_date: policy.auto_post_effective_date,
    auto_post_scope_mode: policy.auto_post_scope_mode,
    historical_backlog_status: policy.historical_backlog_status,
  },
  counts,
  populations: {
    current_actionable_needs_review: actionable.length,
    handled_inside_active_scope: handled.length - historicalHandled.length,
    historical_handled_excluded_by_scope: historicalHandled.length,
    pending: counts.pending,
    posted: counts.posted,
    matched: counts.matched,
  },
  vendor_rules: vendorRules,
  handled_unposted_composition: summarizeHandled(handled),
  blocker_distribution: summarizeBlockers([...actionable, ...historicalHandled], policy.bookkeeping_start_date),
  historical_duplicate_preflight: backlogPreview,
}, null, 2));
