/* global process */
import { createHash } from "node:crypto";
import { getVendorRuleForTransaction } from "./vendorRuleMatcher.js";
import { canAutoHandle } from "./autoHandlingPolicy.js";
import { learnVendorRuleFromTransaction } from "./vendorRuleLearner.js";
import { normalizeMerchantIdentity } from "./merchantNormalization.js";

function isMissingAutoPostColumn(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return error?.code === "42703" || message.includes("auto_post_to_quickbooks");
}

const DEFAULT_GRACE_HOURS = 24;
const POSTGREST_IN_BATCH_SIZE = 50;
export const AUTO_POST_SCOPE_MODES = Object.freeze({
  NEW_ACTIVITY_ONLY: "new_activity_only",
  EFFECTIVE_DATE: "effective_date",
  EXPLICIT_BACKLOG_RELEASED: "explicit_backlog_released",
});

const BACKLOG_ELIGIBLE_BUCKET = "safe_new_post";
const CUSTOMER_BACKLOG_BUCKETS = Object.freeze([
  "ready_to_release",
  "merchant_approval_needed",
  "active_posting",
  "scheduled_future",
  "protected_income_match",
  "protected_credit_card_payment",
  "protected_transfer",
  "protected_check",
  "protected_other",
  "failed",
  "missing_mapping",
]);

function normalizeScopeMode(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE) return AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE;
  if (normalized === AUTO_POST_SCOPE_MODES.EXPLICIT_BACKLOG_RELEASED) return AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE;
  return AUTO_POST_SCOPE_MODES.NEW_ACTIVITY_ONLY;
}

function validateScopeModeForWrite(value) {
  const normalized = String(value || AUTO_POST_SCOPE_MODES.NEW_ACTIVITY_ONLY).toLowerCase();
  if (normalized === AUTO_POST_SCOPE_MODES.EXPLICIT_BACKLOG_RELEASED) return AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE;
  if (normalized === AUTO_POST_SCOPE_MODES.NEW_ACTIVITY_ONLY || normalized === AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE) {
    return normalized;
  }
  const err = new Error("Unsupported automatic posting scope.");
  err.status = 400;
  err.code = "invalid_scope_mode";
  throw err;
}

export async function getAutoPostToQuickBooks(db, businessId) {
  if (!db || !businessId) return false;
  let query = db
    .from("business_profiles")
    .select("auto_post_to_quickbooks")
    .eq("id", businessId);
  if (typeof query.maybeSingle === "function") {
    const { data, error } = await query.maybeSingle();
    if (isMissingAutoPostColumn(error)) return false;
    if (error) throw error;
    return data?.auto_post_to_quickbooks === true;
  }
  if (typeof query.limit === "function") query = query.limit(1);
  const { data, error } = await query;
  if (isMissingAutoPostColumn(error)) return false;
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row?.auto_post_to_quickbooks === true;
}

export async function getAutoPostPolicy(db, businessId) {
  if (!db || !businessId) {
    return {
      enabled: false,
      bookkeeping_start_date: null,
      auto_post_enabled_at: null,
      auto_post_effective_date: null,
      auto_post_scope_mode: AUTO_POST_SCOPE_MODES.NEW_ACTIVITY_ONLY,
      historical_backlog_status: "review_required",
      policy_columns_available: false,
    };
  }

  const selectWithPolicy =
    "auto_post_to_quickbooks,bookkeeping_start_date,auto_post_enabled_at,auto_post_effective_date,auto_post_scope_mode,historical_backlog_status";
  const { data, error } = await db
    .from("business_profiles")
    .select(selectWithPolicy)
    .eq("id", businessId)
    .maybeSingle();

  if (!error) {
    let activeReleases = [];
    const releaseQuery = await db
      .from("bookkeeping_auto_post_backlog_releases")
      .select("id,release_start_date,release_end_date,transaction_ids,status")
      .eq("business_id", businessId)
      .eq("status", "active");
    if (!releaseQuery.error) activeReleases = releaseQuery.data || [];
    return {
      enabled: data?.auto_post_to_quickbooks === true,
      bookkeeping_start_date: data?.bookkeeping_start_date || null,
      auto_post_enabled_at: data?.auto_post_enabled_at || null,
      auto_post_effective_date: data?.auto_post_effective_date || data?.bookkeeping_start_date || null,
      auto_post_scope_mode: normalizeScopeMode(data?.auto_post_scope_mode),
      raw_auto_post_scope_mode: data?.auto_post_scope_mode || AUTO_POST_SCOPE_MODES.NEW_ACTIVITY_ONLY,
      historical_backlog_status: data?.historical_backlog_status || "review_required",
      active_backlog_releases: activeReleases,
      policy_columns_available: true,
    };
  }

  if (!isMissingAutoPostColumn(error)) throw error;

  const { data: fallback, error: fallbackError } = await db
    .from("business_profiles")
    .select("auto_post_to_quickbooks,bookkeeping_start_date")
    .eq("id", businessId)
    .maybeSingle();
  if (fallbackError) throw fallbackError;
  return {
    enabled: fallback?.auto_post_to_quickbooks === true,
    bookkeeping_start_date: fallback?.bookkeeping_start_date || null,
    auto_post_enabled_at: null,
    auto_post_effective_date: fallback?.bookkeeping_start_date || null,
    auto_post_scope_mode: AUTO_POST_SCOPE_MODES.NEW_ACTIVITY_ONLY,
    historical_backlog_status: "review_required",
    active_backlog_releases: [],
    policy_columns_available: false,
  };
}

