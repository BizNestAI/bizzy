function isMissingAutoPostColumn(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return error?.code === "42703" || message.includes("auto_post_to_quickbooks");
}

const DEFAULT_GRACE_HOURS = 24;
const POSTGREST_IN_BATCH_SIZE = 50;

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

async function updateBacklogPostAfter(db, businessId, transactionIds = [], postAfter, nowIso) {
  for (const ids of chunk(transactionIds)) {
    const { error } = await db
      .from("transaction_categorizations")
      .update({
        post_after: postAfter,
        post_error: null,
        updated_at: nowIso,
      })
      .eq("business_id", businessId)
      .in("transaction_id", ids)
      .is("qbo_txn_id", null)
      .in("status", ["approved", "auto_approved"]);
    if (error) throw wrapAutoPostDbError("auto_post_backlog_schedule_failed", error);
  }
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
  const enabled = await getAutoPostToQuickBooks(db, businessId);
  const backlogIds = await getHandledBacklogTransactionIds(db, businessId);
  return {
    enabled,
    auto_post_to_quickbooks: enabled,
    handled_backlog_count: backlogIds.length,
    posting_grace_hours: normalizeGraceHours(graceHours),
  };
}

export async function setAutoPostEnabled({
  db,
  businessId,
  enabled,
  confirmBacklog = false,
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

  if (nextEnabled && !currentEnabled && confirmBacklog !== true) {
    const err = new Error(
      backlogIds.length
        ? `You have ${backlogIds.length} handled transactions waiting. Turning on Auto-post will make them eligible for QuickBooks posting after the posting grace period.`
        : "Turn on automatic QuickBooks posting?"
    );
    err.status = 409;
    err.code = backlogIds.length ? "auto_post_backlog_confirmation_required" : "auto_post_confirmation_required";
    err.requires_confirmation = true;
    err.handled_backlog_count = backlogIds.length;
    throw err;
  }

  const { data: business, error: updateErr } = await db
    .from("business_profiles")
    .update({ auto_post_to_quickbooks: nextEnabled })
    .eq("id", businessId)
    .select("id,auto_post_to_quickbooks")
    .maybeSingle();
  if (updateErr) throw wrapAutoPostDbError("auto_post_settings_update_failed", updateErr);

  const normalizedGraceHours = normalizeGraceHours(graceHours);
  const nowIso = new Date(nowMs).toISOString();
  const postAfter = computePostAfterForAutoPost(nextEnabled, normalizedGraceHours, nowMs);

  if (backlogIds.length) {
    if (nextEnabled) {
      await updateBacklogPostAfter(db, businessId, backlogIds, postAfter, nowIso);
    } else {
      await clearBacklogPostAfter(db, businessId, backlogIds, nowIso);
    }
  }

  return {
    ok: true,
    enabled: business?.auto_post_to_quickbooks === true,
    auto_post_to_quickbooks: business?.auto_post_to_quickbooks === true,
    handled_backlog_count: backlogIds.length,
    scheduled_backlog_count: nextEnabled ? backlogIds.length : 0,
    posting_grace_hours: normalizedGraceHours,
    post_after: nextEnabled ? postAfter : null,
  };
}
