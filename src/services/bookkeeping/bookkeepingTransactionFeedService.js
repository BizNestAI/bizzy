import { supabase } from "../supabaseAdmin.js";
import { formatPlaidAccountDisplayLabel } from "./postingTraceDisplay.js";
import { deriveCreditCardPaymentStatus, isCreditCardPaymentWorkflow } from "./creditCardPaymentStatus.js";
import { classifyAutoPostOperationalScope, getAutoPostPolicy } from "./autoPostControl.js";

function firstDayOfMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function computeRangeStartDate(range) {
  const now = new Date();
  switch (range) {
    case "last_30": {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return d;
    }
    case "last_90": {
      const d = new Date(now);
      d.setDate(d.getDate() - 90);
      return d;
    }
    case "all":
      return null;
    case "this_month":
    default:
      return firstDayOfMonth();
  }
}

export function normalizeBookkeepingDate(d) {
  if (!d) return null;
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function rangeStartDateForBookkeeping(rangeParam = "this_month") {
  const rangeStart = computeRangeStartDate(String(rangeParam || "this_month").toLowerCase());
  return rangeStart ? normalizeBookkeepingDate(rangeStart) : null;
}

function resolveRangeStart({ rangeParam = "this_month", rangeStart } = {}) {
  if (rangeStart !== undefined) return normalizeBookkeepingDate(rangeStart);
  return rangeStartDateForBookkeeping(rangeParam);
}

export function matchesTransactionStatusFilter(statusFilter, cat = {}) {
  const status = cat?.status || "needs_review";
  const isCheckTxn = cat?.meta?.is_check === true;
  const pending = cat?.pending === true || cat?.bank_pending === true || cat?.meta?.pending === true;
  const handledView = statusFilter === "approved" || statusFilter === "handled";
  const postedView = statusFilter === "posted";
  const pendingView = statusFilter === "pending";

  if (pendingView) return pending;
  if (pending && !postedView) return false;

  if (postedView) {
    const hasQbo = Boolean(cat?.qbo_txn_id);
    return status === "posted" || hasQbo;
  }

  if (handledView) {
    return ["approved", "auto_approved", "failed"].includes(status);
  }

  if (!status || status === "needs_review" || status === "uncategorized") return true;
  if (status === "auto_approved" && isCheckTxn) return true;
  return false;
}

function normalizeOperatorRequest(row = null) {
  if (!row) return null;
  return {
    id: row.id || null,
    status: row.status || null,
    prompt_text: row.prompt_text || null,
    answer_text: row.answer_text || null,
    selected_intent: row.selected_intent || row.meta?.selected_intent || null,
    answered_at: row.answered_at || null,
    resolved_at: row.resolved_at || null,
  };
}

function normalizeBookkeepingTransactionRow(row, cat = {}, acctName = null, operatorRequest = null) {
  const specialCcPayment = isCreditCardPaymentWorkflow({
    taxonomy_type: cat.meta?.taxonomy_type || null,
    cc_payment_rejected: cat.meta?.cc_payment_rejected,
    cc_payment_pair_id: cat.meta?.cc_payment_pair_id,
    meta: cat.meta || {},
  });
  const suggestedId = specialCcPayment ? null : cat.suggested_qbo_account_id || null;
  const suggestedName = specialCcPayment ? null : cat.suggested_qbo_account_name || null;
  const finalId = specialCcPayment ? null : cat.final_qbo_account_id || null;
  const finalName = specialCcPayment ? null : cat.final_qbo_account_name || null;
  const amount = Number(row.amount || 0);
  const dir = row.direction || (amount < 0 ? "OUTFLOW" : amount > 0 ? "INFLOW" : "UNKNOWN");
  const normalized = {
    id: row.id,
    plaidTransactionId: row.plaid_transaction_id || null,
    plaidAccountId: row.plaid_account_id || null,
    plaid_account_id: row.plaid_account_id || null,
    date: row.date,
    vendor: row.counterparty_name || row.merchant_name || "",
    payee: row.counterparty_name || row.merchant_name || "",
    description: row.name || "",
    amount,
    signed_amount: amount,
    direction: dir,
    pending: row.pending === true,
    category_primary: row.category_primary || null,
    category_detailed: row.category_detailed || null,
    personal_finance_category: row.personal_finance_category || null,
    currentAccount: acctName,
    bank_account: acctName,
    account_name: row.account_name || null,
    account_official_name: row.account_official_name || null,
    account_mask: row.account_mask || row.mask || null,
    account_type: row.account_type || null,
    account_subtype: row.account_subtype || null,
    institution_name: row.institution_name || row.institution || null,
    suggestedAccountId: suggestedId,
    suggestedAccountName: suggestedName,
    suggested_canonical_account_key: cat.suggested_canonical_account_key || null,
    final_qbo_account_id: finalId,
    final_qbo_account_name: finalName,
    final_canonical_account_key: cat.final_canonical_account_key || null,
    glAccountId: finalId || suggestedId || null,
    glAccountName: finalName || suggestedName || null,
    confidence: cat.confidence || null,
    reason: cat.reason || null,
    status: cat.status || "needs_review",
    payeeSource: row.counterparty_source || null,
    payeeConfidence: row.counterparty_confidence || null,
    canonicalVendorId: row.canonical_vendor_id || null,
    qboEntityType: row.qbo_entity_type || null,
    qboEntityId: row.qbo_entity_id || null,
    is_check: cat.meta?.is_check === true,
    check_number: cat.meta?.check_number || null,
    vendor_rule_id: cat.meta?.vendor_rule_id || null,
    suggestion_source: cat.meta?.suggestion_source || null,
    vendor_rule_match_reason: cat.meta?.vendor_rule_match_reason || null,
    posted_at: cat.posted_at || null,
    reconciled_at: cat.reconciled_at || null,
    qbo_txn_type: cat.qbo_txn_type || null,
    qbo_txn_id: cat.qbo_txn_id || null,
    post_after: cat.post_after || null,
    post_error: cat.post_error || null,
    last_post_attempt_at: cat.last_post_attempt_at || null,
    meta: cat.meta || null,
    taxonomy_type: cat.meta?.taxonomy_type || null,
    cc_payment_pair_id: cat.meta?.cc_payment_pair_id || null,
    cc_payment_pair_role: cat.meta?.cc_payment_pair_role || null,
    cc_payment_pair_txn_id: cat.meta?.cc_payment_pair_txn_id || null,
    cc_payment_pair_status: cat.meta?.cc_payment_pair_status || null,
    cc_payment_pair_confidence: cat.meta?.cc_payment_pair_confidence || null,
    cc_payment_bank_qbo_account_id: cat.meta?.cc_payment_bank_qbo_account_id || null,
    cc_payment_bank_qbo_account_name: cat.meta?.cc_payment_bank_qbo_account_name || null,
    cc_payment_cc_qbo_account_id: cat.meta?.cc_payment_cc_qbo_account_id || null,
    cc_payment_cc_qbo_account_name: cat.meta?.cc_payment_cc_qbo_account_name || null,
    cc_payment_transfer_target_qbo_account_id: cat.meta?.cc_payment_transfer_target_qbo_account_id || null,
    cc_payment_transfer_target_qbo_account_name: cat.meta?.cc_payment_transfer_target_qbo_account_name || null,
    cc_payment_pair_counterpart_amount: cat.meta?.cc_payment_pair_counterpart_amount ?? null,
    cc_payment_pair_counterpart_date: cat.meta?.cc_payment_pair_counterpart_date || null,
    cc_payment_pair_counterpart_account_name: cat.meta?.cc_payment_pair_counterpart_account_name || null,
    cc_payment_rejected: cat.meta?.cc_payment_rejected === true || cat.meta?.taxonomy_override === "not_cc_payment",
    duplicate_risk: cat.meta?.duplicate_risk === true || cat.meta?.possible_duplicate === true || null,
    relink_status: cat.meta?.relink_status || null,
    operator_request: normalizeOperatorRequest(operatorRequest),
    customer_answered: Boolean(operatorRequest?.answer_text && operatorRequest?.status === "answered" && !operatorRequest?.resolved_at),
    customer_response: operatorRequest?.answer_text || null,
    customer_responded_at: operatorRequest?.answered_at || null,
  };
  const ccStatus = deriveCreditCardPaymentStatus(normalized);
  return ccStatus
    ? {
        ...normalized,
        credit_card_payment_status: ccStatus,
        glAccountId: null,
        glAccountName: null,
        suggestedAccountId: null,
        suggestedAccountName: null,
        final_qbo_account_id: null,
        final_qbo_account_name: null,
      }
    : normalized;
}

export function normalizeBookkeepingRpcRow(row = {}) {
  const operatorRequest = row.operator_request_id
    ? {
        id: row.operator_request_id,
        status: row.operator_request_status,
        prompt_text: row.operator_prompt_text,
        answer_text: row.operator_answer_text,
        selected_intent: row.operator_selected_intent,
        answered_at: row.operator_answered_at,
        resolved_at: row.operator_resolved_at,
        meta: row.operator_meta,
      }
    : null;
  return normalizeBookkeepingTransactionRow(
    row,
    {
      status: row.cat_status,
      suggested_qbo_account_id: row.suggested_qbo_account_id,
      suggested_qbo_account_name: row.suggested_qbo_account_name,
      suggested_canonical_account_key: row.suggested_canonical_account_key,
      confidence: row.confidence,
      reason: row.reason,
      final_qbo_account_id: row.final_qbo_account_id,
      final_qbo_account_name: row.final_qbo_account_name,
      final_canonical_account_key: row.final_canonical_account_key,
      post_after: row.post_after,
      qbo_txn_id: row.qbo_txn_id,
      qbo_txn_type: row.qbo_txn_type,
      posted_at: row.posted_at,
      reconciled_at: row.reconciled_at,
      post_error: row.post_error,
      last_post_attempt_at: row.last_post_attempt_at,
      meta: row.cat_meta,
    },
    row.account_name || row.account_official_name || null,
    operatorRequest
  );
}

async function fetchPlaidAccountDisplayMap({ db = supabase, businessId, plaidAccountIds = [] } = {}) {
  const ids = Array.from(new Set((plaidAccountIds || []).map((id) => String(id || "").trim()).filter(Boolean)));
  if (!ids.length || !businessId || typeof db?.from !== "function") return new Map();

  const [{ data, error }, { data: mappings, error: mappingError }] = await Promise.all([
    db
      .from("plaid_accounts")
      .select("plaid_account_id,name,official_name,mask,type,subtype,institution_name,institution")
      .eq("business_id", businessId)
      .in("plaid_account_id", ids),
    db
      .from("plaid_qbo_account_mappings")
      .select("plaid_account_id,qbo_account_id,qbo_account_name,qbo_account_type")
      .eq("business_id", businessId)
      .in("plaid_account_id", ids),
  ]);

  if (error) return new Map();
  const mappingByPlaidId = mappingError
    ? new Map()
    : new Map((mappings || []).map((row) => [String(row.plaid_account_id), row]));

  return new Map((data || []).map((account) => [
    String(account.plaid_account_id),
    (() => {
      const mapping = mappingByPlaidId.get(String(account.plaid_account_id));
      return {
        bank_account: formatPlaidAccountDisplayLabel(account),
        currentAccount: formatPlaidAccountDisplayLabel(account),
        account_name: account.name || null,
        account_official_name: account.official_name || null,
        account_mask: account.mask || null,
        account_type: account.type || null,
        account_subtype: account.subtype || null,
        institution_name: account.institution_name || account.institution || null,
        source_qbo_account_id: mapping?.qbo_account_id || null,
        source_qbo_account_name: mapping?.qbo_account_name || null,
        source_qbo_account_type: mapping?.qbo_account_type || null,
      };
    })(),
  ]));
}

function isHandledForPosting(row = {}) {
  return ["approved", "auto_approved", "failed", "handled"].includes(String(row.status || "").toLowerCase());
}

function buildPostingLifecycleForFeed(row = {}, policy = {}, nowMs = Date.now()) {
  if (row.qbo_txn_id) return null;
  if (!isHandledForPosting(row)) return null;
  const meta = row.meta || {};
  if (row.pending === true) {
    return {
      key: "pending",
      label: "Pending",
      tone: "warning",
      detail: "Plaid transaction is pending and is not ready for approval or QBO posting.",
    };
  }
  const scope = classifyAutoPostOperationalScope({ item: row, bankTxn: row, policy });
  if (!scope.allowed && scope.code === "historical_scope_review_required") {
    return {
      key: "held_historical_backlog",
      label: "Held: historical backlog review",
      tone: "warning",
      detail: "This older handled transaction needs an explicit backlog release before auto-posting.",
    };
  }
  if (!row.final_qbo_account_id && !meta?.cc_payment_cc_qbo_account_id) {
    return {
      key: "blocked_missing_final_account",
      label: "Blocked: missing final account",
      tone: "danger",
      detail: "Choose a final QuickBooks account before posting.",
    };
  }
  const unsupportedTaxonomy = ["transfer_internal", "owner_draw", "owner_contribution", "refund"].includes(
    String(meta.taxonomy_type || "")
  );
  if (unsupportedTaxonomy) {
    return {
      key: "blocked_unsupported_transaction_type",
      label: "Blocked: unsupported transaction type",
      tone: "danger",
      detail: "This transaction type needs review before QuickBooks posting.",
    };
  }
  const looksCcPayment =
    meta.taxonomy_type === "cc_payment" ||
    meta.cc_payment_bank_qbo_account_id ||
    meta.cc_payment_cc_qbo_account_id ||
    meta.cc_payment_mapping_confidence;
  if (
    looksCcPayment &&
    !(
      meta.safe_to_auto_post === true &&
      meta.cc_payment_bank_qbo_account_id &&
      meta.cc_payment_cc_qbo_account_id
    )
  ) {
    return {
      key: "blocked_unsupported_transaction_type",
      label: "Blocked: unsupported transaction type",
      tone: "danger",
      detail: "Credit-card payment rows need a verified source and destination account before posting.",
    };
  }
  if (meta.safe_to_auto_post !== true && meta.auto_approve_reason !== "manual_user") {
    return {
      key: "blocked_unsafe_auto_post",
      label: "Blocked: not safe for auto-post",
      tone: "warning",
      detail: "Bizzi needs a safer posting match before auto-posting this row.",
    };
  }
  const postAfterMs = row.post_after ? Date.parse(row.post_after) : null;
  if (Number.isFinite(postAfterMs)) {
    if (postAfterMs <= nowMs) {
      return {
        key: "ready_to_post",
        label: "Ready to post",
        tone: "warning",
        detail: "Eligible for the next QuickBooks posting worker run.",
      };
    }
    return null;
  }
  return null;
}

export async function countBookkeepingTransactions({
  businessId,
  statusFilter = "needs_review",
  accountId = null,
  rangeParam = "this_month",
  rangeStart,
  rangeEnd = null,
  db = supabase,
} = {}) {
  const { data, error } = await db.rpc("count_bookkeeping_transactions_bounded", {
    p_business_id: businessId,
    p_status_filter: statusFilter,
    p_account_id: accountId || null,
    p_range_start: resolveRangeStart({ rangeParam, rangeStart }),
    p_range_end: normalizeBookkeepingDate(rangeEnd),
  });
  if (error) throw error;
  return Number(data || 0);
}

// Job Costing uses posted Books transactions as the source of truth.
export function normalizePostedBookTransaction(row = {}) {
  const bankMemo =
    row.bank_memo ||
    row.memo ||
    row.transaction_memo ||
    row.plaid_memo ||
    row.original_description ||
    row.originalDescription ||
    row.name ||
    row.description ||
    "";

  return {
    id: row.id,
    transaction_id: row.id,
    date: row.date,
    vendor: row.vendor || row.payee || "",
    payee: row.payee || row.vendor || "",
    description: bankMemo,
    memo: bankMemo,
    bank_memo: bankMemo,
    original_description: row.original_description || row.originalDescription || row.name || row.description || "",
    amount: Number(row.amount || 0),
    direction: row.direction || (Number(row.amount || 0) < 0 ? "OUTFLOW" : "INFLOW"),
    final_qbo_account_id: row.final_qbo_account_id || row.glAccountId || null,
    final_qbo_account_name: row.final_qbo_account_name || row.glAccountName || null,
    gl_account_id: row.final_qbo_account_id || row.glAccountId || null,
    gl_account: row.final_qbo_account_name || row.glAccountName || "Uncategorized",
    qbo_txn_id: row.qbo_txn_id || null,
    qbo_txn_type: row.qbo_txn_type || null,
    posted_at: row.posted_at || null,
    plaid_account_id: row.plaid_account_id || row.plaidAccountId || null,
    status: row.status || "posted",
  };
}

export async function fetchBookkeepingTransactions({
  businessId,
  statusFilter = "needs_review",
  accountId = null,
  rangeParam = "this_month",
  rangeStart,
  rangeEnd = null,
  page = 1,
  pageSize = 25,
  db = supabase,
} = {}) {
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 200);
  const { data, error } = await db.rpc("get_bookkeeping_transactions_bounded", {
    p_business_id: businessId,
    p_status_filter: statusFilter,
    p_account_id: accountId || null,
    p_range_start: resolveRangeStart({ rangeParam, rangeStart }),
    p_range_end: normalizeBookkeepingDate(rangeEnd),
    p_limit: safePageSize,
    p_offset: (safePage - 1) * safePageSize,
  });
  if (error) throw error;
  const pageRows = data || [];
  let totalCount = pageRows.length ? Number(pageRows[0].total_count || 0) : 0;
  if (!pageRows.length && safePage > 1) {
    totalCount = await countBookkeepingTransactions({
      businessId,
      statusFilter,
      accountId,
      rangeParam,
      rangeStart,
      rangeEnd,
      db,
    });
  }
  const rows = pageRows.map((row) => normalizeBookkeepingRpcRow(row));
  const accountDisplayMap = await fetchPlaidAccountDisplayMap({
    db,
    businessId,
    plaidAccountIds: rows.map((row) => row.plaid_account_id || row.plaidAccountId),
  });
  const accountEnrichedRows = rows.map((row) => {
    const display = accountDisplayMap.get(String(row.plaid_account_id || row.plaidAccountId || ""));
    return display ? { ...row, ...display } : row;
  });
  let policy = null;
  try {
    policy = await getAutoPostPolicy(db, businessId);
  } catch {
    policy = { enabled: false, policy_columns_available: false };
  }
  const nowMs = Date.now();
  const enrichedRows = accountEnrichedRows.map((row) => {
    const qboPostingLifecycle = buildPostingLifecycleForFeed(row, policy, nowMs);
    return qboPostingLifecycle ? { ...row, qbo_posting_lifecycle: qboPostingLifecycle } : row;
  });
  return { rows: enrichedRows, totalCount };
}
