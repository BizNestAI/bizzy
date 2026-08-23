export function buildFinalizationGuard(sourceLedger = {}) {
  const groups = Array.isArray(sourceLedger.account_groups) ? sourceLedger.account_groups : [];
  const blockers = [];
  for (const group of groups) {
    for (const txn of group.transactions || []) {
      const syncKey = txn.qbo_sync_status?.key || "not_posted";
      const label = `${txn.payee || txn.description || txn.id} ${txn.date ? `(${txn.date})` : ""}`.trim();
      const itemKey = blockerItemKey("transaction", txn.id);
      if (!txn.effective_account_id && !txn.effective_account_name) {
        blockers.push({ type: "missing_gl_account", transaction_id: txn.id, item_key: itemKey, label, message: "Missing GL account." });
      }
      if (syncKey === "failed") {
        blockers.push({ type: "qbo_failed", transaction_id: txn.id, item_key: itemKey, label, message: txn.post_error || "QBO sync failed." });
      }
      if (syncKey === "queued") {
        blockers.push({ type: "qbo_queued", transaction_id: txn.id, item_key: itemKey, label, message: "QBO sync is still queued." });
      }
      if (syncKey === "not_posted") {
        blockers.push({ type: "qbo_not_posted", transaction_id: txn.id, item_key: itemKey, label, message: "Transaction has not been posted or updated in QBO." });
      }
    }
  }
  const uniqueItemCount = countUniqueBlockingItems(blockers);

  return {
    can_finalize: blockers.length === 0,
    blocker_count: uniqueItemCount,
    unique_blocking_item_count: uniqueItemCount,
    reason_count: blockers.length,
    blockers: blockers.slice(0, 80),
    counts: blockers.reduce((acc, blocker) => {
      acc[blocker.type] = (acc[blocker.type] || 0) + 1;
      return acc;
    }, {}),
  };
}

export function buildAccountingCloseFinalizationGuard({
  sourceLedger = {},
  operatorResponses = {},
  canonicalCoa = {},
  reconciliationEvidence = {},
} = {}) {
  const sourceGuard = buildFinalizationGuard(sourceLedger);
  const blockers = [...(sourceGuard.blockers || [])];
  const sourceTransactions = (sourceLedger.account_groups || []).flatMap((group) => group.transactions || []);
  for (const txn of sourceTransactions) {
    if (txn.books_review_tab !== "needs_review") continue;
    blockers.push({
      type: "needs_review_transactions",
      transaction_id: txn.id,
      item_key: blockerItemKey("transaction", txn.id),
      label: txn.payee || txn.description || txn.id,
      message: "Transaction still Needs Review.",
    });
  }

  for (const row of operatorResponses?.rows || []) {
    blockers.push({
      type: "operator_responses_unresolved",
      transaction_id: row.transaction_id || null,
      request_id: row.request_id || null,
      item_key: blockerItemKey("operator_response", row.request_id || row.transaction_id),
      label: row.merchant || row.description || row.request_id || "Operator Response",
      message: "Operator Response is awaiting accountant review.",
    });
  }

  for (const row of canonicalCoa?.needs_review || []) {
    blockers.push({
      type: "canonical_coa_needs_review",
      mapping_id: row.mapping_id || null,
      canonical_account_key: row.canonical_account_key || null,
      item_key: blockerItemKey("canonical_coa", row.mapping_id || row.canonical_account_key),
      label: row.bizzi_account_name || row.canonical_account_key || "Canonical account",
      message: "Selected-month accounting requires this canonical account mapping to be resolved.",
      selected_month_transaction_ids: row.selected_month_transaction_ids || [],
    });
  }

  for (const row of reconciliationExceptionBlockers(sourceLedger, reconciliationEvidence)) {
    blockers.push(row);
  }

  const counts = blockers.reduce((acc, blocker) => {
    acc[blocker.type] = (acc[blocker.type] || 0) + 1;
    return acc;
  }, {});
  const uniqueItemCount = countUniqueBlockingItems(blockers);

  return {
    can_finalize: blockers.length === 0,
    blocker_count: uniqueItemCount,
    unique_blocking_item_count: uniqueItemCount,
    reason_count: blockers.length,
    blockers: blockers.slice(0, 120),
    counts,
    source_contract: {
      source_tables: [
        "bank_transactions",
        "transaction_categorizations",
        "clarification_requests",
        "business_canonical_qbo_account_mappings",
        "reconciliation_runs",
        "reconciliation_items",
      ],
      removed_module_section_requirements: ["forecasting", "tax_liability", "job_costing", "reconciliations"],
      policy: "Monthly Review V2 accounting close guard; module review sections do not gate finalization.",
    },
  };
}