function parseTime(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function classifyAutoPostOperationalScope({ item = {}, bankTxn = {}, policy = {}, manual = false } = {}) {
  if (manual === true) return { allowed: true, code: "manual_post" };
  if (policy?.enabled !== true) return { allowed: false, code: "auto_post_disabled" };

  const txnDate = bankTxn?.date || null;
  const releases = Array.isArray(policy?.active_backlog_releases) ? policy.active_backlog_releases : [];
  const txnId = item?.transaction_id || item?.id || bankTxn?.id || null;
  const backlogReleased = releases.some((release) => {
    if (!release || release.status === "revoked") return false;
    const ids = Array.isArray(release.transaction_ids) ? release.transaction_ids : [];
    if (txnId && ids.includes(txnId)) return true;
    if (!txnDate) return false;
    if (release.release_start_date && txnDate < release.release_start_date) return false;
    if (release.release_end_date && txnDate >= release.release_end_date) return false;
    return Boolean(release.release_start_date || release.release_end_date);
  });
  const effectiveDate = policy?.auto_post_effective_date || policy?.bookkeeping_start_date || null;
  if (effectiveDate && txnDate && txnDate < effectiveDate && !backlogReleased) {
    return { allowed: false, code: "historical_scope_review_required" };
  }

  const enabledAt = parseTime(policy?.auto_post_enabled_at);
  const postAfter = parseTime(item?.post_after);
  if (enabledAt && postAfter && postAfter < enabledAt && !backlogReleased) {
    return { allowed: false, code: "historical_scope_review_required" };
  }

  if (!policy?.policy_columns_available && !effectiveDate) {
    return { allowed: false, code: "historical_scope_review_required" };
  }

  return { allowed: true, code: "in_scope" };
}

export function classifyAutoPostBacklogCandidate({ item = {}, bankTxn = {}, policy = {} } = {}) {
  if (bankTxn?.pending === true || item?.meta?.pending === true) {
    return "pending";
  }
  const direction = String(bankTxn?.direction || "").toUpperCase();
  const amount = Number(bankTxn?.amount || 0);
  if (direction === "INFLOW" || (!direction && amount > 0)) {
    return "incoming_deposit_match_required";
  }
  if (item?.qbo_txn_id || item?.source_qbo_txn_id || item?.meta?.source_qbo_txn_id) {
    return "already_linked";
  }
  if (item?.meta?.possible_qbo_duplicate === true || item?.meta?.duplicate_risk === true) {
    return "possible_existing_qbo_duplicate";
  }
  if (item?.meta?.posting_in_progress === true || item?.meta?.post_intent_id) {
    return "ambiguous_prior_attempt";
  }
  if (!item?.final_qbo_account_id && !item?.meta?.cc_payment_cc_qbo_account_id) {
    return "missing_mapping";
  }
  if (item?.meta?.safe_to_auto_post !== true && item?.meta?.auto_approve_reason !== "manual_user") {
    return "unsafe_auto_post";
  }
  const unsupported = ["transfer_internal", "owner_draw", "owner_contribution", "refund"].includes(
    String(item?.meta?.taxonomy_type || "")
  );
  if (unsupported) return "unsupported";
  const scope = classifyAutoPostOperationalScope({ item, bankTxn, policy });
  if (!scope.allowed && scope.code === "historical_scope_review_required") {
    return "historical_scope_review_required";
  }
  if (item?.post_after) {
    return "already_scheduled";
  }
  return "safe_new_post";
}

function buildAutoPostScopeCopy(policy = {}, { workerIntervalMinutes = 10 } = {}) {
  if (policy?.enabled !== true) {
    return {
      headline: "Auto-posting is off",
      detail: "Handled transactions stay in Bizzi until Auto-post is enabled.",
    };
  }
  const enabledDate = normalizeDateString(policy.auto_post_enabled_at);
  const effectiveDate = normalizeDateString(policy.auto_post_effective_date);
  const scopeMode = normalizeScopeMode(policy.auto_post_scope_mode);
  const headline =
    scopeMode === AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE && effectiveDate
      ? `Auto-posting eligible activity dated on or after ${effectiveDate}`
      : enabledDate
        ? `Auto-posting new activity since ${enabledDate}`
        : "Auto-posting new activity";
  const held =
    policy.historical_backlog_status === "review_required"
      ? " Existing Handled transactions are held until posting scope is confirmed."
      : "";
  return {
    headline,
    detail: `Worker checks every ${workerIntervalMinutes} minutes.${held}`.trim(),
  };
}

export function computePostAfterForAutoPost(autoPostEnabled, graceHours = 24, nowMs = Date.now()) {
  if (autoPostEnabled !== true) return null;
  return new Date(nowMs + Number(graceHours || 24) * 60 * 60 * 1000).toISOString();
}

function chunk(values = [], size = POSTGREST_IN_BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function normalizeGraceHours(graceHours = DEFAULT_GRACE_HOURS) {
  const n = Number(graceHours || DEFAULT_GRACE_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GRACE_HOURS;
}

function wrapAutoPostDbError(operation, error) {
  if (!error) return error;
  const message = String(error?.message || error || "");
  const lower = message.toLowerCase();
  let code = error?.code || operation;
  let status = error?.status || 500;
  if (operation === "auto_post_scope_confirmation_failed") {
    if (lower.includes("preview_changed") || lower.includes("preview_required")) {
      code = lower.includes("preview_changed") ? "preview_changed" : "preview_required";
      status = 409;
    } else if (
      lower.includes("invalid_scope_mode") ||
      lower.includes("invalid_effective_date") ||
      lower.includes("invalid_preview_counts") ||
      lower.includes("released_transaction_count_mismatch")
    ) {
      code = lower.includes("invalid_scope_mode")
        ? "invalid_scope_mode"
        : lower.includes("invalid_effective_date")
          ? "invalid_effective_date"
          : "invalid_release_preview";
      status = 400;
    } else {
      code = "scope_persistence_failed";
    }
  }
  const wrapped = new Error(`${operation}: ${message}`);
  wrapped.code = code;
  wrapped.status = status;
  wrapped.cause = error;
  return wrapped;
}

async function getBookkeepingStartDate(db, businessId) {
  const { data, error } = await db
    .from("business_profiles")
    .select("bookkeeping_start_date")
    .eq("id", businessId)
    .maybeSingle();
  if (isMissingAutoPostColumn(error)) return null;
  if (error) throw wrapAutoPostDbError("auto_post_settings_business_fetch_failed", error);
  return data?.bookkeeping_start_date || null;
}

async function getHandledCategorizationTransactionIds(db, businessId) {
  const { data, error } = await db
    .from("transaction_categorizations")
    .select("transaction_id")
    .eq("business_id", businessId)
    .in("status", ["approved", "auto_approved"])
    .is("qbo_txn_id", null);
  if (error) throw wrapAutoPostDbError("auto_post_backlog_categorizations_fetch_failed", error);
  return (data || []).map((row) => row.transaction_id).filter(Boolean);
}

async function filterActiveBacklogTransactionIds(db, businessId, transactionIds = [], bookkeepingStartDate = null) {
  const activeIds = [];
  for (const ids of chunk(transactionIds)) {
    let query = db
      .from("bank_transactions")
      .select("id")
      .eq("business_id", businessId)
      .eq("is_archived", false)
      .in("id", ids);
    if (bookkeepingStartDate) query = query.gte("date", bookkeepingStartDate);
    const { data, error } = await query;
    if (error) throw wrapAutoPostDbError("auto_post_backlog_bank_transactions_fetch_failed", error);
    activeIds.push(...(data || []).map((row) => row.id).filter(Boolean));
  }
  return activeIds;
}

export async function getHandledBacklogTransactionIds(db, businessId) {
  if (!db || !businessId) return [];
  const ids = await getHandledCategorizationTransactionIds(db, businessId);
  if (!ids.length) return [];
  const bookkeepingStartDate = await getBookkeepingStartDate(db, businessId);
  return filterActiveBacklogTransactionIds(db, businessId, ids, bookkeepingStartDate);
}

async function clearBacklogPostAfter(db, businessId, transactionIds = [], nowIso) {
  for (const ids of chunk(transactionIds)) {
    const { error } = await db
      .from("transaction_categorizations")
      .update({
        post_after: null,
        updated_at: nowIso,
      })
      .eq("business_id", businessId)
      .in("transaction_id", ids)
      .is("qbo_txn_id", null)
      .in("status", ["approved", "auto_approved"]);
    if (error) throw wrapAutoPostDbError("auto_post_backlog_clear_failed", error);
  }
}

export async function getAutoPostSettings({
  db,
  businessId,
  graceHours = DEFAULT_GRACE_HOURS,
  includeBacklogSummary = false,
  includeBacklogPreview = false,
} = {}) {
  if (!db || !businessId) {
    return {
      enabled: false,
      auto_post_to_quickbooks: false,
      handled_backlog_count: 0,
      posting_grace_hours: normalizeGraceHours(graceHours),
    };
  }
  const policy = await getAutoPostPolicy(db, businessId);
  const enabled = policy.enabled === true;
  const backlogIds = await getHandledBacklogTransactionIds(db, businessId);
  const workerIntervalMinutes = Math.max(1, Number(process.env.BOOKS_POST_CRON_MINUTES || 10));
  const scopeCopy = buildAutoPostScopeCopy(policy, { workerIntervalMinutes });
  let backlogPreviewSummary = null;
  let backlogSummary = null;
  if (backlogIds.length > 0 && (includeBacklogSummary || includeBacklogPreview)) {
    try {
      if (includeBacklogSummary) {
        backlogSummary = await getCanonicalPostingBacklogSummary({
          db,
          businessId,
          effectiveDate: policy.auto_post_effective_date || policy.bookkeeping_start_date || "0001-01-01",
        });
      }
      if (enabled && includeBacklogPreview) {
        const preview = await previewAutoPostBacklog({
          db,
          businessId,
          effectiveDate: policy.auto_post_effective_date || policy.bookkeeping_start_date || "0001-01-01",
        });
        backlogPreviewSummary = {
          total: preview.total,
          eligible_count: preview.eligible_count,
          blocked_count: preview.blocked_count,
          buckets: preview.buckets,
        };
      }
    } catch {
      backlogPreviewSummary = null;
      backlogSummary = null;
    }
  }
  return {
    enabled,
    auto_post_to_quickbooks: enabled,
    handled_backlog_count: backlogIds.length,
    posting_grace_hours: normalizeGraceHours(graceHours),
    auto_post_enabled_at: policy.auto_post_enabled_at,
    auto_post_effective_date: policy.auto_post_effective_date,
    auto_post_scope_mode: policy.auto_post_scope_mode,
    historical_backlog_status: policy.historical_backlog_status,
    active_backlog_release_count: Array.isArray(policy.active_backlog_releases) ? policy.active_backlog_releases.length : 0,
    backlog_preview_summary: backlogPreviewSummary,
    backlog_summary: backlogSummary,
    worker: {
      enabled: process.env.DISABLE_BOOKS_POST_CRON !== "true",
      interval_minutes: workerIntervalMinutes,
    },
    scope_copy: scopeCopy,
  };
}

export async function setAutoPostEnabled({
  db,
  businessId,
  enabled,
  confirmBacklog = false,
  scopeMode = AUTO_POST_SCOPE_MODES.NEW_ACTIVITY_ONLY,
  effectiveDate = null,
  previewAcknowledged = false,
  previewFingerprint = null,
  requestedBy = null,
  graceHours = DEFAULT_GRACE_HOURS,
  nowMs = Date.now(),
} = {}) {
  if (!db || !businessId) {
    const err = new Error("businessId is required.");
    err.status = 400;
    err.code = "missing_business_id";
    throw err;
  }

  const nextEnabled = enabled === true;
  const currentEnabled = await getAutoPostToQuickBooks(db, businessId);
  const backlogIds = await getHandledBacklogTransactionIds(db, businessId);
  const normalizedGraceHours = normalizeGraceHours(graceHours);
  const nowIso = new Date(nowMs).toISOString();
  const normalizedScopeMode = validateScopeModeForWrite(scopeMode);
  const normalizedEffectiveDate = normalizeDateString(effectiveDate);

  if (
    nextEnabled &&
    normalizedScopeMode === AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE &&
    !normalizedEffectiveDate
  ) {
    const err = new Error("Choose a valid effective date before including existing Handled transactions.");
    err.status = 400;
    err.code = "invalid_effective_date";
    throw err;
  }

  if (
    nextEnabled &&
    normalizedScopeMode === AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE &&
    previewAcknowledged !== true
  ) {
    const err = new Error("Choose an effective date and confirm the preview before including existing Handled transactions.");
    err.status = 409;
    err.code = "auto_post_effective_date_confirmation_required";
    err.requires_confirmation = true;
    err.handled_backlog_count = backlogIds.length;
    throw err;
  }

  if (nextEnabled && normalizedScopeMode === AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE) {
    const preview = await previewAutoPostBacklog({
      db,
      businessId,
      rangeStart: normalizedEffectiveDate,
      effectiveDate: normalizedEffectiveDate,
    });
    const confirmedFingerprint = assertMatchingPreviewFingerprint(preview, previewFingerprint);
    const releaseResult = await confirmAutoPostScopeFromPreview({
      db,
      businessId,
      requestedBy,
      effectiveDate: normalizedEffectiveDate,
      eligibleTransactionIds: preview.eligible_transaction_ids || [],
      preview,
      previewFingerprint: confirmedFingerprint,
      enabledAt: nextEnabled && !currentEnabled ? nowIso : null,
    });

    return {
      ok: true,
      enabled: true,
      auto_post_to_quickbooks: true,
      handled_backlog_count: backlogIds.length,
      scheduled_backlog_count: 0,
      historical_backlog_status: "released",
      requires_backlog_review: false,
      auto_post_scope_mode: AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE,
      auto_post_effective_date: normalizedEffectiveDate,
      release: releaseResult,
      posting_grace_hours: normalizedGraceHours,
      post_after: null,
    };
  }

  if (nextEnabled && !currentEnabled && confirmBacklog !== true && previewAcknowledged !== true) {
    const err = new Error(
      backlogIds.length
        ? `You have ${backlogIds.length} handled transactions waiting. Choose whether Auto-post should apply only to new activity or include an explicitly reviewed historical scope.`
        : "Turn on automatic QuickBooks posting?"
    );
    err.status = 409;
    err.code = backlogIds.length ? "auto_post_backlog_confirmation_required" : "auto_post_confirmation_required";
    err.requires_confirmation = true;
    err.handled_backlog_count = backlogIds.length;
    throw err;
  }

  const enabledAt = nextEnabled && !currentEnabled ? nowIso : undefined;
  const baseUpdate = {
    auto_post_to_quickbooks: nextEnabled,
  };
  const policyUpdate = {
    ...baseUpdate,
    ...(enabledAt ? { auto_post_enabled_at: enabledAt } : {}),
    ...(nextEnabled
      ? {
          auto_post_scope_mode: normalizedScopeMode,
          auto_post_effective_date:
            normalizedScopeMode === AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE ? normalizedEffectiveDate : null,
          historical_backlog_status: backlogIds.length ? "review_required" : "none",
        }
      : {
          historical_backlog_status: "none",
        }),
  };
  let updateQuery = db
    .from("business_profiles")
    .update(policyUpdate)
    .eq("id", businessId)
    .select("id,auto_post_to_quickbooks")
    .maybeSingle();
  let { data: business, error: updateErr } = await updateQuery;
  if (isMissingAutoPostColumn(updateErr)) {
    ({ data: business, error: updateErr } = await db
      .from("business_profiles")
      .update(baseUpdate)
      .eq("id", businessId)
      .select("id,auto_post_to_quickbooks")
      .maybeSingle());
  }
  if (updateErr) throw wrapAutoPostDbError("auto_post_settings_update_failed", updateErr);

  const postAfter = computePostAfterForAutoPost(nextEnabled, normalizedGraceHours, nowMs);
  const scheduledBacklog = 0;

  if (backlogIds.length) {
    if (!nextEnabled) {
      await clearBacklogPostAfter(db, businessId, backlogIds, nowIso);
    }
  }

  return {
    ok: true,
    enabled: business?.auto_post_to_quickbooks === true,
    auto_post_to_quickbooks: business?.auto_post_to_quickbooks === true,
    handled_backlog_count: backlogIds.length,
    scheduled_backlog_count: scheduledBacklog,
    historical_backlog_status:
      nextEnabled && backlogIds.length
          ? "review_required"
          : "none",
    requires_backlog_review: nextEnabled && backlogIds.length > 0,
    auto_post_scope_mode: normalizedScopeMode,
    auto_post_effective_date:
      normalizedScopeMode === AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE ? normalizedEffectiveDate : null,
    release: null,
    posting_grace_hours: normalizedGraceHours,
    post_after: scheduledBacklog ? postAfter : null,
  };
}

function normalizeDateString(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function buildBacklogPreviewFingerprint(preview = {}) {
  const eligible = Array.from(new Set(preview.eligible_transaction_ids || [])).sort();
  const buckets = Object.fromEntries(Object.entries(preview.buckets || {}).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256")
    .update(
      JSON.stringify({
        business_id: preview.business_id || null,
        effective_date: preview.scope?.effective_date || preview.scope?.range_start || null,
        range_start: preview.scope?.range_start || null,
        range_end: preview.scope?.range_end || null,
        total: Number(preview.total || 0),
        eligible_count: Number(preview.eligible_count || 0),
        blocked_count: Number(preview.blocked_count || 0),
        eligible,
        buckets,
      })
    )
    .digest("hex");
}

function assertMatchingPreviewFingerprint(preview, expectedFingerprint) {
  if (!expectedFingerprint) {
    const err = new Error("Refresh the posting scope preview before saving.");
    err.status = 409;
    err.code = "preview_required";
    throw err;
  }
  const actual = buildBacklogPreviewFingerprint(preview);
  if (actual !== expectedFingerprint) {
    const err = new Error("The eligible posting population changed. Refresh the preview and confirm again.");
    err.status = 409;
    err.code = "preview_changed";
    err.preview_fingerprint = actual;
    throw err;
  }
  return actual;
}

async function fetchBacklogCategorizationRows(db, businessId, { transactionIds = [] } = {}) {
  let query = db
    .from("transaction_categorizations")
    .select("transaction_id,business_id,status,final_qbo_account_id,final_qbo_account_name,post_after,post_error,meta,qbo_txn_id,updated_at")
    .eq("business_id", businessId)
    .in("status", ["approved", "auto_approved", "failed"])
    .is("qbo_txn_id", null);
  const ids = Array.from(new Set((transactionIds || []).filter(Boolean)));
  if (ids.length) query = query.in("transaction_id", ids);
  const { data, error } = await query;
  if (error) throw wrapAutoPostDbError("auto_post_backlog_preview_categorizations_failed", error);
  return data || [];
}

async function fetchBacklogBankRows(db, businessId, transactionIds = []) {
  const map = new Map();
  const missing = [];
  for (const ids of chunk(Array.from(new Set((transactionIds || []).filter(Boolean))))) {
    const { data, error } = await db
      .from("bank_transactions")
      .select("id,business_id,plaid_account_id,date,pending,is_archived,amount,direction,transaction_type,name,merchant_name,counterparty_name,merchant_entity_id,qbo_entity_type,qbo_entity_id,check_number,category_primary,personal_finance_category,accounting_review_required")
      .eq("business_id", businessId)
      .in("id", ids);
    if (error) throw wrapAutoPostDbError("auto_post_backlog_preview_bank_transactions_failed", error);
    for (const row of data || []) {
      if (row.business_id === businessId) map.set(row.id, row);
    }
    for (const id of ids) {
      if (!map.has(id)) missing.push(id);
    }
  }
  return { map, missing };
}

function addReasonBucket(buckets, reason) {
  const key = reason || "unknown";
  buckets[key] = (buckets[key] || 0) + 1;
}

function amountDirection(bankTxn = {}) {
  const direction = String(bankTxn?.direction || "").toUpperCase();
  if (direction === "INFLOW" || direction === "OUTFLOW") return direction;
  const amount = Number(bankTxn?.amount || 0);
  if (amount > 0) return "INFLOW";
  if (amount < 0) return "OUTFLOW";
  return "UNKNOWN";
}

function textOfBacklogRow(item = {}, bankTxn = {}) {
  return [
    bankTxn.name,
    bankTxn.merchant_name,
    bankTxn.counterparty_name,
    item.final_qbo_account_name,
    item.meta?.taxonomy_type,
    item.meta?.post_block_reason,
  ].filter(Boolean).join(" ").toLowerCase();
}

function protectedCustomerBucket(item = {}, bankTxn = {}) {
  const meta = item.meta || {};
  const text = textOfBacklogRow(item, bankTxn);
  const taxonomy = String(meta.taxonomy_type || "").toLowerCase();
  if (bankTxn.pending === true || meta.pending === true) return { bucket: "protected_other", reason: "pending" };
  if (amountDirection(bankTxn) === "INFLOW") return { bucket: "protected_income_match", reason: "incoming_deposit_match_required" };
  if (bankTxn.check_number || meta.is_check === true || taxonomy === "check") return { bucket: "protected_check", reason: "check_review_required" };
  if (taxonomy === "cc_payment" || /credit card payment|cc payment|epay|autopay|thank you/.test(text)) {
    return { bucket: "protected_credit_card_payment", reason: "credit_card_payment_match_required" };
  }
  if (taxonomy.includes("transfer") || /\btransfer\b|\bxfer\b/.test(text)) return { bucket: "protected_transfer", reason: "transfer_match_required" };
  if (
    taxonomy === "refund" ||
    taxonomy === "payroll" ||
    taxonomy === "tax_payment" ||
    taxonomy === "owner_draw" ||
    taxonomy === "owner_contribution" ||
    taxonomy === "loan_movement" ||
    /refund|reversal|chargeback|payroll|salary|wages|\birs\b|tax payment|loan|liability|owner draw|owner contribution|fixed asset/.test(text)
  ) {
    return { bucket: "protected_other", reason: "protected_workflow" };
  }
  if (meta.possible_qbo_duplicate === true || meta.duplicate_risk === true) {
    return { bucket: "protected_other", reason: "possible_qbo_duplicate" };
  }
  return null;
}

function customerBucketForEvaluation({ item = {}, bankTxn = {}, evaluation = {}, sourceMappings = new Map() } = {}) {
  if (String(item.status || "").toLowerCase() === "failed" || evaluation.category === "failed_posting_requires_retry_review") {
    return { bucket: "failed", reason: evaluation.reason || item.post_error || "failed" };
  }
  const protectedBucket = protectedCustomerBucket(item, bankTxn);
  if (protectedBucket) return protectedBucket;
  if (bankTxn.plaid_account_id && !sourceMappings.has(bankTxn.plaid_account_id)) {
    return { bucket: "missing_mapping", reason: "missing_source_mapping" };
  }
  if (item.meta?.posting_in_progress === true || item.meta?.post_intent_id || evaluation.category === "ambiguous_prior_attempt") {
    return { bucket: "active_posting", reason: "active_posting_intent" };
  }
  if (evaluation.category === "already_scheduled") {
    const ts = Date.parse(item.post_after);
    if (Number.isFinite(ts) && ts > Date.now()) return { bucket: "scheduled_future", reason: "scheduled_future" };
    return { bucket: "ready_to_release", reason: "scheduled_due" };
  }
  if (evaluation.category === BACKLOG_ELIGIBLE_BUCKET) return { bucket: "ready_to_release", reason: evaluation.reason || "safe_to_post" };
  return { bucket: "merchant_approval_needed", reason: evaluation.reason || "merchant_approval_needed" };
}

function initializeCustomerBuckets() {
  return Object.fromEntries(CUSTOMER_BACKLOG_BUCKETS.map((key) => [key, 0]));
}

function buildMerchantIdentity(bankTxn = {}, vendorRule = null) {
  const normalized = normalizeMerchantIdentity(bankTxn.merchant_name || bankTxn.counterparty_name || bankTxn.name || "");
  if (bankTxn.merchant_entity_id) {
    return {
      key: `merchant_entity_id:${bankTxn.merchant_entity_id}`,
      type: "merchant_entity_id",
      match_type: "merchant_entity_id",
      match_value: bankTxn.merchant_entity_id,
      specificity: "exact_provider_merchant_id",
      display_merchant: bankTxn.merchant_name || bankTxn.counterparty_name || bankTxn.name || "Merchant",
      normalized_merchant: normalized.normalized,
      confidence: "high",
    };
  }
  if (vendorRule?.match_specificity && ["exact_normalized_merchant", "exact_descriptor_fingerprint", "memo_fingerprint"].includes(vendorRule.match_specificity)) {
    return {
      key: `${vendorRule.match_specificity}:${vendorRule.match_value}`,
      type: vendorRule.match_specificity,
      match_type: vendorRule.match_type || "memo_prefix",
      match_value: vendorRule.match_value,
      specificity: vendorRule.match_specificity,
      display_merchant: vendorRule.counterparty_name || bankTxn.merchant_name || bankTxn.counterparty_name || bankTxn.name || "Merchant",
      normalized_merchant: normalized.normalized,
      confidence: "medium",
    };
  }
  if (normalized.normalized && normalized.normalized.length >= 4 && normalized.specific !== false) {
    return {
      key: `normalized:${normalized.normalized}`,
      type: "normalized_merchant",
      match_type: "memo_prefix",
      match_value: normalized.normalized,
      specificity: "exact_normalized_merchant",
      display_merchant: bankTxn.merchant_name || bankTxn.counterparty_name || bankTxn.name || "Merchant",
      normalized_merchant: normalized.normalized,
      confidence: "medium",
    };
  }
  return null;
}

function groupSnapshotHash(group = {}) {
  const ids = (group.transaction_ids || []).slice().sort();
  return createHash("sha256")
    .update(JSON.stringify({
      business_id: group.business_id || null,
      identity_key: group.identity?.key || null,
      account_id: group.proposed_qbo_account_id || null,
      transaction_ids: ids,
      row_versions: group.row_versions || {},
    }))
    .digest("hex");
}

async function evaluateBacklogRowForRelease({ db, businessId, item, bankTxn = {}, policy = {}, sourceMappings = new Map() }) {
  if (String(item?.status || "").toLowerCase() === "failed") {
    return { category: "failed_posting_requires_retry_review", reason: item?.post_error || "failed_posting_requires_retry_review" };
  }
  if (item?.qbo_txn_id || item?.source_qbo_txn_id || item?.meta?.source_qbo_txn_id) {
    return { category: "already_represented_in_qbo", reason: "already_represented_in_qbo" };
  }
  if (bankTxn.plaid_account_id && !sourceMappings.has(bankTxn.plaid_account_id)) {
    return { category: "missing_source_mapping", reason: "missing_source_mapping" };
  }
  let category = classifyAutoPostBacklogCandidate({ item, bankTxn, policy });
  if (category === BACKLOG_ELIGIBLE_BUCKET) {
    return {
      category,
      reason: item?.meta?.safe_to_auto_post === true ? "previously_safe_and_still_safe" : "eligible",
      meta: { ...(item.meta || {}), safe_to_auto_post: true },
    };
  }
  if (category !== "unsafe_auto_post") return { category, reason: category };

  const vendorRule = await getVendorRuleForTransaction({ businessId, bankTransaction: bankTxn, db });
  const exactBusinessRule =
    vendorRule?.source_type === "business_merchant_rule" &&
    ["exact_provider_merchant_id", "exact_normalized_merchant", "exact_descriptor_fingerprint", "memo_fingerprint"].includes(
      vendorRule.match_specificity
    );
  const sameAccount =
    item?.final_qbo_account_id &&
    vendorRule?.default_qbo_account_id &&
    String(item.final_qbo_account_id) === String(vendorRule.default_qbo_account_id);
  if (exactBusinessRule && sameAccount && sourceMappings.has(bankTxn.plaid_account_id)) {
    const decision = canAutoHandle(bankTxn, {
      source: "business_merchant_rule",
      confidence: "high",
      accountId: item.final_qbo_account_id,
      accountName: item.final_qbo_account_name,
      safeToAutoHandle: true,
      meta: {
        ...(item.meta || {}),
        vendor_rule_id: vendorRule.id,
        vendor_rule_source_type: vendorRule.source_type,
        vendor_rule_match_specificity: vendorRule.match_specificity,
      },
      canonicalAccountResolved: true,
      merchantEvidenceStrong: true,
      canonicalVendorReliable: true,
    });
    if (decision.eligible === true) {
      const validSchedule = Boolean(
        item?.meta?.safe_to_auto_post === true &&
        item?.post_after &&
        Number.isFinite(Date.parse(item.post_after))
      );
      return {
        category: validSchedule ? "already_scheduled" : BACKLOG_ELIGIBLE_BUCKET,
        reason: validSchedule ? "currently_safe_existing_schedule_valid" : "previously_unsafe_but_now_safe",
        meta: {
          ...(item.meta || {}),
          safe_to_auto_post: true,
          safe_to_auto_handle: true,
          auto_approve_reason: item.meta?.auto_approve_reason || "business_merchant_rule",
          auto_post_reevaluated_at: new Date().toISOString(),
          auto_post_reevaluation_reason: "previously_unsafe_but_now_safe",
        },
      };
    }
    return { category: "still_unsafe", reason: decision.reason || "auto_handle_policy_blocked" };
  }
  return { category: "still_unsafe", reason: "no_active_authoritative_business_rule" };
}

export async function reEvaluateAutoPostBacklog({
  db,
  businessId,
  rangeStart = null,
  rangeEnd = null,
  transactionIds = [],
  effectiveDate = null,
} = {}) {
  const start = normalizeDateString(rangeStart || effectiveDate);
  const end = normalizeDateString(rangeEnd);
  const rows = await fetchBacklogCategorizationRows(db, businessId, { transactionIds });
  const bankRows = await fetchBacklogBankRows(db, businessId, rows.map((row) => row.transaction_id));
  const sourceMappings = await fetchSourceMappingRows(
    db,
    businessId,
    Array.from(new Set(Array.from(bankRows.map.values()).map((row) => row.plaid_account_id).filter(Boolean)))
  );
  const basePolicy = await getAutoPostPolicy(db, businessId);
  const policy = buildPreviewPolicy(basePolicy, { effectiveDate: effectiveDate || start });
  const buckets = {};
  const reasons = {};
  const eligibleIds = [];
  const reevaluatedSafeIds = [];
  const evaluations = [];
  let scopedTotal = 0;
  for (const item of rows) {
    const bankTxn = bankRows.map.get(item.transaction_id) || {};
    if (start && bankTxn.date && bankTxn.date < start) continue;
    if (end && bankTxn.date && bankTxn.date >= end) continue;
    scopedTotal += 1;
    let evaluation = bankRows.missing.includes(item.transaction_id)
      ? { category: "missing_transaction", reason: "missing_transaction" }
      : await evaluateBacklogRowForRelease({ db, businessId, item, bankTxn, policy, sourceMappings });
    if (evaluation.category === BACKLOG_ELIGIBLE_BUCKET) {
      eligibleIds.push(item.transaction_id);
      if (evaluation.reason === "previously_unsafe_but_now_safe") reevaluatedSafeIds.push(item.transaction_id);
    }
    addReasonBucket(buckets, evaluation.category);
    addReasonBucket(reasons, evaluation.reason);
    evaluations.push({
      transaction_id: item.transaction_id,
      date: bankTxn.date || null,
      status: item.status,
      category: evaluation.category,
      reason: evaluation.reason,
      meta: evaluation.meta || item.meta || {},
    });
  }
  return {
    total: scopedTotal,
    eligible_transaction_ids: eligibleIds,
    reevaluated_safe_transaction_ids: reevaluatedSafeIds,
    eligible_count: eligibleIds.length,
    blocked_count: scopedTotal - eligibleIds.length,
    buckets,
    reasons,
    evaluations,
  };
}

export async function getCanonicalPostingBacklogSummary({
  db,
  businessId,
  rangeStart = null,
  rangeEnd = null,
  transactionIds = [],
  effectiveDate = null,
} = {}) {
  if (!db || !businessId) {
    const err = new Error("businessId is required.");
    err.status = 400;
    err.code = "missing_business_id";
    throw err;
  }
  const rows = await fetchBacklogCategorizationRows(db, businessId, { transactionIds });
  const bankRows = await fetchBacklogBankRows(db, businessId, rows.map((row) => row.transaction_id));
  const sourceMappings = await fetchSourceMappingRows(
    db,
    businessId,
    Array.from(new Set(Array.from(bankRows.map.values()).map((row) => row.plaid_account_id).filter(Boolean)))
  );
  const reevaluation = await reEvaluateAutoPostBacklog({ db, businessId, rangeStart, rangeEnd, transactionIds, effectiveDate });
  const evaluationsById = new Map(reevaluation.evaluations.map((row) => [row.transaction_id, row]));
  const buckets = initializeCustomerBuckets();
  const reasons = {};
  const rowsOut = [];
  for (const item of rows) {
    const bankTxn = bankRows.map.get(item.transaction_id) || {};
    const evaluation = evaluationsById.get(item.transaction_id);
    if (!evaluation) continue;
    const bucket = customerBucketForEvaluation({ item, bankTxn, evaluation, sourceMappings });
    buckets[bucket.bucket] += 1;
    addReasonBucket(reasons, bucket.reason);
    rowsOut.push({
      transaction_id: item.transaction_id,
      date: bankTxn.date || null,
      amount: bankTxn.amount ?? null,
      merchant: bankTxn.merchant_name || bankTxn.counterparty_name || bankTxn.name || null,
      bucket: bucket.bucket,
      reason: bucket.reason,
    });
  }
  const total = rowsOut.length;
  return {
    ok: true,
    business_id: businessId,
    total,
    headline_count: total,
    buckets,
    bucket_total: Object.values(buckets).reduce((sum, value) => sum + Number(value || 0), 0),
    labels: {
      ready_to_release: "Ready to post",
      merchant_approval_needed: "Merchant review needed",
      active_posting: "Posting",
      scheduled_future: "Scheduled",
      protected_income_match: "Income matches",
      protected_credit_card_payment: "Payment matches",
      protected_transfer: "Transfer matches",
      protected_check: "Checks",
      protected_other: "Protected workflows",
      failed: "Failed",
      missing_mapping: "Missing account mapping",
    },
    reasons,
    rows: rowsOut,
  };
}

function postingReviewPlainStatus({ bucket, item = {}, reason = "" } = {}) {
  if (bucket === "scheduled_future") return "Waiting to post";
  if (bucket === "active_posting") return "Posting to QuickBooks";
  if (bucket === "ready_to_release") return "Ready to post";
  if (bucket === "failed") return item.post_error || "Posting failed";
  if (bucket === "missing_mapping") return "Missing account mapping";
  if (bucket === "protected_income_match") return "Needs income match";
  if (bucket === "protected_credit_card_payment") return "Needs payment match";
  if (bucket === "protected_transfer") return "Needs transfer review";
  if (bucket === "protected_check") return "Needs check review";
  if (bucket === "protected_other") return "Protected workflow";
  return reason || "Needs merchant review";
}

export async function getPostingBacklogReviewDetails({
  db,
  businessId,
  rangeStart = null,
  rangeEnd = null,
  effectiveDate = null,
  limit = 100,
} = {}) {
  if (!db || !businessId) {
    const err = new Error("businessId is required.");
    err.status = 400;
    err.code = "missing_business_id";
    throw err;
  }
  const rows = await fetchBacklogCategorizationRows(db, businessId);
  const bankRows = await fetchBacklogBankRows(db, businessId, rows.map((row) => row.transaction_id));
  const sourceMappings = await fetchSourceMappingRows(
    db,
    businessId,
    Array.from(new Set(Array.from(bankRows.map.values()).map((row) => row.plaid_account_id).filter(Boolean)))
  );
  const reevaluation = await reEvaluateAutoPostBacklog({ db, businessId, rangeStart, rangeEnd, effectiveDate });
  const evaluationsById = new Map(reevaluation.evaluations.map((row) => [row.transaction_id, row]));
  const items = [];
  for (const item of rows) {
    const bankTxn = bankRows.map.get(item.transaction_id) || {};
    const evaluation = evaluationsById.get(item.transaction_id);
    if (!evaluation) continue;
    const bucket = customerBucketForEvaluation({ item, bankTxn, evaluation, sourceMappings });
    const mapping = sourceMappings.get(bankTxn.plaid_account_id);
    items.push({
      transaction_id: item.transaction_id,
      bucket: bucket.bucket,
      reason: bucket.reason,
      plain_status: postingReviewPlainStatus({ bucket: bucket.bucket, item, reason: bucket.reason }),
      date: bankTxn.date || null,
      amount: bankTxn.amount ?? null,
      merchant: bankTxn.merchant_name || bankTxn.counterparty_name || bankTxn.name || null,
      description: bankTxn.name || "",
      memo: bankTxn.counterparty_name || bankTxn.merchant_name || "",
      source_account: mapping?.qbo_account_name || null,
      source_qbo_account_id: mapping?.qbo_account_id || null,
      proposed_gl: item.final_qbo_account_name || null,
      proposed_qbo_account_id: item.final_qbo_account_id || null,
      post_after: item.post_after || null,
      post_error: item.post_error || null,
      duplicate_preflight: item.meta?.duplicate_preflight || null,
      operation_id: item.meta?.merchant_group_operation_id || item.meta?.post_intent_id || null,
      worker_state: item.meta?.posting_in_progress === true ? "posting" : item.post_after ? "scheduled" : "waiting",
    });
  }
  const groups = await getMerchantBacklogGroups({ db, businessId, rangeStart, rangeEnd, effectiveDate, limit });
  return {
    ok: true,
    business_id: businessId,
    items: items.slice(0, Math.max(1, Number(limit || 100))),
    item_count: items.length,
    groups: groups.groups || [],
    group_count: groups.group_count || 0,
    transaction_level_review_count: groups.transaction_level_review_count || 0,
  };
}

export async function getMerchantBacklogGroups({
  db,
  businessId,
  rangeStart = null,
  rangeEnd = null,
  effectiveDate = null,
  limit = 50,
} = {}) {
  if (!db || !businessId) {
    const err = new Error("businessId is required.");
    err.status = 400;
    err.code = "missing_business_id";
    throw err;
  }
  const rows = await fetchBacklogCategorizationRows(db, businessId);
  const bankRows = await fetchBacklogBankRows(db, businessId, rows.map((row) => row.transaction_id));
  const sourceMappings = await fetchSourceMappingRows(
    db,
    businessId,
    Array.from(new Set(Array.from(bankRows.map.values()).map((row) => row.plaid_account_id).filter(Boolean)))
  );
  const reevaluation = await reEvaluateAutoPostBacklog({ db, businessId, rangeStart, rangeEnd, effectiveDate });
  const evaluationsById = new Map(reevaluation.evaluations.map((row) => [row.transaction_id, row]));
  const groups = new Map();
  let transactionLevelReviewCount = 0;
  for (const item of rows) {
    const bankTxn = bankRows.map.get(item.transaction_id) || {};
    const evaluation = evaluationsById.get(item.transaction_id);
    if (!evaluation) continue;
    const customerBucket = customerBucketForEvaluation({ item, bankTxn, evaluation, sourceMappings });
    if (!["merchant_approval_needed", "ready_to_release"].includes(customerBucket.bucket)) {
      transactionLevelReviewCount += 1;
      continue;
    }
    const vendorRule = await getVendorRuleForTransaction({ businessId, bankTransaction: bankTxn, db });
    const identity = buildMerchantIdentity(bankTxn, vendorRule);
    if (!identity || identity.specificity === "broad_fuzzy_alias") {
      transactionLevelReviewCount += 1;
      continue;
    }
    const accountId = item.final_qbo_account_id || vendorRule?.default_qbo_account_id || null;
    const accountName = item.final_qbo_account_name || vendorRule?.default_qbo_account_name || "Selected account";
    if (!accountId) {
      transactionLevelReviewCount += 1;
      continue;
    }
    const key = `${identity.key}|${accountId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        business_id: businessId,
        group_id: createHash("sha256").update(key).digest("hex"),
        identity,
        display_merchant: identity.display_merchant,
        normalized_identity: identity.normalized_merchant,
        proposed_qbo_account_id: String(accountId),
        proposed_qbo_account_name: accountName,
        classification_sources: {},
        transaction_count: 0,
        total_amount: 0,
        date_range: { start: null, end: null },
        source_accounts: {},
        evidence: {
          confidence: identity.confidence,
          reusable_rule_status: vendorRule?.id ? "active" : "not_created",
          vendor_rule_id: vendorRule?.id || null,
          match_specificity: identity.specificity,
        },
        warnings: [],
        excluded_transaction_count: 0,
        excluded_reasons: {},
        transactions: [],
        transaction_ids: [],
        row_versions: {},
      });
    }
    const group = groups.get(key);
    const source = item.meta?.auto_approve_reason || item.meta?.suggestion_source || item.status || "unknown";
    group.classification_sources[source] = (group.classification_sources[source] || 0) + 1;
    group.transaction_count += 1;
    group.total_amount += Number(bankTxn.amount || 0);
    group.date_range.start = !group.date_range.start || bankTxn.date < group.date_range.start ? bankTxn.date : group.date_range.start;
    group.date_range.end = !group.date_range.end || bankTxn.date > group.date_range.end ? bankTxn.date : group.date_range.end;
    const mapping = sourceMappings.get(bankTxn.plaid_account_id);
    if (mapping) group.source_accounts[mapping.qbo_account_id] = mapping.qbo_account_name || mapping.qbo_account_id;
    group.transactions.push({
      transaction_id: item.transaction_id,
      row_version: item.meta?.row_version || item.meta?.version || item.updated_at || null,
      date: bankTxn.date || null,
      amount: bankTxn.amount ?? null,
      description: bankTxn.name || "",
      memo: bankTxn.counterparty_name || bankTxn.merchant_name || "",
      source_account: mapping?.qbo_account_name || null,
      proposed_gl: accountName,
      bucket: customerBucket.bucket,
      exclusion_reason: null,
    });
    group.transaction_ids.push(item.transaction_id);
    group.row_versions[item.transaction_id] = item.meta?.row_version || item.meta?.version || item.updated_at || null;
  }
  const out = Array.from(groups.values())
    .map((group) => ({
      ...group,
      source_accounts: Object.entries(group.source_accounts).map(([id, name]) => ({ id, name })),
      snapshot_token: groupSnapshotHash(group),
    }))
    .sort((a, b) => b.transaction_count - a.transaction_count || Math.abs(b.total_amount) - Math.abs(a.total_amount))
    .slice(0, Math.max(1, Number(limit || 50)));
  return {
    ok: true,
    business_id: businessId,
    groups: out,
    group_count: out.length,
    transaction_level_review_count: transactionLevelReviewCount,
  };
}

async function fetchQboAccountForApproval(db, businessId, qboAccountId) {
  const { data, error } = await db
    .from("qbo_accounts_cache")
    .select("qbo_account_id,name,account_type,active")
    .eq("business_id", businessId)
    .eq("qbo_account_id", String(qboAccountId))
    .maybeSingle();
  if (error) throw wrapAutoPostDbError("merchant_group_qbo_account_fetch_failed", error);
  if (!data?.qbo_account_id) {
    const err = new Error("Selected QuickBooks account was not found.");
    err.status = 400;
    err.code = "qbo_account_not_found";
    throw err;
  }
  const type = String(data.account_type || "").toLowerCase();
  if (data.active === false || (type && !["expense", "cost of goods sold"].includes(type))) {
    const err = new Error("Selected QuickBooks account is not an active expense account.");
    err.status = 400;
    err.code = "qbo_account_not_eligible";
    throw err;
  }
  return data;
}

function findGroupByToken(groups = [], token = "", transactionIds = []) {
  if (token) {
    const hit = groups.find((group) => group.snapshot_token === token || group.group_id === token);
    if (hit) return hit;
  }
  const wanted = new Set(transactionIds || []);
  return groups.find((group) => group.transaction_ids?.some((id) => wanted.has(id))) || null;
}

async function defaultDuplicatePreflight() {
  return { ok: false, confidence: "NOT_RUN", reason: "duplicate_preflight_required" };
}

function buildMerchantApprovalOperationId({ businessId, idempotencyKey, groupSnapshotToken, transactionIds = [], selectedQboAccountId } = {}) {
  return createHash("sha256")
    .update(JSON.stringify({
      business_id: businessId || null,
      idempotency_key: idempotencyKey || null,
      group_snapshot_token: groupSnapshotToken || null,
      selected_qbo_account_id: selectedQboAccountId ? String(selectedQboAccountId) : null,
      transaction_ids: Array.from(new Set(transactionIds || [])).sort(),
    }))
    .digest("hex");
}

async function recordMerchantApprovalDecision({
  db,
  businessId,
  item,
  rule,
  account,
  actorId,
  group,
  duplicate,
  safety,
  idempotencyKey,
  postAfter,
  operationId = null,
  operationState = null,
} = {}) {
  const decidedAt = new Date().toISOString();
  const meta = {
    ...(item.meta || {}),
    merchant_group_approved_at: decidedAt,
    merchant_group_approved_by: actorId || null,
    merchant_group_idempotency_key: idempotencyKey || null,
    merchant_group_identity_key: group?.identity?.key || null,
    merchant_group_snapshot_token: group?.snapshot_token || null,
    merchant_group_operation_id: operationId || item.meta?.merchant_group_operation_id || null,
    merchant_group_operation_state: operationState || item.meta?.merchant_group_operation_state || null,
    selected_qbo_account_id: String(account.qbo_account_id),
    selected_qbo_account_name: account.name || item.final_qbo_account_name || null,
    vendor_rule_id: rule?.rule?.id || rule?.id || item.meta?.vendor_rule_id || null,
    vendor_rule_source_type: "business_merchant_rule",
    vendor_rule_match_specificity: group?.identity?.specificity || item.meta?.vendor_rule_match_specificity || null,
    duplicate_preflight: duplicate || null,
    per_row_safety_result: safety || null,
    safe_to_auto_handle: true,
    safe_to_auto_post: Boolean(postAfter),
    auto_approve_reason: "business_merchant_rule",
  };
  const { error } = await db
    .from("transaction_categorizations")
    .update({
      status: "auto_approved",
      final_qbo_account_id: String(account.qbo_account_id),
      final_qbo_account_name: account.name || item.final_qbo_account_name || "Selected account",
      post_after: postAfter || null,
      post_error: null,
      updated_at: decidedAt,
      meta,
    })
    .eq("business_id", businessId)
    .eq("transaction_id", item.transaction_id)
    .is("qbo_txn_id", null)
    .in("status", ["approved", "auto_approved"]);
  if (error) return { ok: false, transaction_id: item.transaction_id, reason: error.message || "update_failed" };
  return {
    ok: true,
    transaction_id: item.transaction_id,
    status: postAfter ? "scheduled" : "ready_to_post",
    post_after: postAfter || null,
    duplicate_preflight: duplicate || null,
  };
}

async function resolveMerchantBacklogApproval({
  db,
  businessId,
  selectedQboAccountId,
  groupSnapshotToken = null,
  transactionIds = [],
  exclusionIds = [],
} = {}) {
  if (!db || !businessId || !selectedQboAccountId) {
    const err = new Error("businessId and selectedQboAccountId are required.");
    err.status = 400;
    err.code = "missing_merchant_group_approval_input";
    throw err;
  }
  const account = await fetchQboAccountForApproval(db, businessId, selectedQboAccountId);
  const groupsResult = await getMerchantBacklogGroups({ db, businessId, limit: 500 });
  const group = findGroupByToken(groupsResult.groups, groupSnapshotToken, transactionIds);
  if (!group) {
    const err = new Error("Merchant group is no longer available. Refresh and try again.");
    err.status = 409;
    err.code = "merchant_group_changed";
    throw err;
  }
  const excluded = new Set(exclusionIds || []);
  const authorized = new Set(transactionIds?.length ? transactionIds : group.transaction_ids);
  const candidateIds = group.transaction_ids.filter((id) => authorized.has(id) && !excluded.has(id));
  if (!candidateIds.length) {
    const err = new Error("No transactions are selected for this merchant group.");
    err.status = 400;
    err.code = "merchant_group_empty_selection";
    throw err;
  }
  const rows = await fetchBacklogCategorizationRows(db, businessId, { transactionIds: candidateIds });
  const bankRows = await fetchBacklogBankRows(db, businessId, candidateIds);
  const policy = await getAutoPostPolicy(db, businessId);
  const sourceMappings = await fetchSourceMappingRows(
    db,
    businessId,
    Array.from(new Set(Array.from(bankRows.map.values()).map((row) => row.plaid_account_id).filter(Boolean)))
  );
  return { account, group, excluded, candidateIds, rows, bankRows, policy, sourceMappings };
}

async function learnRuleForMerchantApproval({
  businessId,
  actorId,
  rememberForFuture,
  account,
  group,
  candidateIds,
  bankRows,
  db,
} = {}) {
  let ruleResult = { ok: true, skipped: true, reason: "remember_for_future_false" };
  const firstBankTxn = bankRows.map.get(candidateIds[0]);
  if (rememberForFuture === true && firstBankTxn) {
    ruleResult = await learnVendorRuleFromTransaction({
      businessId,
      bankTxn: firstBankTxn,
      finalAccountId: String(account.qbo_account_id),
      finalAccountName: account.name || group.proposed_qbo_account_name,
      options: {
        actorId,
        actorType: "user",
        authority: "user_confirmed",
        sourceTransactionId: firstBankTxn.id,
        learnedFrom: "merchant_group_review",
      },
      db,
    });
    if (ruleResult?.ok === false) {
      const err = new Error(ruleResult.error || "merchant_rule_save_failed");
      err.status = 409;
      err.code = "merchant_rule_save_failed";
      throw err;
    }
  }
  return ruleResult;
}

export async function persistMerchantBacklogGroupApprovalDecision({
  db,
  businessId,
  actorId = null,
  selectedQboAccountId,
  rememberForFuture = true,
  groupSnapshotToken = null,
  transactionIds = [],
  exclusionIds = [],
  expectedRowVersions = {},
  idempotencyKey = null,
} = {}) {
  const operationId = buildMerchantApprovalOperationId({ businessId, idempotencyKey, groupSnapshotToken, transactionIds, selectedQboAccountId });
  const { account, group, excluded, candidateIds, rows, bankRows, policy, sourceMappings } = await resolveMerchantBacklogApproval({
    db,
    businessId,
    selectedQboAccountId,
    groupSnapshotToken,
    transactionIds,
    exclusionIds,
  });
  const ruleResult = await learnRuleForMerchantApproval({
    businessId,
    actorId,
    rememberForFuture,
    account,
    group,
    candidateIds,
    bankRows,
    db,
  });
  const saved = [];
  const blocked = [];
  for (const item of rows) {
    const bankTxn = bankRows.map.get(item.transaction_id);
    const expectedVersion = expectedRowVersions?.[item.transaction_id];
    const currentVersion = item.meta?.row_version || item.meta?.version || item.updated_at || null;
    if (expectedVersion && currentVersion && String(expectedVersion) !== String(currentVersion)) {
      blocked.push({ transaction_id: item.transaction_id, reason: "row_changed" });
      continue;
    }
    if (!bankTxn) {
      blocked.push({ transaction_id: item.transaction_id, reason: "missing_transaction" });
      continue;
    }
    const evaluation = await evaluateBacklogRowForRelease({ db, businessId, item, bankTxn, policy: buildPreviewPolicy(policy, { effectiveDate: bankTxn.date }), sourceMappings });
    const customerBucket = customerBucketForEvaluation({ item, bankTxn, evaluation, sourceMappings });
    if (!["ready_to_release", "merchant_approval_needed"].includes(customerBucket.bucket)) {
      blocked.push({ transaction_id: item.transaction_id, reason: customerBucket.reason });
      continue;
    }
    const recorded = await recordMerchantApprovalDecision({
      db,
      businessId,
      item,
      rule: ruleResult,
      account,
      actorId,
      group,
      duplicate: { confidence: "PENDING", reason: "background_duplicate_preflight_pending" },
      safety: { category: "decision_saved", reason: "background_safety_check_pending" },
      idempotencyKey,
      postAfter: null,
      operationId,
      operationState: "decision_saved",
    });
    if (recorded.ok) saved.push(recorded);
    else blocked.push(recorded);
  }
  return {
    ok: true,
    accepted: true,
    business_id: businessId,
    operation_id: operationId,
    state: "decision_saved",
    group_id: group.group_id,
    snapshot_token: group.snapshot_token,
    rule: ruleResult?.rule || null,
    remember_for_future: rememberForFuture === true,
    selected_transaction_count: candidateIds.length,
    saved_count: saved.length,
    blocked_count: blocked.length,
    saved,
    blocked,
    excluded_transaction_ids: Array.from(excluded),
  };
}

export async function runMerchantBacklogApprovalOperation({
  db,
  businessId,
  actorId = null,
  selectedQboAccountId,
  rememberForFuture = true,
  groupSnapshotToken = null,
  transactionIds = [],
  exclusionIds = [],
  expectedRowVersions = {},
  idempotencyKey = null,
  duplicatePreflight = defaultDuplicatePreflight,
  graceHours = DEFAULT_GRACE_HOURS,
  operationId = null,
} = {}) {
  const resolvedOperationId = operationId || buildMerchantApprovalOperationId({ businessId, idempotencyKey, groupSnapshotToken, transactionIds, selectedQboAccountId });
  const { account, group, excluded, candidateIds, rows, bankRows, policy, sourceMappings } = await resolveMerchantBacklogApproval({
    db,
    businessId,
    selectedQboAccountId,
    groupSnapshotToken,
    transactionIds,
    exclusionIds,
  });
  const ruleResult = await learnRuleForMerchantApproval({
    businessId,
    actorId,
    rememberForFuture,
    account,
    group,
    candidateIds,
    bankRows,
    db,
  });
  await markMerchantBacklogApprovalRowsState({
    db,
    businessId,
    operationId: resolvedOperationId,
    transactionIds: rows.map((row) => row.transaction_id),
    state: "checking_duplicates",
  });
  const scheduled = [];
  const blocked = [];
  for (const item of rows) {
    const bankTxn = bankRows.map.get(item.transaction_id);
    const expectedVersion = expectedRowVersions?.[item.transaction_id];
    const currentVersion = item.meta?.row_version || item.meta?.version || item.updated_at || null;
    if (expectedVersion && currentVersion && String(expectedVersion) !== String(currentVersion)) {
      blocked.push({ transaction_id: item.transaction_id, reason: "row_changed" });
      await markMerchantBacklogApprovalRowsState({ db, businessId, operationId: resolvedOperationId, transactionIds: [item.transaction_id], state: "blocked", reasonCode: "row_changed" });
      continue;
    }
    if (!bankTxn) {
      blocked.push({ transaction_id: item.transaction_id, reason: "missing_transaction" });
      await markMerchantBacklogApprovalRowsState({ db, businessId, operationId: resolvedOperationId, transactionIds: [item.transaction_id], state: "blocked", reasonCode: "missing_transaction" });
      continue;
    }
    const evaluation = await evaluateBacklogRowForRelease({ db, businessId, item, bankTxn, policy: buildPreviewPolicy(policy, { effectiveDate: bankTxn.date }), sourceMappings });
    const customerBucket = customerBucketForEvaluation({ item, bankTxn, evaluation, sourceMappings });
    if (!["ready_to_release", "merchant_approval_needed"].includes(customerBucket.bucket)) {
      blocked.push({ transaction_id: item.transaction_id, reason: customerBucket.reason });
      await markMerchantBacklogApprovalRowsState({ db, businessId, operationId: resolvedOperationId, transactionIds: [item.transaction_id], state: "blocked", reasonCode: customerBucket.reason });
      continue;
    }
    const duplicate = await duplicatePreflight({ businessId, transactionId: item.transaction_id, bankTxn, item, qboAccount: account, group });
    if (duplicate?.confidence && duplicate.confidence !== "NO_MATCH") {
      blocked.push({ transaction_id: item.transaction_id, reason: `duplicate_preflight_${duplicate.confidence}`, duplicate_preflight: duplicate });
      await markMerchantBacklogApprovalRowsState({ db, businessId, operationId: resolvedOperationId, transactionIds: [item.transaction_id], state: "blocked", reasonCode: `duplicate_preflight_${duplicate.confidence}` });
      continue;
    }
    if (duplicate?.ok === false && !duplicate.confidence) {
      blocked.push({ transaction_id: item.transaction_id, reason: duplicate.reason || "duplicate_preflight_required", duplicate_preflight: duplicate });
      await markMerchantBacklogApprovalRowsState({ db, businessId, operationId: resolvedOperationId, transactionIds: [item.transaction_id], state: "blocked", reasonCode: duplicate.reason || "duplicate_preflight_required" });
      continue;
    }
    const postAfter = policy.enabled === true ? computePostAfterForAutoPost(true, graceHours) : null;
    const recorded = await recordMerchantApprovalDecision({
      db,
      businessId,
      item,
      rule: ruleResult,
      account,
      actorId,
      group,
      duplicate,
      safety: evaluation,
      idempotencyKey,
      postAfter,
      operationId: resolvedOperationId,
      operationState: postAfter ? "scheduled" : "ready_to_post",
    });
    if (recorded.ok) scheduled.push(recorded);
    else blocked.push(recorded);
  }
  const summary = await getCanonicalPostingBacklogSummary({ db, businessId });
  return {
    ok: true,
    business_id: businessId,
    group_id: group.group_id,
    snapshot_token: group.snapshot_token,
    rule: ruleResult?.rule || null,
    remember_for_future: rememberForFuture === true,
    scheduled_count: scheduled.filter((row) => row.status === "scheduled").length,
    ready_count: scheduled.filter((row) => row.status === "ready_to_post").length,
    blocked_count: blocked.length,
    scheduled,
    blocked,
    excluded_transaction_ids: Array.from(excluded),
    backlog_summary: summary,
  };
}

async function markMerchantBacklogApprovalRowsState({
  db,
  businessId,
  operationId,
  transactionIds = [],
  state,
  reasonCode = null,
  message = null,
} = {}) {
  const ids = Array.from(new Set((transactionIds || []).filter(Boolean)));
  if (!db || !businessId || !operationId || !ids.length || !state) return { ok: true, updated_count: 0 };
  const rows = await fetchBacklogCategorizationRows(db, businessId, { transactionIds: ids });
  const now = new Date().toISOString();
  let updated = 0;
  for (const item of rows) {
    if (item?.meta?.merchant_group_operation_id && item.meta.merchant_group_operation_id !== operationId) continue;
    const nextMeta = {
      ...(item.meta || {}),
      merchant_group_operation_id: operationId,
      merchant_group_operation_state: state,
    };
    if (state === "failed") {
      nextMeta.safe_to_auto_post = false;
      nextMeta.merchant_group_operation_failed_at = now;
      nextMeta.merchant_group_operation_failure_code = reasonCode || "merchant_group_approval_operation_failed";
      nextMeta.merchant_group_operation_failure_message = String(message || "Posting approval could not finish.").slice(0, 500);
      nextMeta.per_row_safety_result = {
        ...(item.meta?.per_row_safety_result || {}),
        category: "approval_operation_failed",
        reason: reasonCode || "merchant_group_approval_operation_failed",
      };
    } else if (reasonCode) {
      nextMeta.merchant_group_operation_reason = reasonCode;
    }
    const patch = { meta: nextMeta, updated_at: now };
    if (state === "failed") patch.post_after = null;
    const { error } = await db
      .from("transaction_categorizations")
      .update(patch)
      .eq("business_id", businessId)
      .eq("transaction_id", item.transaction_id)
      .is("qbo_txn_id", null);
    if (error) throw wrapAutoPostDbError("merchant_group_operation_state_update_failed", error);
    updated += 1;
  }
  return { ok: true, updated_count: updated };
}

export async function markMerchantBacklogApprovalOperationFailed({
  db,
  businessId,
  operationId,
  transactionIds = [],
  reasonCode = "merchant_group_approval_operation_failed",
  message = null,
} = {}) {
  return markMerchantBacklogApprovalRowsState({
    db,
    businessId,
    operationId,
    transactionIds,
    state: "failed",
    reasonCode,
    message,
  });
}

export async function approveMerchantBacklogGroup(options = {}) {
  const decision = await persistMerchantBacklogGroupApprovalDecision(options);
  const result = await runMerchantBacklogApprovalOperation({
    ...options,
    transactionIds: decision.saved?.map((row) => row.transaction_id).filter(Boolean) || options.transactionIds,
    operationId: decision.operation_id,
  });
  return {
    ...result,
    operation_id: decision.operation_id,
    decision,
  };
}

export async function postReadyBacklogTransactions({
  db,
  businessId,
  transactionIds = [],
  duplicatePreflight = defaultDuplicatePreflight,
  graceHours = DEFAULT_GRACE_HOURS,
} = {}) {
  const summary = await getCanonicalPostingBacklogSummary({ db, businessId, transactionIds });
  const readyIds = summary.rows.filter((row) => row.bucket === "ready_to_release").map((row) => row.transaction_id);
  const rows = await fetchBacklogCategorizationRows(db, businessId, { transactionIds: readyIds });
  const bankRows = await fetchBacklogBankRows(db, businessId, readyIds);
  const scheduled = [];
  const blocked = [];
  for (const item of rows) {
    const bankTxn = bankRows.map.get(item.transaction_id);
    const duplicate = await duplicatePreflight({ businessId, transactionId: item.transaction_id, bankTxn, item });
    if (duplicate?.confidence && duplicate.confidence !== "NO_MATCH") {
      blocked.push({ transaction_id: item.transaction_id, reason: `duplicate_preflight_${duplicate.confidence}` });
      continue;
    }
    const postAfter = computePostAfterForAutoPost(true, graceHours);
    const { error } = await db
      .from("transaction_categorizations")
      .update({
        post_after: postAfter,
        post_error: null,
        updated_at: new Date().toISOString(),
        meta: {
          ...(item.meta || {}),
          safe_to_auto_post: true,
          ready_release_scheduled_at: new Date().toISOString(),
        },
      })
      .eq("business_id", businessId)
      .eq("transaction_id", item.transaction_id)
      .is("qbo_txn_id", null)
      .in("status", ["approved", "auto_approved"]);
    if (error) blocked.push({ transaction_id: item.transaction_id, reason: error.message || "schedule_failed" });
    else scheduled.push({ transaction_id: item.transaction_id, post_after: postAfter });
  }
  return {
    ok: true,
    scheduled,
    blocked,
    backlog_summary: await getCanonicalPostingBacklogSummary({ db, businessId }),
  };
}

async function fetchSourceMappingRows(db, businessId, plaidAccountIds = []) {
  const ids = Array.from(new Set((plaidAccountIds || []).filter(Boolean)));
  const map = new Map();
  if (!ids.length) return map;
  for (const batch of chunk(ids)) {
    const { data, error } = await db
      .from("plaid_qbo_account_mappings")
      .select("plaid_account_id,qbo_account_id,qbo_account_name")
      .eq("business_id", businessId)
      .in("plaid_account_id", batch);
    if (error) throw wrapAutoPostDbError("auto_post_backlog_preview_source_mappings_failed", error);
    for (const row of data || []) {
      if (row?.plaid_account_id && row?.qbo_account_id) map.set(row.plaid_account_id, row);
    }
  }
  return map;
}

function buildPreviewPolicy(policy = {}, { effectiveDate = null } = {}) {
  const normalizedEffectiveDate = normalizeDateString(effectiveDate);
  if (!normalizedEffectiveDate) return policy;
  return {
    ...policy,
    enabled: true,
    auto_post_scope_mode: AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE,
    auto_post_effective_date: normalizedEffectiveDate,
    historical_backlog_status: "released",
    active_backlog_releases: [
      ...(Array.isArray(policy.active_backlog_releases) ? policy.active_backlog_releases : []),
      {
        status: "active",
        release_start_date: normalizedEffectiveDate,
        release_end_date: null,
        transaction_ids: [],
      },
    ],
  };
}

export async function previewAutoPostBacklog({
  db,
  businessId,
  rangeStart = null,
  rangeEnd = null,
  transactionIds = [],
  effectiveDate = null,
} = {}) {
  if (!db || !businessId) {
    const err = new Error("businessId is required.");
    err.status = 400;
    err.code = "missing_business_id";
    throw err;
  }
  const start = normalizeDateString(rangeStart || effectiveDate);
  const end = normalizeDateString(rangeEnd);
  const reevaluation = await reEvaluateAutoPostBacklog({
    db,
    businessId,
    rangeStart: start,
    rangeEnd: end,
    transactionIds,
    effectiveDate: effectiveDate || start,
  });
  const sample = reevaluation.evaluations.slice(0, 50).map((item) => ({
    transaction_id: item.transaction_id,
    date: item.date || null,
    status: item.status,
    category: item.category,
    reason: item.reason,
  }));
  const preview = {
    ok: true,
    business_id: businessId,
    scope: {
      range_start: start,
      range_end: end,
      effective_date: normalizeDateString(effectiveDate || start),
      transaction_ids_count: transactionIds.length,
    },
    total: reevaluation.total,
    eligible_count: reevaluation.eligible_count,
    blocked_count: reevaluation.blocked_count,
    eligible_transaction_ids: reevaluation.eligible_transaction_ids,
    reevaluated_safe_transaction_ids: reevaluation.reevaluated_safe_transaction_ids,
    buckets: reevaluation.buckets,
    reasons: reevaluation.reasons,
    sample,
  };
  return {
    ...preview,
    preview_fingerprint: buildBacklogPreviewFingerprint(preview),
  };
}

async function scheduleBacklogRows({ db, businessId, evaluations = [], postAfter = null, batchSize = 50 } = {}) {
  const eligible = evaluations.filter((row) => row.category === BACKLOG_ELIGIBLE_BUCKET);
  const released = [];
  const failed = [];
  for (const batch of chunk(eligible, batchSize)) {
    for (const row of batch) {
      const releasedAt = new Date().toISOString();
      const { error } = await db
        .from("transaction_categorizations")
        .update({
          status: "auto_approved",
          post_after: postAfter,
          post_error: null,
          updated_at: releasedAt,
          meta: {
            ...(row.meta || {}),
            safe_to_auto_post: true,
            auto_post_backlog_released_at: releasedAt,
          },
        })
        .eq("business_id", businessId)
        .eq("transaction_id", row.transaction_id)
        .is("qbo_txn_id", null)
        .in("status", ["approved", "auto_approved"]);
      if (error) {
        failed.push({ transaction_id: row.transaction_id, reason: error.message || "schedule_failed" });
      } else {
        released.push(row.transaction_id);
      }
    }
  }
  return { released, failed };
}

async function confirmAutoPostScopeFromPreview({
  db,
  businessId,
  requestedBy = null,
  effectiveDate,
  eligibleTransactionIds = [],
  preview = {},
  previewFingerprint,
  enabledAt = null,
  metadata = {},
} = {}) {
  if (typeof db?.rpc !== "function") {
    const err = new Error("Auto-post scope confirmation RPC is not installed.");
    err.status = 500;
    err.code = "auto_post_scope_rpc_unavailable";
    throw err;
  }
  const { data, error } = await db.rpc("confirm_auto_post_effective_date_scope", {
    p_business_id: businessId,
    p_scope_mode: AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE,
    p_effective_date: effectiveDate,
    p_requested_by: requestedBy,
    p_transaction_ids: Array.from(new Set(eligibleTransactionIds || [])).sort(),
    p_preview_total_count: Number(preview.total || 0),
    p_released_transaction_count: Number(preview.eligible_count || 0),
    p_blocked_transaction_count: Number(preview.blocked_count || 0),
    p_preview_fingerprint: previewFingerprint,
    p_enabled_at: enabledAt,
    p_release_metadata: {
      ...(metadata || {}),
      source: "auto_post_enablement",
      preview_acknowledged: true,
      scope_mode: AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE,
      preview_total_count: Number(preview.total || 0),
      eligible_count: Number(preview.eligible_count || 0),
      blocked_count: Number(preview.blocked_count || 0),
      buckets: preview.buckets || {},
    },
  });
  if (error) throw wrapAutoPostDbError("auto_post_scope_confirmation_failed", error);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    ok: true,
    release_id: row?.release_id || null,
    status: row?.release_status || "active",
    released_transaction_count: Number(row?.released_transaction_count ?? preview.eligible_count ?? 0),
    preview_total_count: Number(row?.preview_total_count ?? preview.total ?? 0),
    blocked_transaction_count: Number(row?.blocked_transaction_count ?? preview.blocked_count ?? 0),
    preview_fingerprint: row?.preview_fingerprint || previewFingerprint,
    buckets: preview.buckets || {},
  };
}

export async function releaseAutoPostBacklogScope({
  db,
  businessId,
  requestedBy = null,
  rangeStart = null,
  rangeEnd = null,
  transactionIds = [],
  metadata = {},
  previewFingerprint = null,
} = {}) {
  if (!db || !businessId) {
    const err = new Error("businessId is required.");
    err.status = 400;
    err.code = "missing_business_id";
    throw err;
  }
  const start = normalizeDateString(rangeStart);
  const end = normalizeDateString(rangeEnd);
  let ids = Array.from(new Set((transactionIds || []).filter(Boolean)));
  if (!start && !end && !ids.length) {
    const err = new Error("Backlog release requires a date range or explicit transaction IDs.");
    err.status = 400;
    err.code = "backlog_release_scope_required";
    throw err;
  }
  const preview = await previewAutoPostBacklog({
    db,
    businessId,
    rangeStart: start,
    rangeEnd: end,
    transactionIds: ids,
    effectiveDate: start,
  });
  const confirmedFingerprint = assertMatchingPreviewFingerprint(preview, previewFingerprint);
  if (!ids.length) ids = preview.eligible_transaction_ids || [];
  const confirmation = await confirmAutoPostScopeFromPreview({
    db,
    businessId,
    requestedBy,
    effectiveDate: start,
    eligibleTransactionIds: ids,
    preview: {
      ...preview,
      eligible_count: ids.length,
      blocked_count: preview.blocked_count,
    },
    previewFingerprint: confirmedFingerprint,
    metadata,
  });
  const fresh = await reEvaluateAutoPostBacklog({
    db,
    businessId,
    rangeStart: start,
    rangeEnd: end,
    transactionIds: ids,
    effectiveDate: start,
  });
  const postAfter = computePostAfterForAutoPost(true, DEFAULT_GRACE_HOURS);
  const schedule = await scheduleBacklogRows({
    db,
    businessId,
    evaluations: fresh.evaluations,
    postAfter,
  });
  return {
    ...confirmation,
    attempted: ids.length,
    released: schedule.released.length,
    skipped: Math.max(0, ids.length - schedule.released.length),
    failed: schedule.failed.length,
    post_after: postAfter,
    skipped_reason_counts: fresh.reasons || {},
    failed_rows: schedule.failed,
  };
}
