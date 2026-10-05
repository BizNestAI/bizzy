import { computePostAfterForAutoPost, getAutoPostPolicy, reEvaluateAutoPostBacklog } from "./autoPostControl.js";
import { hasManualAccountAuthority, isProtectedPostingWorkflow } from "./postingDecisionAuthority.js";
import { hasFinalCategorizeAsNewResolution, isPreProviderIncomingDepositMatchFailure } from "./incomingDepositResolution.js";

const HANDLED_STATUSES = ["approved", "auto_approved", "failed", "handled"];

function reasonBucket(result, reason) {
  const key = reason || "unknown";
  result.reasons[key] = (result.reasons[key] || 0) + 1;
}

function hasActiveOperation(row = {}) {
  const meta = row.meta || {};
  return meta.posting_in_progress === true || Boolean(meta.post_intent_id || meta.active_operation_id || meta.operation_lease_owner);
}

function independentBlockReason(row = {}, bank = {}) {
  const meta = row.meta || {};
  if (bank.pending === true || meta.pending === true) return "pending_transaction_not_postable";
  if (row.qbo_txn_id || meta.matched_existing_qbo === true || meta.incoming_deposit_match_status === "confirmed") return "already_matched_or_posted";
  if (meta.possible_qbo_duplicate === true || meta.duplicate_risk === true) return "possible_qbo_duplicate";
  if (isProtectedPostingWorkflow(meta)) return "protected_special_workflow";
  const direction = String(bank.direction || "").toUpperCase();
  if ((direction === "INFLOW" || (!direction && Number(bank.amount || 0) > 0)) && !hasFinalCategorizeAsNewResolution(row)) return "inflow_resolution_required";
  if (!row.final_qbo_account_id) return "missing_final_qbo_account";
  return null;
}

async function loadCandidates(db, businessId, limit, transactionIds = []) {
  let query = db
    .from("transaction_categorizations")
    .select("transaction_id,business_id,status,reason,final_qbo_account_id,final_qbo_account_name,post_after,post_error,last_post_attempt_at,meta,qbo_txn_id,updated_at")
    .eq("business_id", businessId)
    .in("status", HANDLED_STATUSES)
    .is("qbo_txn_id", null);
  if (transactionIds.length) query = query.in("transaction_id", transactionIds);
  const { data, error } = await query.limit(limit);
  if (error) throw error;
  return (data || []).filter((row) => !row.post_after || row.post_error || row.meta?.safe_to_auto_post !== true);
}

async function loadBankRows(db, businessId, transactionIds) {
  if (!transactionIds.length) return new Map();
  const { data, error } = await db
    .from("bank_transactions")
    .select("id,business_id,date,amount,direction,pending,is_archived,plaid_account_id,name,merchant_name,counterparty_name,transaction_type,merchant_entity_id,qbo_entity_type,qbo_entity_id,check_number,category_primary,personal_finance_category,accounting_review_required")
    .eq("business_id", businessId)
    .in("id", transactionIds);
  if (error) throw error;
  return new Map((data || []).map((row) => [row.id, row]));
}

async function persistPatch(db, businessId, transactionId, updatedAt, patch) {
  const query = db
    .from("transaction_categorizations")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("updated_at", updatedAt);
  const { data, error } = typeof query.select === "function" ? await query.select("transaction_id") : await query;
  if (error) throw error;
  return !Array.isArray(data) || data.length > 0;
}

/**
 * Repairs legacy Handled rows which have no durable posting disposition.
 * This routine is deliberately bounded and database-only: it never contacts or
 * writes to QuickBooks. The existing categorization trigger creates/updates the
 * posting job in the same database transaction as a recovered schedule.
 */
