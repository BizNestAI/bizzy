import crypto from "node:crypto";
import { computePostAfterForAutoPost, getAutoPostPolicy, reEvaluateAutoPostBacklog } from "./autoPostControl.js";
import { hasManualAccountAuthority } from "./postingDecisionAuthority.js";
import { hasAuthorizedMonthlyReviewApproval } from "./manualPostingAuthority.js";
import { buildMonthlyReviewManualApproval, MONTHLY_REVIEW_BULK_APPROVAL_SOURCE } from "./manualPostingAuthority.js";
import { approveBookkeepingTransactions } from "./bookkeepingApprovalService.js";
import { isBulkApprovablePostingReason } from "./postingEligibilityApprovalPolicy.js";
import { resolveCompletedPostingEligibilityExecution } from "./postingEligibilityExecutionState.js";
import { hasFinalCategorizeAsNewResolution } from "./incomingDepositResolution.js";
import { qboEnvName } from "../../utils/qboEnv.js";
import { resolveMissingFinalAccount } from "./handledFinalAccountInvariant.js";
import { applySpecializedTypeAuthority, hasFinalSpecializedTypeAuthority, supersedeProvisionalClassification } from "./specializedTypeAuthority.js";
import { deterministicStatementCreditDecision } from "./rewardCreditPolicy.js";

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

function recoveryCounts(rows = []) {
  const outcomes = (names) => rows.filter((row) => names.includes(row.outcome)).length;
  return {
    examined: rows.length,
    eligible: outcomes(["eligible_to_schedule", "ready_auto_post_off", "newly_scheduled", "manually_approved_scheduled", "manually_approved_auto_post_off"]),
    scheduled: outcomes(["newly_scheduled", "manually_approved_scheduled", "already_scheduled", "retry_scheduled"]),
    retryable: rows.filter((row) => row.outcome === "retry_scheduled" || row.reason === "retry_already_scheduled").length,
    still_blocked: outcomes(["blocked", "hard_blocked", "returned_to_review", "categorized_requires_approval"]),
    specialized: rows.filter((row) => String(row.reason || "").endsWith("_workflow_protected")).length,
    already_active: outcomes(["processing", "reconciling"]),
    failed: outcomes(["failed", "conflicted"]),
  };
}

function safeDescription(row = {}) {
  return String(row.merchant_name || row.counterparty_name || row.name || "Transaction").slice(0, 120);
}

function approvalSource(cat = {}) {
  return cat.meta?.categorization_source || cat.meta?.accounting_decision_source || cat.decided_by || "existing_categorization";
}

