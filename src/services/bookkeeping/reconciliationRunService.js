// Reconciliation Run Engine (posting integrity) — not bank-statement reconciliation.
// Evaluates Plaid bank_transactions + Bizzi categ/posting metadata to populate reconciliation_runs + reconciliation_items.

import { supabase } from "../supabaseAdmin.js";
import { applyActiveBookkeepingScope, getBookkeepingStartDate } from "./bookkeepingScope.js";
import { derivePipelineStatus, hasProvenPostingFailure } from "./reconciliationPipelineStatus.js";

const CHUNK_SIZE = 500;
const NOW = () => new Date().toISOString();

const DEFAULT_SCOPE = "last_30_days";
const SCOPES = {
  last_30_days: 30,
  last_90_days: 90,
  this_month: null, // handled specially
};

function devLog(tag, payload) {
  if (process.env.NODE_ENV !== "production") {
    console.info("[reconciliationRun]", tag, payload);
  }
}

function isMissingRelationError(err) {
  const message = String(err?.message || err || "").toLowerCase();
  return message.includes("does not exist") || message.includes("relation") || err?.code === "42P01";
}

function normalizeDate(d) {
  if (!d) return null;
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(String(d));
  return ok ? d : null;
}

function computeRange(scope) {
  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  if (scope === "this_month") {
    const start = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
    return { start, end };
  }
  const days = SCOPES[scope] || SCOPES[DEFAULT_SCOPE];
  const startDate = new Date(today.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { start: startDate, end };
}

function normalizeDirection(txn) {
  const dir = (txn?.direction || "").toUpperCase();
  if (dir === "INFLOW") return "inflow";
  if (dir === "OUTFLOW") return "outflow";
  const signed = Number(txn?.signed_amount);
  if (Number.isFinite(signed)) return signed > 0 ? "inflow" : signed < 0 ? "outflow" : "unknown";
  const amt = Number(txn?.amount);
  if (Number.isFinite(amt)) return amt > 0 ? "inflow" : amt < 0 ? "outflow" : "unknown";
  return "unknown";
}

function safeParseDate(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function nullable(value) {
  return value === undefined ? null : value;
}

function isApprovedLike(cat = {}) {
  const statusLower = String(cat?.status || "").toLowerCase();
  return statusLower === "approved" || statusLower === "auto_approved";
}

function deriveSourceOfTruth(cat = {}) {
  if (cat?.qbo_txn_id) return "qbo";
  if (isApprovedLike(cat)) return "bizzi_proxy";
  return "unknown";
}

function deriveReconciliationConfidence({ cat, statusMeta }) {
  const status = String(statusMeta?.status || "").toLowerCase();
  if (cat?.qbo_txn_id) return "high";
  if (isApprovedLike(cat)) return "medium";
  if (["needs_review", "failed_post", "missing_in_qbo"].includes(status)) return "low";
  return "low";
}

function deriveDuplicateSource({ bank, statusMeta }) {
  if (statusMeta?.status === "duplicate_internal") return "reconciliation_safety";
  if (statusMeta?.status === "duplicate_in_qbo") return "qbo_duplicate";
  if (bank?.pending_transaction_id) return "pending_merge";
  if (bank?.duplicate_fingerprint) return "plaid_replay";
  return null;
}

function derivePipelineBucket({ bank, statusMeta }) {
  if (bank?.is_archived === true) return "ingestion";
  switch (statusMeta?.status) {
    case "archived":
      return "ingestion";
    case "duplicate_internal":
      return "ingestion";
    case "pending":
      return "ingestion";
    case "needs_review":
      return "categorization";
    case "approved_waiting_post":
      return "posting";
    case "matched":
    case "duplicate_in_qbo":
      return "reconciliation";
    case "failed_post":
    case "missing_in_qbo":
      return "posting";
    default:
      return "categorization";
  }
}

function deriveCanonicalState(bank = {}) {
  if (bank?.is_archived === true) return "archived";
  if (bank?.pending === true) return "pending_candidate";
  if (bank?.pending_transaction_id) return "merged_from_pending";
  return "canonical";
}

function derivePostingState(cat = {}, nowTs) {
  if (!cat) return "not_categorized";

  const statusLower = String(cat?.status || "").toLowerCase();
  const hasQbo = Boolean(cat?.qbo_txn_id);
  const hasPostedAt = Boolean(cat?.posted_at);
  const hasReconciled = Boolean(cat?.reconciled_at);
  const postAfterTs = safeParseDate(cat?.post_after);
  const nextAttemptTs = safeParseDate(cat?.meta?.next_post_attempt_at);
  const postingInProgress = cat?.meta?.posting_in_progress === true;

  if (hasQbo || hasPostedAt || hasReconciled || statusLower === "posted") return "posted_to_qbo";
  if (statusLower === "failed") return "failed_post";
  if (cat?.post_error) return "post_error";
  if (postingInProgress) return "posting_in_progress";
  if (postAfterTs && postAfterTs > nowTs) return "queued_for_posting";
  if (nextAttemptTs && nextAttemptTs > nowTs) return "retry_scheduled";
  if ((statusLower === "approved" || statusLower === "auto_approved") && !postAfterTs && !nextAttemptTs) {
    return "missing_post_schedule";
  }
  if (statusLower === "approved" || statusLower === "auto_approved") return "approved_not_posted";
  if (statusLower === "needs_review" || statusLower === "uncategorized" || !statusLower) return "awaiting_review";
  return "unknown";
}

function deriveLifecycleStage({ bank, cat, statusMeta, nowTs }) {
  const canonicalState = deriveCanonicalState(bank);
  const postingState = derivePostingState(cat, nowTs);

  if (statusMeta?.status === "archived") return "archived";
  if (statusMeta?.status === "duplicate_internal") return "archived";
  if (canonicalState === "archived") return "archived";
  if (statusMeta?.status === "matched") return "posted_and_reconciled";
  if (postingState === "posting_in_progress") return "posting_in_progress";
  if (statusMeta?.status === "approved_waiting_post") return "approved_waiting_post";
  if (statusMeta?.status === "missing_in_qbo") return "posting_gap_detected";
  if (statusMeta?.status === "failed_post") return "posting_failed";
  if (statusMeta?.status === "needs_review") return "awaiting_review";
  if (statusMeta?.status === "pending") return canonicalState === "pending_candidate" ? "plaid_pending" : "pending";
  if (!cat) return "plaid_ingested";
  return "categorized";
}

function buildAuditSummary({ bank, cat, statusMeta, canonicalState, postingState, lifecycleStage }) {
  const parts = [];
  parts.push(`Plaid ${bank?.plaid_transaction_id || bank?.id || "transaction"} ingested`);
  if (canonicalState === "archived") {
    parts.push(`archived${bank?.archived_reason ? `: ${bank.archived_reason}` : ""}`);
  } else if (canonicalState === "merged_from_pending") {
    parts.push(`merged from pending ${bank?.pending_transaction_id || "candidate"}`);
  } else if (canonicalState === "pending_candidate") {
    parts.push("still pending in Plaid");
  } else {
    parts.push("canonical transaction");
  }
  if (cat?.status) {
    parts.push(`categorization ${String(cat.status).replace(/_/g, " ")}`);
  } else {
    parts.push("not yet categorized");
  }
  if (statusMeta?.status === "archived") {
    parts.push("removed from active reconciliation");
  } else if (statusMeta?.status === "duplicate_internal") {
    parts.push("suppressed by reconciliation dedupe safeguard");
  } else if (statusMeta?.status === "duplicate_in_qbo") {
    parts.push(`duplicate QBO post detected for ${cat?.qbo_txn_id || "linked txn"}`);
  } else if (postingState === "posted_to_qbo" && cat?.qbo_txn_id) {
    parts.push(`posted to QBO as ${cat.qbo_txn_type || "txn"} ${cat.qbo_txn_id}`);
  } else if (statusMeta?.status === "failed_post") {
    parts.push("posting failed and retry remains active");
  } else if (statusMeta?.status === "missing_in_qbo") {
    parts.push("approved but still missing in QuickBooks");
  } else {
    parts.push(`posting state ${postingState.replace(/_/g, " ")}`);
  }
  if (statusMeta?.status && lifecycleStage !== "categorized") {
    parts.push(`reconciliation status ${statusMeta.status.replace(/_/g, " ")}`);
  }
  return parts.join(" -> ");
}

function buildItemDetails({ bank, cat, statusMeta, nowTs }) {
  const canonicalState = deriveCanonicalState(bank);
  const postingState = derivePostingState(cat, nowTs);
  const lifecycleStage = deriveLifecycleStage({ bank, cat, statusMeta, nowTs });
  const hasLinkedQboRecord = Boolean(cat?.qbo_txn_id);
  const retryCount =
    cat?.meta?.post_retry_count != null ? Number(cat.meta.post_retry_count) || 0 : null;
  const safeToAutoPost =
    typeof cat?.meta?.safe_to_auto_post === "boolean" ? cat.meta.safe_to_auto_post : null;
  const postingInProgress =
    typeof cat?.meta?.posting_in_progress === "boolean" ? cat.meta.posting_in_progress : null;
  const nextPostAttemptAt = nullable(cat?.meta?.next_post_attempt_at);
  const sourceOfTruth = deriveSourceOfTruth(cat);
  const reconciliationConfidence = deriveReconciliationConfidence({ cat, statusMeta });
  const duplicateSource = deriveDuplicateSource({ bank, statusMeta });
  const pipelineBucket = derivePipelineBucket({ bank, statusMeta });
  const latestAttempt = cat?.latest_post_attempt || null;

  return {
    source: "posting_integrity",
    status: nullable(statusMeta?.status),
    reason_code: nullable(statusMeta?.reason_code),
    source_of_truth: sourceOfTruth,
    reconciliation_confidence: reconciliationConfidence,
    duplicate_source: duplicateSource,
    pipeline_bucket: pipelineBucket,
    lifecycle_stage: lifecycleStage,
    canonical_state: canonicalState,
    posting_state: postingState,
    audit_summary: buildAuditSummary({
      bank,
      cat,
      statusMeta,
      canonicalState,
      postingState,
      lifecycleStage,
    }),

    plaid_transaction_id: nullable(bank?.plaid_transaction_id),
    plaid_account_id: nullable(bank?.plaid_account_id),
    pending_transaction_id: nullable(bank?.pending_transaction_id),
    duplicate_fingerprint: nullable(bank?.duplicate_fingerprint),
    bank_name: nullable(bank?.merchant_name || bank?.counterparty_name || bank?.name),
    raw_date: nullable(bank?.date),
    authorized_date: nullable(bank?.authorized_date),
    is_archived: bank?.is_archived === true,
    archived_at: nullable(bank?.archived_at),
    archived_reason: nullable(bank?.archived_reason),
    appears_canonical: canonicalState === "canonical" || canonicalState === "merged_from_pending",
    merged_from_pending: canonicalState === "merged_from_pending",

    categorization_status: nullable(cat?.status),
    suggested_qbo_account_id: nullable(cat?.suggested_qbo_account_id),
    suggested_qbo_account_name: nullable(cat?.suggested_qbo_account_name),
    final_qbo_account_id: nullable(cat?.final_qbo_account_id),
    final_qbo_account_name: nullable(cat?.final_qbo_account_name),

    post_after: nullable(cat?.post_after),
    post_error: nullable(cat?.post_error),
    last_post_attempt_at: nullable(cat?.last_post_attempt_at),
    latest_post_attempt_at: nullable(latestAttempt?.attempted_at),
    latest_post_attempt_status: nullable(latestAttempt?.status),
    latest_post_attempt_error: nullable(latestAttempt?.error_message),
    post_attempt_count: nullable(cat?.post_attempt_count),
    posting_in_progress: postingInProgress,
    next_post_attempt_at: nextPostAttemptAt,
    retry_count: retryCount,
    post_block_reason: nullable(cat?.meta?.post_block_reason),
    suggestion_source: nullable(cat?.meta?.suggestion_source),
    taxonomy_type: nullable(cat?.meta?.taxonomy_type),
    safe_to_auto_post: safeToAutoPost,

    has_linked_qbo_record: hasLinkedQboRecord,
    qbo_txn_id: nullable(cat?.qbo_txn_id),
    qbo_txn_type: nullable(cat?.qbo_txn_type),
    posted_at: nullable(cat?.posted_at),
    reconciled_at: nullable(cat?.reconciled_at),

    meta_snapshot: {
      posting_in_progress: postingInProgress,
      next_post_attempt_at: nextPostAttemptAt,
      auto_approve_reason: nullable(cat?.meta?.auto_approve_reason),
    },
  };
}

async function fetchPostAttemptSummaries(businessId, transactionIds = []) {
  if (!businessId || !transactionIds.length) {
    return { latestByTransactionId: new Map(), countByTransactionId: new Map() };
  }

  const { data, error } = await supabase
    .from("bookkeeping_post_attempts")
    .select("transaction_id,attempted_at,status,error_message")
    .eq("business_id", businessId)
    .in("transaction_id", transactionIds)
    .order("attempted_at", { ascending: false });

  if (error) {
    if (isMissingRelationError(error)) {
      devLog("post_attempts_missing_table", {
        businessId,
        transaction_count: transactionIds.length,
      });
      return { latestByTransactionId: new Map(), countByTransactionId: new Map() };
    }
    throw error;
  }

  const latestByTransactionId = new Map();
  const countByTransactionId = new Map();
  for (const row of data || []) {
    if (!row?.transaction_id) continue;
    countByTransactionId.set(row.transaction_id, (countByTransactionId.get(row.transaction_id) || 0) + 1);
    if (!latestByTransactionId.has(row.transaction_id)) {
      latestByTransactionId.set(row.transaction_id, row);
    }
  }

  return { latestByTransactionId, countByTransactionId };
}

function getInternalDedupeKey(bank = {}) {
  return bank?.pending_transaction_id || bank?.duplicate_fingerprint || bank?.plaid_transaction_id || null;
}

function dedupeCanonicalScore(item = {}) {
  const details = item?.details || {};
  let score = 0;
  if (item?.qbo_txn_id || details?.has_linked_qbo_record) score += 100;
  if (item?.posted_at || item?.reconciled_at) score += 50;
  if (details?.posting_state === "posted_to_qbo") score += 40;
  if (details?.posting_state === "approved_waiting_post" || item?.status === "approved_waiting_post") score += 20;
  if (details?.categorization_status === "approved" || details?.categorization_status === "auto_approved") score += 10;
  if (details?.is_archived !== true && details?.canonical_state === "canonical") score += 5;
  if (details?.is_archived !== true && details?.canonical_state === "merged_from_pending") score += 4;
  if (item?.txn_date) score += safeParseDate(item.txn_date) || 0;
  return score;
}

function applyInternalDedupeSafeguard(items = []) {
  const keyed = new Map();
  const duplicateGroups = [];

  for (const item of items) {
    if (item?.details?.is_archived === true) continue;
    const key = getInternalDedupeKey(item?.details || {});
    if (!key) continue;
    const bucket = keyed.get(key) || [];
    bucket.push(item);
    keyed.set(key, bucket);
  }

  keyed.forEach((bucket, key) => {
    if (!bucket || bucket.length < 2) return;
    const ranked = [...bucket].sort((a, b) => dedupeCanonicalScore(b) - dedupeCanonicalScore(a));
    const canonical = ranked[0];
    const suppressed = ranked.slice(1);
    if (!suppressed.length) return;

    duplicateGroups.push({
      dedupe_key: key,
      canonical_transaction_id: canonical?.bank_transaction_id || null,
      duplicate_transaction_ids: suppressed.map((row) => row?.bank_transaction_id).filter(Boolean),
    });

    suppressed.forEach((item) => {
      item.status = "duplicate_internal";
      item.note = "Duplicate active row suppressed by reconciliation safeguard";
      item.details = {
        ...(item.details || {}),
        status: "duplicate_internal",
        reason_code: "dedupe_safeguard",
        duplicate_source: "reconciliation_safety",
        duplicate_scope: "active_row_safeguard",
        duplicate_transaction_ids: [canonical?.bank_transaction_id, ...suppressed.map((row) => row?.bank_transaction_id)]
          .filter(Boolean)
          .filter((id, index, arr) => arr.indexOf(id) === index),
        canonical_transaction_id: canonical?.bank_transaction_id || null,
      };
    });
  });

  return duplicateGroups;
}

function categorizeItem({ bank, cat, nowTs, includePending }) {
  if (bank?.is_archived === true) {
    return {
      status: "archived",
      note: "Transaction was archived or replaced by Plaid",
      reason_code: "archived",
    };
  }

  const statusLower = (cat?.status || "").toLowerCase();
  const pending = bank?.pending === true || cat?.meta?.pending === true;
  const hasCat = !!cat;
  const hasQbo = !!cat?.qbo_txn_id;
  const hasPostedAt = !!cat?.posted_at;
  const hasReconciled = !!cat?.reconciled_at;
  const postAfterTs = cat?.post_after ? Date.parse(cat.post_after) : null;
  const nextAttemptTs = cat?.meta?.next_post_attempt_at ? Date.parse(cat.meta.next_post_attempt_at) : null;
  const postBlocked = !!cat?.meta?.post_block_reason;
  const postingInProgress = cat?.meta?.posting_in_progress === true;
  const retryCount = Number(cat?.meta?.post_retry_count || 0);

  const needsReview =
    !hasCat ||
    statusLower === "needs_review" ||
    statusLower === "uncategorized" ||
    statusLower === "" ||
    postBlocked;

  if (pending) {
    return { status: "pending", note: "Pending/settling", reason_code: "pending" };
  }

  if (hasProvenPostingFailure(cat)) {
    return { status: "failed_post", note: "Posting failed; retrying", reason_code: "failed_post" };
  }

  if (statusLower === "posted" && hasQbo && (hasReconciled || hasPostedAt)) {
    return { status: "matched", note: "Posted to QuickBooks", reason_code: "matched" };
  }

  const approvedLike = isApprovedLike(cat);
  const inFuture = (postAfterTs && postAfterTs > nowTs) || (nextAttemptTs && nextAttemptTs > nowTs) || postingInProgress;
  if (approvedLike && !hasQbo && inFuture) {
    return { status: "approved_waiting_post", note: "Approved; queued for posting", reason_code: "approved_waiting_post" };
  }

  if (approvedLike && !hasQbo && !postAfterTs && !nextAttemptTs && !postingInProgress && !needsReview) {
    return { status: "handled_not_posted", note: "Handled in Bizzi; not posted", reason_code: "handled_not_posted" };
  }

  if (approvedLike && !hasQbo && postAfterTs && postAfterTs <= nowTs && !needsReview) {
    return { status: "missing_in_qbo", note: "Posting gap detected; retrying", reason_code: "missing_in_qbo" };
  }

  if (needsReview) {
    return { status: "needs_review", note: "Needs review before posting", reason_code: "needs_review" };
  }

  if (includePending && approvedLike && !hasQbo) {
    return { status: "pending", note: "Pending/settling", reason_code: "pending" };
  }

  if (retryCount >= 5 && cat?.post_error && !hasQbo) {
    return { status: "failed_post", note: "Posting failed; retrying", reason_code: "failed_post" };
  }

  return { status: "unknown", note: "Status not determined.", reason_code: "unknown" };
}

function computeRunStatus(counts) {
  if (!counts.total_seen) return "unknown";
  if (counts.missing_in_qbo_count > 0 || counts.duplicate_in_qbo_count > 0 || counts.failed_post_count > 0) return "investigating";
  return "ok";
}

function computeOverallNote(status, counts) {
  if (status === "ok") return "All eligible transactions matched. Some items may still be pending review.";
  if (status === "investigating")
    return `Investigating ${counts.missing_in_qbo_count + counts.duplicate_in_qbo_count + counts.failed_post_count || 0} posting issues. Bizzi is retrying quietly.`;
  if (status === "failed") return "Monitoring paused. Bizzi will retry automatically.";
  if (status === "partial") return "Monitoring is partially available while Bizzi collects more data.";
  return "No recent transactions to monitor yet.";
}

async function insertItems(runId, items) {
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const slice = items.slice(i, i + CHUNK_SIZE);
    const { error } = await supabase.from("reconciliation_items").upsert(slice, {
      onConflict: "run_id,bank_transaction_id",
    });
    if (error) throw error;
  }
}

async function findExistingMonthlyRun({ businessId, start, end, plaidAccountId }) {
  const { data, error } = await supabase
    .from("reconciliation_runs")
    .select("id,details")
    .eq("business_id", businessId)
    .eq("period_start", start)
    .eq("period_end", end)
    .order("last_checked_at", { ascending: false, nullsLast: true })
    .limit(10);
  if (error) throw error;

  const requestedAccountId = plaidAccountId || null;
  return (
    (data || []).find((row) => (row?.details?.opts?.plaid_account_id || null) === requestedAccountId) ||
    data?.[0] ||
    null
  );
}

async function prepareMonthlyRun({ businessId, scope, start, end, plaidAccountId, opts }) {
  const existingRun = await findExistingMonthlyRun({ businessId, start, end, plaidAccountId });
  const runPayload = {
    business_id: businessId,
    scope,
    period_start: start,
    period_end: end,
    status: "unknown",
    overall_note: computeOverallNote("unknown", { total_seen: 0 }),
    last_checked_at: NOW(),
    total_seen: 0,
    matched_count: 0,
    needs_review_count: 0,
    approved_waiting_post_count: 0,
    pending_count: 0,
    failed_post_count: 0,
    missing_in_qbo_count: 0,
    duplicate_in_qbo_count: 0,
    details: { opts, source_of_truth_refresh: true },
  };

  if (existingRun?.id) {
    const { error } = await supabase.from("reconciliation_runs").update(runPayload).eq("id", existingRun.id);
    if (error) throw error;
    return existingRun.id;
  }

  const { data: runRow, error } = await supabase
    .from("reconciliation_runs")
    .insert(runPayload)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return runRow?.id || null;
}

async function removeStaleItemsForRun({ businessId, runId, activeBankIds }) {
  if (!runId) return;
  if (!activeBankIds?.length) {
    const { error } = await supabase
      .from("reconciliation_items")
      .delete()
      .eq("business_id", businessId)
      .eq("run_id", runId);
    if (error) throw error;
    return;
  }

  const { data: existingRows, error: fetchErr } = await supabase
    .from("reconciliation_items")
    .select("id,bank_transaction_id")
    .eq("business_id", businessId)
    .eq("run_id", runId);
  if (fetchErr) throw fetchErr;

  const activeIds = new Set(activeBankIds);
  const staleIds = (existingRows || [])
    .filter((row) => row?.bank_transaction_id && !activeIds.has(row.bank_transaction_id))
    .map((row) => row.id)
    .filter(Boolean);
  if (!staleIds.length) return;

  for (let i = 0; i < staleIds.length; i += CHUNK_SIZE) {
    const slice = staleIds.slice(i, i + CHUNK_SIZE);
    const { error } = await supabase
      .from("reconciliation_items")
      .delete()
      .eq("business_id", businessId)
      .eq("run_id", runId)
      .in("id", slice);
    if (error) throw error;
  }
}

export async function computeReconciliationRun(businessId, opts = {}) {
  if (!businessId) throw new Error("businessId_required");
  const scope = opts.scope || DEFAULT_SCOPE;
  const range = { start: normalizeDate(opts.date_from), end: normalizeDate(opts.date_to) };
  const { start, end } = range.start && range.end ? range : computeRange(scope);
  const includePending = opts.include_pending !== false;
  const includeArchived = opts.include_archived !== false;
  const plaidAccountId = opts.plaid_account_id || null;
  const nowTs = Date.now();
  const normalizedOpts = { ...opts, include_pending: includePending, include_archived: includeArchived };
  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
  const runId = await prepareMonthlyRun({
    businessId,
    scope,
    start,
    end,
    plaidAccountId,
    opts: normalizedOpts,
  });

  try {
    // Fetch bank txns
    let bankQuery = supabase
      .from("bank_transactions")
      .select(
        "id,business_id,plaid_account_id,plaid_transaction_id,pending_transaction_id,pending,date,authorized_date,name,merchant_name,counterparty_name,amount,signed_amount,direction,is_archived,archived_at,archived_reason,duplicate_fingerprint"
      )
      .eq("business_id", businessId)
      .gte("date", start)
      .lte("date", end);
    bankQuery = applyActiveBookkeepingScope(bankQuery, bookkeepingStartDate);
    if (!includeArchived) bankQuery = bankQuery.eq("is_archived", false);
    if (plaidAccountId) bankQuery = bankQuery.eq("plaid_account_id", plaidAccountId);
    const { data: bankRows, error: bankErr } = await bankQuery;
    if (bankErr) throw bankErr;

    const bankIds = (bankRows || []).map((b) => b.id);
    if (!bankIds.length) {
      const finalStatus = "unknown";
      const overall_note = computeOverallNote(finalStatus, { total_seen: 0 });
      await removeStaleItemsForRun({ businessId, runId, activeBankIds: [] });
      await supabase
        .from("reconciliation_runs")
        .update({
          status: finalStatus,
          overall_note,
          last_checked_at: NOW(),
          details: { counts: { total_seen: 0 }, opts: normalizedOpts },
        })
        .eq("id", runId);
      return { ok: true, run_id: runId, status: finalStatus, counts: { total_seen: 0 } };
    }

    // Fetch categorizations
    const { data: catRows, error: catErr } = await supabase
      .from("transaction_categorizations")
      .select(
        "business_id,transaction_id,status,post_after,post_error,qbo_txn_id,qbo_txn_type,posted_at,reconciled_at,suggested_qbo_account_id,suggested_qbo_account_name,final_qbo_account_id,final_qbo_account_name,meta,last_post_attempt_at"
      )
      .eq("business_id", businessId)
      .eq("is_archived", false)
      .in("transaction_id", bankIds);
    if (catErr) throw catErr;
    devLog("loaded_categorizations", {
      businessId,
      bank_count: bankIds.length,
      cat_count: (catRows || []).length,
    });
    const catMap = new Map((catRows || []).map((c) => [c.transaction_id, c]));
    const { latestByTransactionId, countByTransactionId } = await fetchPostAttemptSummaries(businessId, bankIds);

    // Build items
    const items = [];
    const counts = {
      total_seen: 0,
      matched_count: 0,
      needs_review_count: 0,
      handled_not_posted_count: 0,
      approved_waiting_post_count: 0,
      pending_count: 0,
      failed_post_count: 0,
      missing_in_qbo_count: 0,
      duplicate_in_qbo_count: 0,
    };

    const qboIdCount = {};
    let archivedCount = 0;

    for (const bank of bankRows || []) {
      const catBase = catMap.get(bank.id) || null;
      const cat = catBase
        ? {
            ...catBase,
            latest_post_attempt: latestByTransactionId.get(bank.id) || null,
            post_attempt_count: countByTransactionId.get(bank.id) || 0,
          }
        : {
            latest_post_attempt: latestByTransactionId.get(bank.id) || null,
            post_attempt_count: countByTransactionId.get(bank.id) || 0,
          };
      const dir = normalizeDirection(bank);
      const amount = Number.isFinite(Number(bank.signed_amount)) ? Number(bank.signed_amount) : Number(bank.amount);
      const statusMeta = categorizeItem({ bank, cat, nowTs, includePending });
      const pipelineStatus = derivePipelineStatus({ bank, cat, nowTs });
      const details = {
        ...buildItemDetails({ bank, cat, statusMeta, nowTs }),
        pipeline_status: pipelineStatus,
        pipeline_status_key: pipelineStatus.key,
        pipeline_status_label: pipelineStatus.label,
      };

      const item = {
        run_id: runId,
        business_id: businessId,
        bank_transaction_id: bank.id,
        plaid_account_id: bank.plaid_account_id,
        txn_date: bank.date || null,
        merchant: bank.merchant_name || bank.counterparty_name || null,
        description: bank.name || null,
        amount: Number.isFinite(amount) ? amount : null,
        direction: dir,
        category_name: cat?.final_qbo_account_name || cat?.suggested_qbo_account_name || null,
        status: statusMeta.status,
        note: statusMeta.note,
        details,
        posted_at: cat?.posted_at || null,
        reconciled_at: cat?.reconciled_at || null,
        qbo_txn_id: cat?.qbo_txn_id || null,
        qbo_txn_type: cat?.qbo_txn_type || null,
      };

      items.push(item);
      if (bank?.is_archived === true) {
        archivedCount += 1;
      }
    }

    const duplicateGroups = applyInternalDedupeSafeguard(items);
    if (duplicateGroups.length) {
      devLog("dedupe_safeguard_triggered", {
        businessId,
        run_id: runId,
        groups: duplicateGroups,
      });
    }

    const activeCount = items.filter(
      (item) => item?.details?.is_archived !== true && item?.status !== "duplicate_internal"
    ).length;
    items.forEach((item) => {
      if (item?.details?.is_archived === true || item?.status === "duplicate_internal" || !item?.qbo_txn_id) return;
      qboIdCount[item.qbo_txn_id] = (qboIdCount[item.qbo_txn_id] || 0) + 1;
    });

    devLog("built_items_details", {
      businessId,
      run_id: runId,
      item_count: items.length,
      active_count: activeCount,
      archived_count: archivedCount,
      sample: items[0]
        ? {
            bank_transaction_id: items[0].bank_transaction_id,
            status: items[0].status,
            details: {
              lifecycle_stage: items[0].details?.lifecycle_stage || null,
              canonical_state: items[0].details?.canonical_state || null,
              posting_state: items[0].details?.posting_state || null,
              has_linked_qbo_record: items[0].details?.has_linked_qbo_record || false,
            },
          }
        : null,
    });

    // Run-window duplicate detection on qbo_txn_id.
    // This detects collisions among items inside the current reconciliation run scope.
    const dupIds = new Set(Object.keys(qboIdCount).filter((k) => qboIdCount[k] > 1));
    const currentRunQboIds = Object.keys(qboIdCount).filter(Boolean);
    const runScopeDuplicateTransactionIds = {};
    items.forEach((item) => {
      if (!item?.details?.is_archived && item?.status !== "duplicate_internal" && item?.qbo_txn_id) {
        const txnIds = runScopeDuplicateTransactionIds[item.qbo_txn_id] || [];
        txnIds.push(item.bank_transaction_id);
        runScopeDuplicateTransactionIds[item.qbo_txn_id] = txnIds;
      }
    });
    items.forEach((item) => {
      if (item.qbo_txn_id && dupIds.has(item.qbo_txn_id)) {
        item.status = "duplicate_in_qbo";
        item.note = "Duplicate post detected; investigating";
        item.details = {
          ...(item.details || {}),
          reason_code: "duplicate_in_qbo",
          duplicate_scope: "run_scope",
          duplicate_qbo_txn_id: item.qbo_txn_id,
          duplicate_transaction_ids: (runScopeDuplicateTransactionIds[item.qbo_txn_id] || []).filter(
            (txnId) => txnId !== item.bank_transaction_id
          ),
          scope_limited_duplicate_check: true,
          run_scope: scope,
          period_start: start,
          period_end: end,
        };
      }
    });

    const businessHistoryDuplicateMap = {};
    if (currentRunQboIds.length) {
      const { data: historyCatRows, error: historyCatErr } = await supabase
        .from("transaction_categorizations")
        .select("transaction_id,qbo_txn_id")
        .eq("business_id", businessId)
        .eq("is_archived", false)
        .in("qbo_txn_id", currentRunQboIds);
      if (historyCatErr) throw historyCatErr;

      const relatedTxnIds = Array.from(
        new Set((historyCatRows || []).map((row) => row?.transaction_id).filter(Boolean))
      );
      let activeHistoryTxnIds = new Set();
      if (relatedTxnIds.length) {
        const { data: relatedBankRows, error: relatedBankErr } = await supabase
          .from("bank_transactions")
          .select("id,is_archived")
          .eq("business_id", businessId)
          .gte("date", bookkeepingStartDate || "0001-01-01")
          .in("id", relatedTxnIds);
        if (relatedBankErr) throw relatedBankErr;
        activeHistoryTxnIds = new Set(
          (relatedBankRows || []).filter((row) => row?.is_archived !== true).map((row) => row.id)
        );
      }

      (historyCatRows || []).forEach((row) => {
        if (!row?.qbo_txn_id || !row?.transaction_id || !activeHistoryTxnIds.has(row.transaction_id)) return;
        const txnIds = businessHistoryDuplicateMap[row.qbo_txn_id] || [];
        txnIds.push(row.transaction_id);
        businessHistoryDuplicateMap[row.qbo_txn_id] = txnIds;
      });

      items.forEach((item) => {
        if (item?.details?.is_archived === true || item?.status === "duplicate_internal" || !item?.qbo_txn_id) return;
        const relatedTxnIdsForQboId = (businessHistoryDuplicateMap[item.qbo_txn_id] || []).filter(
          (txnId) => txnId !== item.bank_transaction_id
        );
        if (!relatedTxnIdsForQboId.length) return;

        item.status = "duplicate_in_qbo";
        item.note = "Duplicate QuickBooks posting detected across Bizzi history";
        item.details = {
          ...(item.details || {}),
          reason_code: "duplicate_in_qbo",
          duplicate_scope: "business_history",
          duplicate_qbo_txn_id: item.qbo_txn_id,
          duplicate_transaction_ids: Array.from(new Set(relatedTxnIdsForQboId)),
          scope_limited_duplicate_check: true,
          run_scope: scope,
          period_start: start,
          period_end: end,
        };
      });
    }

    devLog("duplicate_check_summary", {
      businessId,
      run_scope: scope,
      period_start: start,
      period_end: end,
      run_scope_duplicates: dupIds.size,
      business_history_duplicates: Object.values(businessHistoryDuplicateMap).filter((txnIds) => txnIds.length > 1).length,
      active_count: activeCount,
      archived_count: archivedCount,
    });

    // Recount with final statuses
    items.forEach((item) => {
      if (item?.details?.is_archived === true) {
        return;
      }
      if (item?.status === "duplicate_internal") {
        return;
      }
      counts.total_seen += 1;
      switch (item.status) {
        case "matched":
          counts.matched_count += 1;
          break;
        case "needs_review":
          counts.needs_review_count += 1;
          break;
        case "approved_waiting_post":
          counts.approved_waiting_post_count += 1;
          break;
        case "handled_not_posted":
          counts.handled_not_posted_count += 1;
          break;
        case "pending":
          counts.pending_count += 1;
          break;
        case "failed_post":
          counts.failed_post_count += 1;
          break;
        case "missing_in_qbo":
          counts.missing_in_qbo_count += 1;
          break;
        case "duplicate_in_qbo":
          counts.duplicate_in_qbo_count += 1;
          break;
        default:
          break;
      }
    });

    // Persist items
    await removeStaleItemsForRun({ businessId, runId, activeBankIds: bankIds });
    if (items.length) {
      await insertItems(runId, items);
    }

    const finalStatus = computeRunStatus(counts);
    const overall_note = computeOverallNote(finalStatus, counts);

    await supabase
      .from("reconciliation_runs")
      .update({
        status: finalStatus,
        overall_note,
        last_checked_at: NOW(),
        total_seen: counts.total_seen,
        matched_count: counts.matched_count,
        needs_review_count: counts.needs_review_count,
        approved_waiting_post_count: counts.approved_waiting_post_count,
        pending_count: counts.pending_count,
        failed_post_count: counts.failed_post_count,
        missing_in_qbo_count: counts.missing_in_qbo_count,
        duplicate_in_qbo_count: counts.duplicate_in_qbo_count,
        details: { counts, archived_count: archivedCount, opts: normalizedOpts },
      })
      .eq("id", runId);

    devLog("run_complete", {
      businessId,
      run_id: runId,
      status: finalStatus,
      counts,
      active_count: activeCount,
      archived_count: archivedCount,
      total_items_written: items.length,
    });
    return { ok: true, run_id: runId, status: finalStatus, counts };
  } catch (err) {
    await supabase
      .from("reconciliation_runs")
      .update({
        status: "failed",
        overall_note: computeOverallNote("failed", {}),
        last_checked_at: NOW(),
        details: { error: err?.message || err, opts: normalizedOpts },
      })
      .eq("id", runId);
    throw err;
  }
}

export default {
  computeReconciliationRun,
};
