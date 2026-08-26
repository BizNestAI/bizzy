import { deriveQboPostingLifecycle } from "./qboPostingLifecycle.js";
import {
  derivePipelineStatus,
  finalizePipelineTotals,
  summarizePipelineStatuses,
} from "./reconciliationPipelineStatus.js";

export function findSourceLedgerAccount(sourceLedger = {}, accountId = "") {
  return (sourceLedger?.chart_accounts || []).find((item) => String(item.id) === String(accountId)) || null;
}

export function buildLocallyPatchedBookkeepingRow(row = {}, {
  accountId = "",
  targetAccount = {},
  categorization = {},
  status = "",
  pipelineStatusKey = "",
} = {}) {
  const accountName = targetAccount?.name || categorization?.final_qbo_account_name || row.final_qbo_account_name || row.glAccountName || "";
  const nextStatus = status || categorization?.status || row.status || "approved";
  const finalAccountId = targetAccount?.id || accountId || categorization?.final_qbo_account_id || row.final_qbo_account_id || row.glAccountId || null;
  const patched = {
    ...row,
    status: nextStatus,
    final_qbo_account_id: finalAccountId,
    final_qbo_account_name: accountName,
    final_canonical_account_key: categorization?.final_canonical_account_key || row.final_canonical_account_key || null,
    glAccountId: finalAccountId,
    glAccountName: accountName,
    effective_account_id: finalAccountId,
    effective_account_name: accountName || "Uncategorized",
    qbo_txn_id: categorization?.qbo_txn_id || row.qbo_txn_id || null,
    qbo_txn_type: categorization?.qbo_txn_type || row.qbo_txn_type || null,
    posted_at: categorization?.posted_at || row.posted_at || null,
    post_after: categorization?.post_after ?? row.post_after ?? null,
    post_error: categorization?.post_error ?? row.post_error ?? null,
    last_post_attempt_at: categorization?.last_post_attempt_at || row.last_post_attempt_at || null,
    meta: categorization?.meta || row.meta || null,
  };
  if (pipelineStatusKey) {
    const pipelineStatus = derivePipelineStatus({
      bank: { pending: patched.pending === true },
      cat: patched,
    });
    patched.pipeline_status = pipelineStatus;
    patched.pipeline_status_key = pipelineStatus.key;
    patched.pipeline_status_label = pipelineStatus.label;
  }
  return patched;
}

export function patchBookkeepingFeedsAfterApprovalState(feeds = {}, row = {}, accountId = "", result = {}, sourceLedger = {}) {
  const transactionId = row?.id;
  if (!transactionId) return feeds;
  const targetAccount = result?.target_account || findSourceLedgerAccount(sourceLedger, accountId) || {};
  const nextRow = buildLocallyPatchedBookkeepingRow(row, {
    accountId,
    targetAccount,
    categorization: result?.categorization,
    status: result?.categorization?.status || "approved",
    pipelineStatusKey: "handled_not_posted",
  });
  const needsReview = feeds.needs_review || {};
  const handled = feeds.handled || {};
  const handledRows = upsertBookkeepingRow(handled.rows, nextRow, { prepend: true });
  return {
    ...feeds,
    needs_review: {
      ...needsReview,
      rows: removeBookkeepingRow(needsReview.rows, transactionId),
      totalCount: decrementCount(needsReview.totalCount),
    },
    handled: {
      ...handled,
      rows: handled.loaded || handled.expanded ? handledRows : handled.rows || [],
      totalCount: incrementCount(handled.totalCount),
    },
  };
}

export function patchBookkeepingFeedsAfterReclassificationState(feeds = {}, row = {}, accountId = "", result = {}, sourceLedger = {}) {
  const transactionId = row?.id;
  if (!transactionId) return feeds;
  const targetAccount = result?.target_account || findSourceLedgerAccount(sourceLedger, accountId) || {};
  const nextRow = buildLocallyPatchedBookkeepingRow(row, {
    accountId,
    targetAccount,
    categorization: result?.categorization,
    status: result?.categorization?.status || row.status || "approved",
  });
  return patchBookkeepingRowInFeeds(feeds, nextRow);
}

export function removeBookkeepingRow(rows = [], transactionId = "") {
  return (Array.isArray(rows) ? rows : []).filter((row) => String(row.id) !== String(transactionId));
}

export function upsertBookkeepingRow(rows = [], nextRow = {}, { prepend = false } = {}) {
  const currentRows = Array.isArray(rows) ? rows : [];
  const transactionId = String(nextRow.id || "");
  if (!transactionId) return currentRows;
  let replaced = false;
  const patched = currentRows.map((row) => {
    if (String(row.id) !== transactionId) return row;
    replaced = true;
    return { ...row, ...nextRow };
  });
  if (replaced) return patched;
  return prepend ? [nextRow, ...patched] : [...patched, nextRow];
}