function vendorRuleIdentity(bank = {}) {
  if (bank.merchant_entity_id) return `entity:${String(bank.merchant_entity_id)}`;
  const merchant = String(bank.merchant_name || bank.counterparty_name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return merchant.length >= 3 ? `merchant:${merchant}` : null;
}

function rowVersion({ cat, bank, job, intent }) {
  return crypto.createHash("sha256").update(JSON.stringify({
    transaction_id: cat.transaction_id,
    categorization_updated_at: cat.updated_at || null,
    bank_updated_at: bank.updated_at || null,
    status: cat.status || null,
    account: cat.final_qbo_account_id || null,
    suggested_account: cat.suggested_qbo_account_id || null,
    suggested_name: cat.suggested_qbo_account_name || null,
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
  if (hasFinalSpecializedTypeAuthority(cat)) return true;
  const approval = cat.meta?.manual_approval;
  if (hasAuthorizedMonthlyReviewApproval(cat)) {
    return String(approval.business_id) === String(cat.business_id) &&
      String(approval.transaction_id) === String(cat.transaction_id) &&
      String(approval.selected_qbo_account_id) === String(cat.final_qbo_account_id);
  }
  return hasManualAccountAuthority(cat) && Boolean(cat.decided_by && cat.decided_at && cat.final_qbo_account_id);
}

function hardBlock({ cat, bank, job, intent, sourceAccount, sourceItem, sourceMapping, qboAccount, accountRepair, recoveryBatch, nowMs }) {
  cat = applySpecializedTypeAuthority(cat);
  const meta = cat.meta || {};
  // possible_qbo_duplicate remains an advisory signal here; only durable,
  // deterministic linkage below is a non-overridable duplicate blocker.
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
  const exactDuplicate =
    meta.matched_existing_qbo === true ||
    meta.existing_qbo_match_confirmed === true ||
    meta.qbo_duplicate_detection_confidence === "DETERMINISTIC_EXISTING" ||
    (Array.isArray(meta.qbo_duplicate_candidates) && meta.qbo_duplicate_candidates.some((candidate) => candidate?.deterministic === true));
  if (exactDuplicate) return "confirmed_qbo_duplicate";
  const taxonomy = String(meta.taxonomy_type || "").toLowerCase();
  if (SPECIAL_TAXONOMIES.has(taxonomy)) return `${taxonomy || "special"}_workflow_protected`;
  const inflow = String(bank.direction || "").toUpperCase() === "INFLOW" || (!bank.direction && Number(bank.amount || 0) > 0);
  if (inflow && !hasFinalCategorizeAsNewResolution(cat)) return "incoming_deposit_resolution_required";
  if (["unresolved", "ambiguous"].includes(accountRepair?.kind)) return accountRepair.reason;
  if (!cat.final_qbo_account_id && accountRepair?.kind !== "resolved") return "missing_final_qbo_account_unresolved";
  if (!qboAccount || qboAccount.active === false) return "invalid_or_inactive_qbo_account";
  if (!sourceMapping?.qbo_account_id) return "missing_source_qbo_mapping";
  // Plaid connection state controls future ingestion only. Already-imported
  // transactions remain postable through their independently validated QBO mapping.
  if (!sourceAccount || !sourceItem) return "source_account_missing";
  if (String(bank.plaid_env || "") !== String(sourceAccount.plaid_env || "") || String(sourceItem.plaid_env || "") !== String(sourceAccount.plaid_env || "")) return "source_environment_mismatch";
  return null;
}

async function rowsForScope({ db, businessId, month, accountScope = null, transactionIds = [], limit = MAX_ROWS }) {
  const [start, end] = monthBounds(month);
  let bankQuery = db.from("bank_transactions")
    .select("id,business_id,plaid_item_id,plaid_env,plaid_account_id,date,amount,direction,pending,is_archived,name,merchant_name,counterparty_name,merchant_entity_id,updated_at")
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
    db.from("transaction_categorizations").select("transaction_id,business_id,status,review_status,posting_status,reason,suggested_qbo_account_id,suggested_qbo_account_name,suggested_canonical_account_key,final_qbo_account_id,final_qbo_account_name,final_canonical_account_key,post_after,post_error,last_post_attempt_at,posting_hold_batch_id,decided_by,decided_at,meta,qbo_txn_id,posted_at,excluded_at,is_archived,updated_at").eq("business_id", businessId).in("status", HANDLED).in("transaction_id", ids),
    db.from("bookkeeping_posting_jobs").select("transaction_id,state,scheduled_at,next_attempt_at,attempt_count,lease_owner,lease_expires_at,blocking_code,qbo_intent_id,qbo_request_id,qbo_txn_id,updated_at").eq("business_id", businessId).in("transaction_id", ids),
    db.from("qbo_posted_transactions").select("transaction_id,status,attempt_count,lease_expires_at,request_id,qbo_txn_id,qbo_txn_type,updated_at").eq("business_id", businessId).in("transaction_id", ids),
    db.from("quickbooks_tokens").select("realm_id,qbo_env,status,is_active").eq("business_id", businessId).eq("qbo_env", qboEnvName).eq("is_active", true).eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (catError) throw catError;
  if (jobError) throw jobError;
  if (intentError) throw intentError;
  if (connectionError) throw connectionError;
  const catById = new Map((cats || []).map((row) => [String(row.transaction_id), row]));
  const selectedBank = bounded.filter((row) => catById.has(String(row.id)));
  const accountIds = [...new Set(selectedBank.map((row) => row.plaid_account_id).filter(Boolean))];
  const holdIds = [...new Set((cats || []).map((row) => row.posting_hold_batch_id).filter(Boolean))];
  const itemIds = [...new Set(selectedBank.map((row) => row.plaid_item_id).filter(Boolean))];
  const [{ data: sourceAccounts, error: accountError }, { data: sourceItems, error: itemError }, { data: mappings, error: mappingError }, { data: qboAccounts, error: qboError }, holdResult] = await Promise.all([
    db.from("plaid_accounts").select("plaid_account_id,plaid_item_id,plaid_env,name,official_name").eq("business_id", businessId).in("plaid_account_id", accountIds),
    db.from("plaid_items").select("plaid_item_id,plaid_env,status,is_active").eq("business_id", businessId).in("plaid_item_id", itemIds),
    db.from("plaid_qbo_account_mappings").select("plaid_account_id,qbo_account_id,qbo_account_type").eq("business_id", businessId).in("plaid_account_id", accountIds),
    qboConnection?.realm_id
      ? db.from("qbo_accounts_cache").select("qbo_account_id,name,fully_qualified_name,account_type,account_subtype,active,qbo_env,realm_id").eq("business_id", businessId).eq("qbo_env", qboEnvName).eq("realm_id", qboConnection.realm_id).eq("active", true).limit(1000)
      : Promise.resolve({ data: [], error: null }),
    holdIds.length ? db.from("plaid_recovery_batches").select("id,posting_hold,status").eq("business_id", businessId).in("id", holdIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (accountError) throw accountError;
  if (itemError) throw itemError;
  if (mappingError) throw mappingError;
  if (qboError) throw qboError;
  if (holdResult.error) throw holdResult.error;
  return {
    rows: selectedBank.map((bank) => {
      const storedCat = catById.get(String(bank.id));
      const sourceMapping = (mappings || []).find((row) => String(row.plaid_account_id) === String(bank.plaid_account_id)) || null;
      const deterministicDecision = deterministicStatementCreditDecision({
        ...bank,
        account_type: sourceMapping?.qbo_account_type,
      }, storedCat, {
        accountId: storedCat.final_qbo_account_id,
        accountName: storedCat.final_qbo_account_name,
        source: "posting_eligibility_recheck",
      });
      const cat = deterministicDecision && !hasFinalSpecializedTypeAuthority(storedCat)
        ? {
            ...storedCat,
            post_error: null,
            meta: {
              ...supersedeProvisionalClassification(storedCat.meta || {}, {
                finalType: deterministicDecision.canonical_type,
                actor: "bizzi",
                timestamp: deterministicDecision.decided_at,
                source: deterministicDecision.operator_source,
                decisionVersion: deterministicDecision.decision_version,
              }),
              user_selected_resolution: "credit_card_statement_credit",
              qbo_disposition: "categorize_as_new",
              credit_card_inflow_resolution: deterministicDecision,
              safe_to_auto_handle: true,
              safe_to_auto_post: true,
            },
            deterministic_statement_credit_recovery_required: true,
          }
        : storedCat;
      const accountRepair = resolveMissingFinalAccount({ categorization: cat, bankTransaction: bank, qboAccounts: qboAccounts || [] });
      const validatedFinal = (qboAccounts || []).find((row) => String(row.qbo_account_id) === String(cat.final_qbo_account_id)) || null;
      const effectiveAccountId = accountRepair.kind === "resolved" ? accountRepair.account?.qbo_account_id : validatedFinal?.qbo_account_id;
      return ({
      bank,
      cat: applySpecializedTypeAuthority(cat),
      job: (jobs || []).find((row) => String(row.transaction_id) === String(bank.id)) || null,
      intent: (intents || []).find((row) => String(row.transaction_id) === String(bank.id)) || null,
      sourceAccount: (sourceAccounts || []).find((row) => String(row.plaid_account_id) === String(bank.plaid_account_id)) || null,
      sourceItem: (sourceItems || []).find((row) => String(row.plaid_item_id) === String(bank.plaid_item_id)) || null,
      sourceMapping,
      accountRepair,
      qboAccount: (qboAccounts || []).find((row) => String(row.qbo_account_id) === String(effectiveAccountId)) || null,
      recoveryBatch: (holdResult.data || []).find((row) => String(row.id) === String(catById.get(String(bank.id))?.posting_hold_batch_id)) || null,
    }); }),
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
    counts: { eligible_to_schedule: 0, ready_auto_post_off: 0, already_scheduled: 0, processing: 0, retry_scheduled: 0, reconciling: 0, blocked: 0, returned_to_review: 0, failed: 0 },
    reason_counts: {}, rows: [],
  };
  for (const context of scoped.rows) {
    const { cat, bank, job } = context;
    result.examined += 1;
    let outcome = "failed";
    let why = "posting_eligibility_row_evaluation_failed";
    try {
      why = hardBlock({ ...context, nowMs });
      const jobDue = Date.parse(job?.next_attempt_at || job?.scheduled_at || "");
      if (why === "already_posted") outcome = "blocked";
      else if (why === "qbo_receipt_requires_reconciliation" || why === "provider_reconciliation_required") outcome = "reconciling";
      else if (why === "active_provider_operation" || why === "active_worker_lease") outcome = "processing";
      else if (job?.state === "retry_scheduled" && jobDue > nowMs) { outcome = "retry_scheduled"; why = "retry_already_scheduled"; }
      else if (cat.final_qbo_account_id && cat.post_after && Date.parse(cat.post_after) > nowMs && job?.state !== "failed") { outcome = "already_scheduled"; why = "valid_future_schedule"; }
      else if (!why) {
        const manual = durableManualAuthority(cat);
        const automatic = automaticById.get(String(cat.transaction_id));
        const automaticSafe = automatic?.category === "safe_new_post" || automatic?.category === "already_scheduled";
        const ordinaryPersistedAuthority =
          Boolean(cat.final_qbo_account_id || context.accountRepair?.account?.qbo_account_id) &&
          String(bank.direction || "").toUpperCase() === "OUTFLOW" &&
          !String(cat.meta?.taxonomy_type || "").trim();
        if (!manual && !automaticSafe && !ordinaryPersistedAuthority) {
          why = automatic?.reason || "automatic_posting_safety_not_established";
          outcome = isBulkApprovablePostingReason(why) && cat.final_qbo_account_id
            ? "categorized_requires_approval"
            : "returned_to_review";
        } else {
          outcome = policy.enabled ? "eligible_to_schedule" : "ready_auto_post_off";
          why = manual
            ? "durable_manual_approval"
            : context.accountRepair?.kind === "resolved"
              ? "repaired_missing_final_gl_from_authoritative_categorization"
              : ordinaryPersistedAuthority ? "final_persisted_gl_authority" : "current_automatic_safety_gates";
        }
      } else outcome = String(why || "").startsWith("missing_final_qbo_account_") ? "returned_to_review" : "blocked";
    } catch {
      // A corrupt historical row is reportable, but must not abort the bounded preview.
    }
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
      selected_gl_account_id: cat.final_qbo_account_id || context.qboAccount?.qbo_account_id || null,
      final_account_repair: context.accountRepair?.kind === "resolved" ? {
        account_id: context.qboAccount?.qbo_account_id,
        account_name: context.qboAccount?.name,
        canonical_account_key: cat.suggested_canonical_account_key || null,
        authority: context.accountRepair.authority,
      } : null,
      missing_final_repair_required: context.accountRepair?.kind !== "not_required",
      approval_source: approvalSource(cat),
      may_learn_vendor_rule: Boolean(bank.merchant_name || bank.counterparty_name || bank.merchant_entity_id),
      vendor_rule_identity: vendorRuleIdentity(bank),
      expected_post_after: outcome === "eligible_to_schedule" ? computePostAfterForAutoPost(true, 24, nowMs) : cat.post_after || null,
      categorization_updated_at: cat.updated_at || null,
      current_meta: cat.meta || {},
      deterministic_statement_credit_recovery_required: cat.deterministic_statement_credit_recovery_required === true,
    });
  }
  result.preview_version = previewVersion({ business_id: businessId, month, account_scope: accountScope, auto_post_enabled: result.auto_post_enabled }, result.rows);
  result.preview_id = result.preview_version;
  result.recovery_counts = recoveryCounts(result.rows);
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

export async function executePostingEligibilityRecheck({ db, businessId, month, accountScope = null, transactionIds = [], previewVersion: expectedVersion, idempotencyKey, actorId, requestId = crypto.randomUUID(), graceHours = 24, nowMs = Date.now(), scheduleAutomaticallyEligible = true, manualApprovals = [] } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(idempotencyKey || ""))) {
    const error = new Error("valid_idempotency_key_required"); error.status = 400; error.code = "valid_idempotency_key_required"; throw error;
  }
  const existing = await db.from("bookkeeping_posting_eligibility_rechecks").select("*").eq("business_id", businessId).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existing.error) throw existing.error;
  const completedExecution = resolveCompletedPostingEligibilityExecution(existing.data);
  if (completedExecution) return completedExecution;
  const preview = await previewPostingEligibilityRecheck({ db, businessId, month, accountScope, transactionIds, nowMs });
  if (!expectedVersion) {
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
  const manualById = new Map((manualApprovals || []).map((approval) => [String(approval.transaction_id), approval]));
  const selectedRows = preview.rows.filter((row) => manualById.has(String(row.transaction_id)));
  const learningGroups = new Map();
  for (const row of selectedRows) {
    const request = manualById.get(String(row.transaction_id));
    if (request?.learn_reusable_rule !== true || !row.vendor_rule_identity) continue;
    const group = learningGroups.get(row.vendor_rule_identity) || [];
    group.push(row);
    learningGroups.set(row.vendor_rule_identity, group);
  }
  const conflictingRuleRows = new Set();
  const ruleLearningLeaders = new Set();
  for (const group of learningGroups.values()) {
    const accounts = new Set(group.map((row) => String(row.selected_gl_account_id || "")));
    if (accounts.size > 1) group.forEach((row) => conflictingRuleRows.add(String(row.transaction_id)));
    else if (group[0]) ruleLearningLeaders.add(String(group[0].transaction_id));
  }
  for (const row of preview.rows) {
    let outcome = row.outcome;
    try {
      const manualRequest = manualById.get(String(row.transaction_id));
      if (manualRequest) manualById.delete(String(row.transaction_id));
      if (manualRequest) {
        if (conflictingRuleRows.has(String(row.transaction_id))) {
          outcome = "failed";
          row.reason = "conflicting_vendor_rule_categories";
        } else if (row.outcome !== "categorized_requires_approval" || !isBulkApprovablePostingReason(row.reason)) {
          outcome = "hard_blocked";
        } else if (manualRequest.row_version !== row.row_version) {
          outcome = "conflicted";
        } else {
          const manualApproval = buildMonthlyReviewManualApproval({
            item: { business_id: businessId, transaction_id: row.transaction_id, meta: row.current_meta },
            businessId, transactionId: row.transaction_id, actorId,
            selectedQboAccountId: row.selected_gl_account_id,
            selectedQboAccountName: row.selected_gl_account,
            operationId: started.id, idempotencyKey,
            source: MONTHLY_REVIEW_BULK_APPROVAL_SOURCE,
            previousCategorizationSource: row.approval_source,
            overrideReason: row.reason,
            previewId: expectedVersion,
            executionId: started.id,
          });
          const approval = await approveBookkeepingTransactions({
            businessId,
            items: [{
              txnId: row.transaction_id,
              status: "approved",
              resolution: "categorize_new",
              newAccountId: row.selected_gl_account_id,
              newAccountName: row.selected_gl_account,
              learn_reusable_rule: manualRequest.learn_reusable_rule === true && ruleLearningLeaders.has(String(row.transaction_id)),
              only_this_transaction: manualRequest.learn_reusable_rule !== true || !ruleLearningLeaders.has(String(row.transaction_id)),
              reason: "Approved current category from Monthly Review posting eligibility.",
              idempotency_context: `posting-eligibility:${idempotencyKey}`,
            }],
            actorId,
            actorType: "admin",
            source: MONTHLY_REVIEW_BULK_APPROVAL_SOURCE,
            requireNeedsReview: false,
            extraMetaByTransactionId: { [row.transaction_id]: { manual_approval: manualApproval } },
            db,
          });
          const vendorResult = approval.vendor_rule_results?.[0] || null;
          outcome = preview.auto_post_enabled ? "manually_approved_scheduled" : "manually_approved_auto_post_off";
          row.vendor_rule_learned = vendorResult?.ok === true && vendorResult?.skipped !== true;
          row.vendor_rule_retry_queued = vendorResult?.queued === true;
          if (row.vendor_rule_learned) result.counts.vendor_rules_learned = (result.counts.vendor_rules_learned || 0) + 1;
          if (row.vendor_rule_retry_queued) result.counts.learning_retries_queued = (result.counts.learning_retries_queued || 0) + 1;
        }
      } else if ((outcome === "eligible_to_schedule" || outcome === "ready_auto_post_off") && scheduleAutomaticallyEligible === true && expectedVersion === preview.preview_version) {
        const { data, error } = await db.from("transaction_categorizations").update({
          ...(row.final_account_repair ? {
            final_qbo_account_id: row.final_account_repair.account_id,
            final_qbo_account_name: row.final_account_repair.account_name,
            final_canonical_account_key: row.final_account_repair.canonical_account_key,
          } : {}),
          post_after: preview.auto_post_enabled ? postAfter : null,
          post_error: null,
          meta: {
            ...(row.current_meta || {}),
            safe_to_auto_post: true,
            posting_eligibility_rechecked_at: new Date(nowMs).toISOString(),
            posting_eligibility_recheck_execution_id: started.id,
            posting_eligibility_authority: row.reason,
            ...(row.final_account_repair ? {
              handled_final_account_invariant: "repaired_from_authoritative_categorization",
              final_account_repair_authority: row.final_account_repair.authority,
              final_account_repaired_at: new Date(nowMs).toISOString(),
              post_block_reason: null,
            } : {}),
          },
          updated_at: new Date(nowMs).toISOString(),
        }).eq("business_id", businessId).eq("transaction_id", row.transaction_id).eq("updated_at", row.categorization_updated_at).in("status", HANDLED).select("transaction_id");
        if (error) throw error;
        if (Array.isArray(data) && data.length === 0) outcome = "conflicted";
        else outcome = preview.auto_post_enabled ? "newly_scheduled" : "ready_auto_post_off";
      } else if (outcome === "returned_to_review" && row.missing_final_repair_required && expectedVersion === preview.preview_version) {
        const { data, error } = await db.from("transaction_categorizations").update({
          status: "needs_review",
          review_status: "needs_review",
          post_after: null,
          post_error: null,
          decided_by: null,
          decided_at: null,
          meta: {
            ...(row.current_meta || {}),
            safe_to_auto_handle: false,
            safe_to_auto_post: false,
            post_block_reason: row.reason,
            handled_final_account_invariant: "returned_to_review_unresolved_final_account",
            posting_eligibility_recheck_execution_id: started.id,
          },
          updated_at: new Date(nowMs).toISOString(),
        }).eq("business_id", businessId).eq("transaction_id", row.transaction_id).eq("updated_at", row.categorization_updated_at).in("status", HANDLED).select("transaction_id");
        if (error) throw error;
        if (Array.isArray(data) && data.length === 0) outcome = "conflicted";
      } else if ((outcome === "eligible_to_schedule" || outcome === "ready_auto_post_off") && scheduleAutomaticallyEligible === true) {
        outcome = "conflicted";
      }
    } catch (error) {
      outcome = "failed";
      row.reason = error?.error || error?.code || "posting_eligibility_row_execution_failed";
    }
    result.counts[outcome] = (result.counts[outcome] || 0) + 1;
    result.reason_counts[row.reason] = (result.reason_counts[row.reason] || 0) + 1;
    const safeRow = { ...row };
    delete safeRow.current_meta;
    delete safeRow.categorization_updated_at;
    result.rows.push({ ...safeRow, outcome, expected_post_after: ["newly_scheduled", "manually_approved_scheduled"].includes(outcome) ? postAfter : null });
  }
  for (const transactionId of manualById.keys()) {
    result.counts.hard_blocked = (result.counts.hard_blocked || 0) + 1;
    result.reason_counts.transaction_outside_authoritative_scope = (result.reason_counts.transaction_outside_authoritative_scope || 0) + 1;
    result.rows.push({ transaction_id: transactionId, outcome: "hard_blocked", reason: "transaction_outside_authoritative_scope", expected_post_after: null });
  }
  result.recovery_counts = recoveryCounts(result.rows);
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