export async function recoverHandledPostingDispositions({
  db,
  businessId,
  limit = 100,
  graceHours = 24,
  nowMs = Date.now(),
  transactionIds = [],
} = {}) {
  if (!db || !businessId) throw new Error("business_id_required");
  const selectedIds = Array.from(new Set((transactionIds || []).filter(Boolean).map(String))).slice(0, 25);
  const boundedLimit = selectedIds.length || Math.max(1, Math.min(Number(limit) || 25, 25));
  const result = {
    business_id: businessId,
    examined: 0,
    eligible: 0,
    scheduled: 0,
    review_required: 0,
    skipped: 0,
    conflicted: 0,
    reasons: {},
  };
  const policy = await getAutoPostPolicy(db, businessId);
  const rows = await loadCandidates(db, businessId, boundedLimit, selectedIds);
  const bankById = await loadBankRows(db, businessId, rows.map((row) => row.transaction_id));
  const reevaluation = await reEvaluateAutoPostBacklog({
    db,
    businessId,
    transactionIds: rows.map((row) => row.transaction_id),
  });
  const evaluationById = new Map((reevaluation.evaluations || []).map((row) => [row.transaction_id, row]));
  const postAfter = computePostAfterForAutoPost(policy.enabled === true, graceHours, nowMs);

  for (const row of rows) {
    result.examined += 1;
    const bank = bankById.get(row.transaction_id);
    if (!bank || bank.is_archived === true) {
      result.skipped += 1;
      reasonBucket(result, !bank ? "bank_transaction_missing" : "archived_transaction");
      continue;
    }
    if (hasActiveOperation(row)) {
      result.skipped += 1;
      reasonBucket(result, "active_operation");
      continue;
    }
    const block = independentBlockReason(row, bank);
    const manual = hasManualAccountAuthority(row);
    const evaluation = evaluationById.get(row.transaction_id);
    const automatedSafe = evaluation?.category === "safe_new_post" || evaluation?.category === "already_scheduled";

    if (!block && postAfter && (manual || automatedSafe)) {
      result.eligible += 1;
      const meta = {
        ...(row.meta || {}),
        safe_to_auto_post: true,
        posting_disposition_recovered_at: new Date(nowMs).toISOString(),
        posting_disposition_recovery: manual ? "final_manual_approval" : "current_automatic_safety_gates",
      };
      if (manual && ["weak_memo_evidence", "probable_requires_review", "low_classifier_confidence"].includes(String(row.post_error || ""))) {
        meta.superseded_automated_review_reason = row.post_error;
      }
      if (hasFinalCategorizeAsNewResolution(row) && isPreProviderIncomingDepositMatchFailure(row)) {
        meta.superseded_pre_provider_failure = "incoming_deposit_needs_match";
        delete meta.post_block_reason;
        delete meta.auto_post_block_reason;
      }
      const changed = await persistPatch(db, businessId, row.transaction_id, row.updated_at, {
        status: manual ? "approved" : "auto_approved",
        post_after: postAfter,
        post_error: null,
        meta,
      });
      if (changed) {
        result.scheduled += 1;
        reasonBucket(result, manual ? "manual_approval_scheduled" : "automatic_safety_revalidated");
      } else {
        result.conflicted += 1;
        reasonBucket(result, "concurrent_change");
      }
      continue;
    }

    if (manual) {
      result.skipped += 1;
      reasonBucket(result, block || (policy.enabled ? "manual_approval_requires_operator_review" : "auto_post_disabled"));
      continue;
    }

    const reviewReason = block || evaluation?.reason || (policy.enabled ? "automatic_posting_safety_not_established" : "auto_post_disabled");
    const changed = await persistPatch(db, businessId, row.transaction_id, row.updated_at, {
      status: "needs_review",
      final_qbo_account_id: null,
      final_qbo_account_name: null,
      post_after: null,
      post_error: null,
      meta: {
        ...(row.meta || {}),
        safe_to_auto_post: false,
        post_block_reason: reviewReason,
        posting_disposition_recovered_at: new Date(nowMs).toISOString(),
        posting_disposition_recovery: "returned_to_review",
      },
    });
    if (changed) {
      result.review_required += 1;
      reasonBucket(result, reviewReason);
    } else {
      result.conflicted += 1;
      reasonBucket(result, "concurrent_change");
    }
  }
  return result;
}

export default { recoverHandledPostingDispositions };