export function patchBookkeepingRowInFeeds(feeds = {}, nextRow = {}) {
  return Object.fromEntries(Object.entries(feeds || {}).map(([status, feed]) => [
    status,
    {
      ...feed,
      rows: updateExistingBookkeepingRow(feed?.rows, nextRow),
    },
  ]));
}

export function updateExistingBookkeepingRow(rows = [], nextRow = {}) {
  const transactionId = String(nextRow.id || "");
  if (!transactionId) return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).map((row) => (
    String(row.id) === transactionId ? { ...row, ...nextRow } : row
  ));
}

export function decrementCount(value) {
  if (value === null || value === undefined) return value;
  return Math.max(0, Number(value || 0) - 1);
}

export function incrementCount(value) {
  if (value === null || value === undefined) return value;
  return Number(value || 0) + 1;
}

export function patchSourceLedgerTransaction(sourceLedger = null, nextRow = {}) {
  if (!sourceLedger || !nextRow?.id) return sourceLedger;
  const patchTraceRow = (row = {}) => {
    if (String(row.transaction_id || row.id || "") !== String(nextRow.id)) return row;
    const pipelineStatus = nextRow.pipeline_status || derivePipelineStatus({
      bank: { pending: nextRow.pending === true },
      cat: nextRow,
    });
    return {
      ...row,
      bizzi_gl_account: nextRow.effective_account_name || nextRow.final_qbo_account_name || nextRow.glAccountName || row.bizzi_gl_account,
      category: nextRow.effective_account_name || nextRow.final_qbo_account_name || nextRow.glAccountName || row.category,
      qbo_txn_id: nextRow.qbo_txn_id || row.qbo_txn_id || null,
      qbo_txn_type: nextRow.qbo_txn_type || row.qbo_txn_type || null,
      qbo_lifecycle_status: deriveQboPostingLifecycle(nextRow),
      qbo_sync_status: deriveQboPostingLifecycle(nextRow),
      pipeline_status: pipelineStatus,
      pipeline_status_key: pipelineStatus.key,
      pipeline_status_label: pipelineStatus.label,
    };
  };
  const reconciliationTrace = Array.isArray(sourceLedger.reconciliation_trace)
    ? sourceLedger.reconciliation_trace.map(patchTraceRow)
    : sourceLedger.reconciliation_trace;
  return {
    ...sourceLedger,
    reconciliation_trace: reconciliationTrace,
    reconciliation_totals: Array.isArray(reconciliationTrace)
      ? finalizePipelineTotals(summarizePipelineStatuses(reconciliationTrace))
      : sourceLedger.reconciliation_totals,
  };
}

export function buildBookkeepingRowFromOperatorResponse(response = {}) {
  const accountId = response.final_qbo_account_id || response.current_qbo_account_id || response.suggested_qbo_account_id || null;
  const accountName = response.final_qbo_account_name || response.current_qbo_account_name || response.suggested_qbo_account_name || "Uncategorized";
  return {
    ...response,
    id: response.transaction_id,
    transaction_id: response.transaction_id,
    date: response.date,
    amount: response.amount,
    pending: response.pending === true,
    description: response.description || response.bank_memo || response.merchant || "Transaction",
    merchant: response.merchant || response.description || "Transaction",
    source_account: response.source_account || null,
    bank_account: response.source_account || null,
    status: response.status || "needs_review",
    final_qbo_account_id: response.final_qbo_account_id || null,
    final_qbo_account_name: response.final_qbo_account_name || null,
    suggested_qbo_account_id: response.suggested_qbo_account_id || null,
    suggested_qbo_account_name: response.suggested_qbo_account_name || null,
    glAccountId: accountId,
    glAccountName: accountName,
    effective_account_id: accountId,
    effective_account_name: accountName,
  };
}

export function patchOperatorResponseApprovalInDetail(detail = null, requestId = "") {
  if (!detail?.operator_responses) return detail;
  const rows = Array.isArray(detail.operator_responses.rows) ? detail.operator_responses.rows : [];
  const nextRows = rows.filter((row) => String(row.request_id) !== String(requestId));
  const removed = nextRows.length !== rows.length;
  return {
    ...detail,
    operator_responses: {
      ...detail.operator_responses,
      rows: nextRows,
      count: removed ? decrementCount(detail.operator_responses.count ?? rows.length) : detail.operator_responses.count,
    },
  };
}
