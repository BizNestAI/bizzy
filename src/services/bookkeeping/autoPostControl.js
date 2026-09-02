/* global process */
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

function normalizeScopeMode(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE) return AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE;
  if (normalized === AUTO_POST_SCOPE_MODES.EXPLICIT_BACKLOG_RELEASED) return AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE;
  return AUTO_POST_SCOPE_MODES.NEW_ACTIVITY_ONLY;
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
  const wrapped = new Error(`${operation}: ${error?.message || String(error)}`);
  wrapped.code = error?.code || operation;
  wrapped.status = error?.status || 500;
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

export async function getAutoPostSettings({ db, businessId, graceHours = DEFAULT_GRACE_HOURS } = {}) {
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
  if (enabled && policy.historical_backlog_status === "review_required" && backlogIds.length > 0) {
    try {
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
    } catch {
      backlogPreviewSummary = null;
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
  const normalizedScopeMode = normalizeScopeMode(scopeMode);
  const normalizedEffectiveDate = normalizeDateString(effectiveDate);

  if (
    nextEnabled &&
    normalizedScopeMode === AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE &&
    (!normalizedEffectiveDate || previewAcknowledged !== true)
  ) {
    const err = new Error("Choose an effective date and confirm the preview before including existing Handled transactions.");
    err.status = 409;
    err.code = "auto_post_effective_date_confirmation_required";
    err.requires_confirmation = true;
    err.handled_backlog_count = backlogIds.length;
    throw err;
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

  let releaseResult = null;
  if (nextEnabled && normalizedScopeMode === AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE) {
    releaseResult = await releaseAutoPostBacklogScope({
      db,
      businessId,
      requestedBy,
      rangeStart: normalizedEffectiveDate,
      metadata: {
        source: "auto_post_enablement",
        preview_acknowledged: true,
        scope_mode: AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE,
      },
    });
  }

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
      releaseResult?.released_transaction_count > 0
        ? "released"
        : nextEnabled && backlogIds.length
          ? "review_required"
          : "none",
    requires_backlog_review: nextEnabled && !releaseResult && backlogIds.length > 0,
    auto_post_scope_mode: normalizedScopeMode,
    auto_post_effective_date:
      normalizedScopeMode === AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE ? normalizedEffectiveDate : null,
    release: releaseResult,
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

async function fetchBacklogCategorizationRows(db, businessId, { transactionIds = [] } = {}) {
  let query = db
    .from("transaction_categorizations")
    .select("transaction_id,business_id,status,final_qbo_account_id,final_qbo_account_name,post_after,post_error,meta,qbo_txn_id")
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
      .select("id,business_id,plaid_account_id,date,pending,is_archived,amount,direction,transaction_type")
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
  const start = normalizeDateString(rangeStart);
  const end = normalizeDateString(rangeEnd);
  const rows = await fetchBacklogCategorizationRows(db, businessId, {
    transactionIds,
  });
  const bankRows = await fetchBacklogBankRows(db, businessId, rows.map((row) => row.transaction_id));
  const sourceMappings = await fetchSourceMappingRows(
    db,
    businessId,
    Array.from(new Set(Array.from(bankRows.map.values()).map((row) => row.plaid_account_id).filter(Boolean)))
  );
  const basePolicy = await getAutoPostPolicy(db, businessId);
  const policy = buildPreviewPolicy(basePolicy, { effectiveDate: effectiveDate || start });
  const buckets = {};
  const sample = [];
  const eligibleIds = [];
  let scopedTotal = 0;
  for (const item of rows) {
    const bankTxn = bankRows.map.get(item.transaction_id) || {};
    if (start && bankTxn.date && bankTxn.date < start) continue;
    if (end && bankTxn.date && bankTxn.date >= end) continue;
    scopedTotal += 1;
    let category = bankRows.missing.includes(item.transaction_id)
      ? "missing_transaction"
      : classifyAutoPostBacklogCandidate({ item, bankTxn, policy });
    if (category === BACKLOG_ELIGIBLE_BUCKET && bankTxn.plaid_account_id && !sourceMappings.has(bankTxn.plaid_account_id)) {
      category = "missing_source_mapping";
    }
    buckets[category] = (buckets[category] || 0) + 1;
    if (category === BACKLOG_ELIGIBLE_BUCKET) eligibleIds.push(item.transaction_id);
    if (sample.length < 50) {
      sample.push({
        transaction_id: item.transaction_id,
        date: bankTxn.date || null,
        status: item.status,
        category,
      });
    }
  }
  const blockedTotal = scopedTotal - eligibleIds.length;
  return {
    ok: true,
    business_id: businessId,
    scope: {
      range_start: start,
      range_end: end,
      effective_date: normalizeDateString(effectiveDate || start),
      transaction_ids_count: transactionIds.length,
    },
    total: scopedTotal,
    eligible_count: eligibleIds.length,
    blocked_count: blockedTotal,
    eligible_transaction_ids: eligibleIds,
    buckets,
    sample,
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
  if (!ids.length) ids = preview.eligible_transaction_ids || [];
  const nowIso = new Date().toISOString();
  const insertPayload = {
    business_id: businessId,
    release_start_date: start,
    release_end_date: end,
    transaction_ids: ids,
    requested_by: requestedBy,
    requested_at: nowIso,
    release_metadata: {
      ...(metadata || {}),
      preview_total_count: preview.total,
      eligible_count: preview.eligible_count,
      blocked_count: preview.blocked_count,
      buckets: preview.buckets,
    },
    preview_total_count: preview.total,
    released_transaction_count: ids.length,
    blocked_transaction_count: preview.blocked_count,
  };
  let { data: release, error: releaseError } = await db
    .from("bookkeeping_auto_post_backlog_releases")
    .insert(insertPayload)
    .select("id")
    .maybeSingle();
  if (isMissingAutoPostColumn(releaseError)) {
    const legacyPayload = { ...insertPayload };
    delete legacyPayload.preview_total_count;
    delete legacyPayload.released_transaction_count;
    delete legacyPayload.blocked_transaction_count;
    ({ data: release, error: releaseError } = await db
      .from("bookkeeping_auto_post_backlog_releases")
      .insert(legacyPayload)
      .select("id")
      .maybeSingle());
  }
  if (releaseError) throw wrapAutoPostDbError("auto_post_backlog_release_insert_failed", releaseError);

  const { error: businessError } = await db
    .from("business_profiles")
    .update({
      auto_post_scope_mode: AUTO_POST_SCOPE_MODES.EFFECTIVE_DATE,
      auto_post_effective_date: start,
      historical_backlog_status: "released",
      backlog_reviewed_at: nowIso,
      backlog_reviewed_by: requestedBy,
      backlog_released_at: nowIso,
      backlog_released_by: requestedBy,
    })
    .eq("id", businessId);
  if (businessError) throw wrapAutoPostDbError("auto_post_backlog_release_policy_failed", businessError);
  return {
    ok: true,
    release_id: release?.id || null,
    released_transaction_count: ids.length,
    preview_total_count: preview.total,
    blocked_transaction_count: preview.blocked_count,
    buckets: preview.buckets,
  };
}
