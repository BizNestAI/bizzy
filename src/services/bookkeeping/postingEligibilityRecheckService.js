import crypto from "node:crypto";
import { computePostAfterForAutoPost, getAutoPostPolicy, reEvaluateAutoPostBacklog } from "./autoPostControl.js";
import { hasManualAccountAuthority } from "./postingDecisionAuthority.js";
import { hasAuthorizedMonthlyReviewApproval } from "./manualPostingAuthority.js";
import { hasFinalCategorizeAsNewResolution } from "./incomingDepositResolution.js";
import { qboEnvName } from "../../utils/qboEnv.js";

const HANDLED = ["approved", "auto_approved", "handled", "failed"];
const MAX_ROWS = 100;
const ACTIVE_JOB_STATES = new Set(["processing", "reconciling"]);
const FINAL_JOB_STATES = new Set(["posted"]);
const SPECIAL_TAXONOMIES = new Set([
  "cc_payment", "transfer_internal", "bank_transfer", "loan_payment", "loan_movement",
  "refund", "statement_credit", "owner_draw", "owner_contribution", "tax_payment", "payroll",
]);

function monthBounds(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ""))) {
    const error = new Error("invalid_review_month");
    error.status = 400;
    error.code = "invalid_review_month";
    throw error;
  }
  const start = `${month}-01`;
  const next = new Date(`${start}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return [start, next.toISOString().slice(0, 10)];
}

function reason(result, code) {
  const key = code || "unknown";
  result.reason_counts[key] = (result.reason_counts[key] || 0) + 1;
}

function count(result, outcome) {
  result.counts[outcome] = (result.counts[outcome] || 0) + 1;
}

function safeDescription(row = {}) {
  return String(row.merchant_name || row.counterparty_name || row.name || "Transaction").slice(0, 120);
}

function rowVersion({ cat, bank, job, intent }) {
  return crypto.createHash("sha256").update(JSON.stringify({
    transaction_id: cat.transaction_id,
    categorization_updated_at: cat.updated_at || null,
    bank_updated_at: bank.updated_at || null,
    status: cat.status || null,
    account: cat.final_qbo_account_id || null,
    post_after: cat.post_after || null,
    post_error: cat.post_error || null,
    job_state: job?.state || null,
    job_updated_at: job?.updated_at || null,
    intent_status: intent?.status || null,
    intent_updated_at: intent?.updated_at || null,
  })).digest("hex");
}

function previewVersion(scope, rows) {
  return crypto.createHash("sha256").update(JSON.stringify({
    business_id: scope.business_id,
    month: scope.month,
    account_scope: scope.account_scope || null,
    auto_post_enabled: scope.auto_post_enabled,
    rows: rows.map((row) => [row.transaction_id, row.row_version, row.outcome, row.reason]),
  })).digest("hex");
}

function durableManualAuthority(cat = {}) {
  const approval = cat.meta?.manual_approval;
  if (hasAuthorizedMonthlyReviewApproval(cat)) {
    return String(approval.business_id) === String(cat.business_id) &&
      String(approval.transaction_id) === String(cat.transaction_id) &&
      String(approval.selected_qbo_account_id) === String(cat.final_qbo_account_id);
  }
  return hasManualAccountAuthority(cat) && Boolean(cat.decided_by && cat.decided_at && cat.final_qbo_account_id);
}

function hardBlock({ cat, bank, job, intent, sourceAccount, sourceItem, sourceMapping, qboAccount, recoveryBatch, nowMs }) {
  const meta = cat.meta || {};
  if (!bank) return "bank_transaction_missing";
  if (bank.pending === true) return "pending_transaction_not_postable";
  if (bank.is_archived === true || cat.is_archived === true || cat.excluded_at) return "archived_or_excluded";
  if (cat.qbo_txn_id || cat.posted_at || FINAL_JOB_STATES.has(job?.state)) return "already_posted";
  if (intent?.qbo_txn_id || intent?.status === "posted") return "qbo_receipt_requires_reconciliation";
  if (intent?.status === "processing" && Date.parse(intent.lease_expires_at || "") > nowMs) return "active_provider_operation";
  if (ACTIVE_JOB_STATES.has(job?.state) && Date.parse(job.lease_expires_at || "") > nowMs) return "active_worker_lease";
  if (job?.state === "reconciling" || meta.ambiguous_provider_outcome === true) return "provider_reconciliation_required";
  if (cat.posting_hold_batch_id && recoveryBatch?.posting_hold !== false) return "recovery_posting_hold_active";
  if (meta.matched_existing_qbo || meta.incoming_deposit_match_status === "confirmed" || meta.cc_payment_pair_id) return "matched_or_paired_transaction";
  if (meta.possible_qbo_duplicate === true || meta.duplicate_risk === true) return "possible_qbo_duplicate";
  const taxonomy = String(meta.taxonomy_type || "").toLowerCase();
  if (SPECIAL_TAXONOMIES.has(taxonomy)) return `${taxonomy || "special"}_workflow_protected`;
  const inflow = String(bank.direction || "").toUpperCase() === "INFLOW" || (!bank.direction && Number(bank.amount || 0) > 0);
  if (inflow && !hasFinalCategorizeAsNewResolution(cat)) return "incoming_deposit_resolution_required";
  if (!cat.final_qbo_account_id) return "missing_final_qbo_account";
  if (!qboAccount || qboAccount.active === false) return "invalid_or_inactive_qbo_account";
  if (!sourceMapping?.qbo_account_id) return "missing_source_qbo_mapping";
  if (!sourceAccount || !sourceItem || sourceItem.is_active === false || String(sourceItem.status || "").toLowerCase() === "disconnected") return "source_account_inactive";
  if (String(bank.plaid_env || "") !== String(sourceAccount.plaid_env || "") || String(sourceItem.plaid_env || "") !== String(sourceAccount.plaid_env || "")) return "source_environment_mismatch";
  return null;
}

async function rowsForScope({ db, businessId, month, accountScope = null, transactionIds = [], limit = MAX_ROWS }) {
  const [start, end] = monthBounds(month);
  let bankQuery = db.from("bank_transactions")
    .select("id,business_id,plaid_item_id,plaid_env,plaid_account_id,date,amount,direction,pending,is_archived,name,merchant_name,counterparty_name,updated_at")
    .eq("business_id", businessId).eq("is_archived", false);
  const selectedIds = [...new Set((transactionIds || []).filter(Boolean).map(String))].slice(0, MAX_ROWS);
  if (selectedIds.length) bankQuery = bankQuery.in("id", selectedIds);
  else bankQuery = bankQuery.gte("date", start).lt("date", end);
  if (accountScope) bankQuery = bankQuery.eq("plaid_account_id", accountScope);
  const { data: bankRows, error: bankError } = await bankQuery.limit(Math.min(Math.max(Number(limit) || MAX_ROWS, 1), MAX_ROWS) + 1);
  if (bankError) throw bankError;
  const bounded = (bankRows || []).slice(0, MAX_ROWS);
  const ids = bounded.map((row) => row.id);
  if (!ids.length) return { rows: [], truncated: false };
  const [{ data: cats, error: catError }, { data: jobs, error: jobError }, { data: intents, error: intentError }, { data: qboConnection, error: connectionError }] = await Promise.all([
    db.from("transaction_categorizations").select("transaction_id,business_id,status,review_status,posting_status,reason,final_qbo_account_id,final_qbo_account_name,post_after,post_error,last_post_attempt_at,posting_hold_batch_id,decided_by,decided_at,meta,qbo_txn_id,posted_at,excluded_at,is_archived,updated_at").eq("business_id", businessId).in("status", HANDLED).in("transaction_id", ids),
    db.from("bookkeeping_posting_jobs").select("transaction_id,state,scheduled_at,next_attempt_at,attempt_count,lease_owner,lease_expires_at,blocking_code,qbo_intent_id,qbo_request_id,qbo_txn_id,updated_at").eq("business_id", businessId).in("transaction_id", ids),
    db.from("qbo_posted_transactions").select("transaction_id,status,attempt_count,lease_owner,lease_expires_at,request_id,qbo_txn_id,qbo_txn_type,updated_at").eq("business_id", businessId).in("transaction_id", ids),
    db.from("quickbooks_tokens").select("realm_id,qbo_env,status,is_active").eq("business_id", businessId).eq("qbo_env", qboEnvName).eq("is_active", true).eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (catError) throw catError;
  if (jobError) throw jobError;
  if (intentError) throw intentError;
  if (connectionError) throw connectionError;
  const catById = new Map((cats || []).map((row) => [String(row.transaction_id), row]));
  const selectedBank = bounded.filter((row) => catById.has(String(row.id)));
  const accountIds = [...new Set(selectedBank.map((row) => row.plaid_account_id).filter(Boolean))];
  const qboIds = [...new Set((cats || []).map((row) => row.final_qbo_account_id).filter(Boolean).map(String))];
  const holdIds = [...new Set((cats || []).map((row) => row.posting_hold_batch_id).filter(Boolean))];
  const itemIds = [...new Set(selectedBank.map((row) => row.plaid_item_id).filter(Boolean))];
  const [{ data: sourceAccounts, error: accountError }, { data: sourceItems, error: itemError }, { data: mappings, error: mappingError }, { data: qboAccounts, error: qboError }, holdResult] = await Promise.all([
    db.from("plaid_accounts").select("plaid_account_id,plaid_item_id,plaid_env,name,official_name").eq("business_id", businessId).in("plaid_account_id", accountIds),
    db.from("plaid_items").select("plaid_item_id,plaid_env,status,is_active").eq("business_id", businessId).in("plaid_item_id", itemIds),
    db.from("plaid_qbo_account_mappings").select("plaid_account_id,qbo_account_id,qbo_account_type").eq("business_id", businessId).in("plaid_account_id", accountIds),
    qboConnection?.realm_id
      ? db.from("qbo_accounts_cache").select("qbo_account_id,name,account_type,active,qbo_env,realm_id").eq("business_id", businessId).eq("qbo_env", qboEnvName).eq("realm_id", qboConnection.realm_id).in("qbo_account_id", qboIds)
      : Promise.resolve({ data: [], error: null }),
    holdIds.length ? db.from("plaid_recovery_batches").select("id,posting_hold,status").eq("business_id", businessId).in("id", holdIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (accountError) throw accountError;
  if (itemError) throw itemError;
  if (mappingError) throw mappingError;
  if (qboError) throw qboError;
  if (holdResult.error) throw holdResult.error;
  return {
    rows: selectedBank.map((bank) => ({
      bank,
      cat: catById.get(String(bank.id)),
      job: (jobs || []).find((row) => String(row.transaction_id) === String(bank.id)) || null,
      intent: (intents || []).find((row) => String(row.transaction_id) === String(bank.id)) || null,
      sourceAccount: (sourceAccounts || []).find((row) => String(row.plaid_account_id) === String(bank.plaid_account_id)) || null,
      sourceItem: (sourceItems || []).find((row) => String(row.plaid_item_id) === String(bank.plaid_item_id)) || null,
      sourceMapping: (mappings || []).find((row) => String(row.plaid_account_id) === String(bank.plaid_account_id)) || null,
      qboAccount: (qboAccounts || []).find((row) => String(row.qbo_account_id) === String(catById.get(String(bank.id))?.final_qbo_account_id)) || null,
      recoveryBatch: (holdResult.data || []).find((row) => String(row.id) === String(catById.get(String(bank.id))?.posting_hold_batch_id)) || null,
    })),
    truncated: (bankRows || []).length > MAX_ROWS,
  };
}

export async function previewPostingEligibilityRecheck({ db, businessId, month, accountScope = null, transactionIds = [], limit = MAX_ROWS, nowMs = Date.now() } = {}) {
  if (!db || !businessId) throw new Error("business_id_required");
  const scoped = await rowsForScope({ db, businessId, month, accountScope, transactionIds, limit });
  const policy = await getAutoPostPolicy(db, businessId);
  const reevaluation = await reEvaluateAutoPostBacklog({
    db, businessId, rangeStart: monthBounds(month)[0], rangeEnd: monthBounds(month)[1],
    transactionIds: scoped.rows.map(({ cat }) => cat.transaction_id),
  });
  const automaticById = new Map((reevaluation.evaluations || []).map((row) => [String(row.transaction_id), row]));
  const result = {
    ok: true, business_id: businessId, month, account_scope: accountScope || null,
    auto_post_enabled: policy.enabled === true, examined: 0, truncated: scoped.truncated,
    counts: { eligible_to_schedule: 0, ready_auto_post_off: 0, already_scheduled: 0, processing: 0, retry_scheduled: 0, reconciling: 0, blocked: 0, returned_to_review: 0, failures: 0 },
    reason_counts: {}, rows: [],
  };
  for (const context of scoped.rows) {
    const { cat, bank, job } = context;
    result.examined += 1;
    let outcome;
    let why = hardBlock({ ...context, nowMs });
    const jobDue = Date.parse(job?.next_attempt_at || job?.scheduled_at || "");
    if (why === "already_posted") outcome = "blocked";
    else if (why === "qbo_receipt_requires_reconciliation" || why === "provider_reconciliation_required") outcome = "reconciling";
    else if (why === "active_provider_operation" || why === "active_worker_lease") outcome = "processing";
    else if (job?.state === "retry_scheduled" && jobDue > nowMs) { outcome = "retry_scheduled"; why = "retry_already_scheduled"; }
    else if (cat.post_after && Date.parse(cat.post_after) > nowMs && job?.state !== "failed") { outcome = "already_scheduled"; why = "valid_future_schedule"; }
    else if (!why) {
      const manual = durableManualAuthority(cat);
      const automatic = automaticById.get(String(cat.transaction_id));
      const automaticSafe = automatic?.category === "safe_new_post" || automatic?.category === "already_scheduled";
      if (!manual && !automaticSafe) {
        outcome = "returned_to_review";
        why = automatic?.reason || "automatic_posting_safety_not_established";
      } else {
        outcome = policy.enabled ? "eligible_to_schedule" : "ready_auto_post_off";
        why = manual ? "durable_manual_approval" : "current_automatic_safety_gates";
      }
    } else outcome = "blocked";
    count(result, outcome);
    reason(result, why);
    result.rows.push({
      transaction_id: cat.transaction_id,
      row_version: rowVersion(context),
      outcome,
      reason: why,
      date: bank.date,
      description: safeDescription(bank),
      amount: bank.amount,
      account_name: context.sourceAccount?.name || `Account ${String(bank.plaid_account_id || "").slice(-4)}`,
      selected_gl_account: cat.final_qbo_account_name || context.qboAccount?.name || null,
      expected_post_after: outcome === "eligible_to_schedule" ? computePostAfterForAutoPost(true, 24, nowMs) : cat.post_after || null,
      categorization_updated_at: cat.updated_at || null,
      current_meta: cat.meta || {},
    });
  }
  result.preview_version = previewVersion({ business_id: businessId, month, account_scope: accountScope, auto_post_enabled: result.auto_post_enabled }, result.rows);
  result.preview_id = result.preview_version;
  return result;
}

async function persistExecution(db, payload) {
  const { data, error } = await db.from("bookkeeping_posting_eligibility_rechecks").upsert(payload, { onConflict: "business_id,idempotency_key", ignoreDuplicates: true }).select("*").maybeSingle();
  if (error) throw error;
  if (data) return { row: data, created: true };
  const existing = await db.from("bookkeeping_posting_eligibility_rechecks").select("*").eq("business_id", payload.business_id).eq("idempotency_key", payload.idempotency_key).maybeSingle();
  if (existing.error) throw existing.error;
  return { row: existing.data, created: false };
}

export async function executePostingEligibilityRecheck({ db, businessId, month, accountScope = null, transactionIds = [], previewVersion: expectedVersion, idempotencyKey, actorId, requestId = crypto.randomUUID(), graceHours = 24, nowMs = Date.now() } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(idempotencyKey || ""))) {
    const error = new Error("valid_idempotency_key_required"); error.status = 400; error.code = "valid_idempotency_key_required"; throw error;
  }
  const existing = await db.from("bookkeeping_posting_eligibility_rechecks").select("*").eq("business_id", businessId).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data?.status !== "running") return { ...(existing.data.result || {}), idempotent: true, execution_id: existing.data.id };
  const preview = await previewPostingEligibilityRecheck({ db, businessId, month, accountScope, transactionIds, nowMs });
  if (!expectedVersion || expectedVersion !== preview.preview_version) {
    const error = new Error("posting_eligibility_preview_stale"); error.status = 409; error.code = "posting_eligibility_preview_stale"; error.preview = preview; throw error;
  }
  const persisted = await persistExecution(db, {
    business_id: businessId, review_month: `${month}-01`, account_scope: accountScope || null,
    preview_version: preview.preview_version, idempotency_key: idempotencyKey, status: "running",
    auto_post_enabled: preview.auto_post_enabled, grace_hours: graceHours, examined_count: preview.examined,
    requested_by: actorId || null, request_id: requestId,
  });
  const started = persisted.row;
  if (!persisted.created) {
    if (started?.status !== "running") return { ...(started?.result || {}), idempotent: true, execution_id: started?.id };
    return { ok: true, idempotent: true, in_progress: true, request_id: started?.request_id || requestId, execution_id: started?.id };
  }
  const result = { ok: true, request_id: requestId, execution_id: started.id, executed_at: new Date(nowMs).toISOString(), operator: actorId || null, examined: preview.examined, counts: {}, reason_counts: {}, rows: [] };
  const postAfter = computePostAfterForAutoPost(preview.auto_post_enabled, graceHours, nowMs);
  for (const row of preview.rows) {
    let outcome = row.outcome;
    try {
      if (outcome === "eligible_to_schedule" || outcome === "ready_auto_post_off") {
        const { data, error } = await db.from("transaction_categorizations").update({
          post_after: preview.auto_post_enabled ? postAfter : null,
          post_error: null,
          meta: {
            ...(row.current_meta || {}),
            safe_to_auto_post: true,
            posting_eligibility_rechecked_at: new Date(nowMs).toISOString(),
            posting_eligibility_recheck_execution_id: started.id,
            posting_eligibility_authority: row.reason,
          },
          updated_at: new Date(nowMs).toISOString(),
        }).eq("business_id", businessId).eq("transaction_id", row.transaction_id).eq("updated_at", row.categorization_updated_at).in("status", HANDLED).select("transaction_id");
        if (error) throw error;
        if (Array.isArray(data) && data.length === 0) outcome = "conflicted";
        else outcome = preview.auto_post_enabled ? "newly_scheduled" : "ready_auto_post_off";
      } else if (outcome === "returned_to_review") {
        const { data, error } = await db.from("transaction_categorizations").update({ status: "needs_review", post_after: null, post_error: null, meta: { ...(row.current_meta || {}), safe_to_auto_post: false, post_block_reason: row.reason, posting_eligibility_rechecked_at: new Date(nowMs).toISOString() }, updated_at: new Date(nowMs).toISOString() }).eq("business_id", businessId).eq("transaction_id", row.transaction_id).eq("updated_at", row.categorization_updated_at).in("status", HANDLED).select("transaction_id");
        if (error) throw error;
        if (Array.isArray(data) && data.length === 0) outcome = "conflicted";
      }
    } catch {
      outcome = "failed";
    }
    result.counts[outcome] = (result.counts[outcome] || 0) + 1;
    result.reason_counts[row.reason] = (result.reason_counts[row.reason] || 0) + 1;
    const safeRow = { ...row };
    delete safeRow.current_meta;
    delete safeRow.categorization_updated_at;
    result.rows.push({ ...safeRow, outcome, expected_post_after: outcome === "newly_scheduled" ? postAfter : null });
  }
  const failed = Number(result.counts.failed || 0) + Number(result.counts.conflicted || 0);
  const status = failed ? "partial" : "completed";
  const auditResult = {
    ok: result.ok,
    request_id: result.request_id,
    execution_id: result.execution_id,
    executed_at: result.executed_at,
    operator: result.operator,
    examined: result.examined,
    counts: result.counts,
    reason_counts: result.reason_counts,
    rows: result.rows.map(({ transaction_id, outcome, reason }) => ({ transaction_id, outcome, reason })),
  };
  const completed = await db.from("bookkeeping_posting_eligibility_rechecks").update({ status, outcome_counts: result.counts, reason_counts: result.reason_counts, result: auditResult, completed_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString() }).eq("id", started.id).eq("status", "running").select("id");
  if (completed.error) throw completed.error;
  return result;
}

export default { previewPostingEligibilityRecheck, executePostingEligibilityRecheck };