export function buildReconciliationKpis(run, items = [], exceptionItems = null) {
  const count = (value) => Number(value || 0);
  const countItemsByStatus = (statuses) => {
    const statusSet = new Set(Array.isArray(statuses) ? statuses : [statuses]);
    return items.filter((item) => statusSet.has(String(item.status || item.issue_type || "").toLowerCase())).length;
  };

  const plaidTotal = run ? count(run.total_seen) || items.length : 0;
  const fullyReconciled = run ? count(run.matched_count) : countItemsByStatus("matched");
  const needsGlCategory = run ? count(run.needs_review_count) : countItemsByStatus("needs_review");
  const duplicateInQbo = run ? count(run.duplicate_in_qbo_count) : countItemsByStatus("duplicate_in_qbo");
  const failedPosting = run ? count(run.failed_post_count) : countItemsByStatus("failed_post");
  const missingInQbo = run ? count(run.missing_in_qbo_count) : countItemsByStatus("missing_in_qbo");
  const postedToQbo = fullyReconciled + duplicateInQbo;
  const trueExceptionItems = Array.isArray(exceptionItems) ? exceptionItems : findTrueReconciliationExceptionItems(items);
  const persistedAnomalyCount = trueExceptionItems.length;
  const exceptionCount = run
    ? missingInQbo + failedPosting + duplicateInQbo + persistedAnomalyCount
    : persistedAnomalyCount;

  return {
    plaidTotal,
    categorized: Math.max(0, plaidTotal - needsGlCategory),
    needsGlCategory,
    postedToQbo,
    fullyReconciled,
    failedPosting,
    missingInQbo,
    duplicateInQbo,
    exceptionCount,
  };
}

export function findTrueReconciliationExceptionItems(items = []) {
  return (items || []).filter((item) => isTrueReconciliationExceptionItem(item));
}

export function selectedMonthTransactionStillRequiresCanonicalMapping(cat = {}) {
  const status = String(cat.status || "").toLowerCase();
  if (status === "posted" || cat.qbo_txn_id) return false;
  if (cat.final_qbo_account_id || cat.final_qbo_account_name) return false;
  const key = canonicalKeyFromCategorization(cat);
  if (!key) return false;
  if (cat.meta?.canonical_mapping_review_required === true) return true;
  return ["", "needs_review", "uncategorized"].includes(status);
}

export function canonicalKeyFromCategorization(cat = {}) {
  return cat.final_canonical_account_key ||
    cat.suggested_canonical_account_key ||
    cat.meta?.canonical_account_key ||
    cat.meta?.suggested_canonical_account_key ||
    cat.meta?.universal_hint?.canonical_account_key ||
    null;
}

function reconciliationExceptionBlockers(sourceLedger = {}, reconciliationEvidence = {}) {
  const blockers = [];
  for (const row of sourceLedger.reconciliation_trace || []) {
    if (row.qbo_sync_status?.key !== "failed" && row.match_confidence !== "low") continue;
    blockers.push({
      type: "reconciliation_exception",
      transaction_id: row.transaction_id || null,
      item_key: row.transaction_id ? blockerItemKey("transaction", row.transaction_id) : blockerItemKey("reconciliation", row.id),
      label: row.payee || row.description || row.id || "Posting trace item",
      message: "Posting trace has failed QBO/reconciliation evidence.",
    });
  }
  for (const item of reconciliationEvidence?.raw?.exceptionItems || []) {
    const transactionId = item.transaction_id || item.bank_transaction_id || item.bank_transaction_uuid || null;
    blockers.push({
      type: "reconciliation_exception",
      transaction_id: transactionId,
      reconciliation_item_id: item.id || null,
      item_key: transactionId ? blockerItemKey("transaction", transactionId) : blockerItemKey("reconciliation", item.id || `${item.status || item.issue_type || "exception"}:${item.plaid_account_id || ""}`),
      label: item.label || item.reason || item.issue_type || item.status || "Reconciliation exception",
      message: item.reason || "Reconciliation evidence shows a true exception.",
    });
  }
  return dedupeBlockersByTypeAndItem(blockers);
}

function isTrueReconciliationExceptionItem(item = {}) {
  const status = String(item.status || "").toLowerCase();
  const issueType = String(item.issue_type || "").toLowerCase();
  const reason = String(item.reason || item.reason_code || "").toLowerCase();
  const marker = `${status} ${issueType} ${reason}`;
  if (/\bneeds_review\b|\bapproved_waiting_post\b|\bnot_posted\b|\bqueued\b|\bpending\b/.test(marker)) return false;
  return /failed_post|duplicate|mismatch|amount_mismatch|account_mismatch|qbo_id_mismatch|provider_error|reconciliation_error|conflict|unmatched|missing_in_qbo|posting_gap/.test(marker);
}

function blockerItemKey(kind, id) {
  return `${kind}:${String(id || "unknown")}`;
}

function countUniqueBlockingItems(blockers = []) {
  return new Set((blockers || []).map((blocker) => blocker.item_key || `${blocker.type}:${blocker.transaction_id || blocker.mapping_id || blocker.request_id || blocker.label || "unknown"}`)).size;
}

function dedupeBlockersByTypeAndItem(blockers = []) {
  const seen = new Set();
  return blockers.filter((blocker) => {
    const key = `${blocker.type}:${blocker.item_key || blocker.transaction_id || blocker.mapping_id || blocker.request_id || blocker.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
