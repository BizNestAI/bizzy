const REVENUE_BASIS_LABELS = {
  invoiced: "Invoiced revenue",
  collected: "Collected cash",
  contract_value: "Contract value",
  recognized: "Recognized revenue",
};

const REVENUE_BASIS_SHORT_LABELS = {
  invoiced: "Invoiced",
  collected: "Collected",
  contract_value: "Contract",
  recognized: "Recognized",
};

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function maybeFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

export function hasCanonicalRevenueSummary(job = {}) {
  const status = String(job.revenue_source_status || job.source_status || job.sync_status || "").toLowerCase();
  if (status === "canonical" || status === "available") return true;
  if (job.revenue_summary && typeof job.revenue_summary === "object") {
    const summaryStatus = String(job.revenue_summary.sourceStatus || job.revenue_summary.source_status || "").toLowerCase();
    return summaryStatus === "canonical" || summaryStatus === "available";
  }
  return false;
}

export function normalizeRevenueBasisKey(value) {
  const key = String(value || "").trim().toLowerCase();
  if (key === "contract" || key === "contract_value") return "contract_value";
  if (key === "collected" || key === "cash" || key === "collected_cash") return "collected";
  if (key === "recognized" || key === "recognized_revenue") return "recognized";
  return "invoiced";
}

export function getJobRevenueBasisView(job = {}) {
  const key = normalizeRevenueBasisKey(
    job.selected_revenue_basis ||
      job.job_costing_revenue_basis ||
      job.revenue_basis ||
      job.basis
  );
  const amountByBasis = {
    invoiced: maybeFiniteNumber(
      job.selected_basis_amount,
      job.basis_amount,
      job.job_costing_revenue,
      job.net_invoiced_revenue,
      job.gross_invoiced_revenue
    ),
    collected: maybeFiniteNumber(
      job.selected_basis_amount,
      job.basis_amount,
      job.job_costing_revenue,
      job.collected_cash,
      job.collected_revenue
    ),
    contract_value: maybeFiniteNumber(
      job.selected_basis_amount,
      job.basis_amount,
      job.job_costing_revenue,
      job.contract_value,
      job.contract_amount,
      job.estimated_value
    ),
    recognized: maybeFiniteNumber(
      job.selected_basis_amount,
      job.basis_amount,
      job.job_costing_revenue,
      job.recognized_revenue
    ),
  };
  const canonicalAvailable = hasCanonicalRevenueSummary(job);
  return {
    key,
    label: REVENUE_BASIS_LABELS[key],
    shortLabel: REVENUE_BASIS_SHORT_LABELS[key],
    amount: canonicalAvailable ? amountByBasis[key] : null,
    sourceStatus: job.revenue_source_status || job.source_status || job.sync_status || "summary_refreshing",
    available: canonicalAvailable && amountByBasis[key] !== null,
    unavailableLabel: "Revenue unavailable",
    refreshingLabel: "Summary refreshing",
    retryLabel: "Retry",
  };
}

export function getJobSourceBadge(job = {}) {
  const source = String(job.source_type || job.creation_method || job.source_system || "").toLowerCase();
  const externalType = String(job.source_entity_type || job.external_source_type || "").toLowerCase();
  if (source.includes("qbo_project") || externalType.includes("project") || job.qbo_project_id) {
    return { label: "QBO Project", tone: "emerald" };
  }
  if (source.includes("subcustomer") || externalType.includes("subcustomer") || job.qbo_subcustomer_id) {
    return { label: "QBO sub-customer", tone: "cyan" };
  }
  if (source.includes("candidate") || externalType.includes("invoice") || externalType.includes("estimate")) {
    return { label: "Candidate", tone: "amber" };
  }
  if (source.includes("manual")) return { label: "Manual", tone: "slate" };
  if (source.includes("qbo")) return { label: "QuickBooks", tone: "emerald" };
  return { label: "Bizzi", tone: "slate" };
}

export function getJobReviewWarning(job = {}) {
  const status = String(job.revenue_source_status || job.sync_status || "").toLowerCase();
  if (status.includes("stale")) return "Revenue sync needs review";
  if (status.includes("partial")) return "Partial revenue source";
  if (status.includes("error") || status.includes("failed")) return "Sync issue";
  if (job.review_warning) return String(job.review_warning);
  if (job.unmatched_revenue_count > 0) return "Unmatched revenue evidence";
  return "";
}

export function getJobDocumentCount(job = {}) {
  return firstFiniteNumber(
    job.source_document_count,
    job.revenue_document_count,
    job.document_count,
    job.assigned_transaction_count,
    Array.isArray(job.revenue_documents) ? job.revenue_documents.length : undefined,
    Array.isArray(job.transactions) ? job.transactions.length : undefined
  );
}

export function getRevenueWaterfallRows(job = {}) {
  const basis = getJobRevenueBasisView(job);
  return [
    { key: "contract", label: "Contract/estimated value", amount: firstFiniteNumber(job.contract_value, job.contract_amount, job.estimated_value), sourceKey: "contracts" },
    { key: "gross_invoices", label: "Gross invoices", amount: firstFiniteNumber(job.gross_invoiced_revenue, job.invoiced_revenue), sourceKey: "invoices" },
    { key: "credits", label: "Credit memos", amount: firstFiniteNumber(job.credit_memo_amount, job.credit_memos), sourceKey: "credit_memos", inverse: true },
    { key: "net_invoiced", label: "Net invoiced", amount: firstFiniteNumber(job.net_invoiced_revenue), sourceKey: "invoices" },
    { key: "payments", label: "Payments applied", amount: firstFiniteNumber(job.payments_applied, job.applied_payments), sourceKey: "payments" },
    { key: "collected", label: "Collected cash", amount: firstFiniteNumber(job.collected_cash), sourceKey: "payments" },
    { key: "receivable", label: "Outstanding receivable", amount: firstFiniteNumber(job.outstanding_receivable), sourceKey: "invoices" },
    { key: "remaining", label: "Remaining to bill", amount: firstFiniteNumber(job.remaining_to_bill), sourceKey: "contracts" },
    { key: "recognized", label: "Recognized revenue", amount: firstFiniteNumber(job.recognized_revenue), sourceKey: "recognition" },
    { key: "selected", label: `Selected job-costing revenue (${basis.shortLabel})`, amount: basis.amount, sourceKey: "selected", selected: true },
  ];
}

export function getTransactionRoleMeta(txn = {}) {
  const rawType = String(
    txn.financial_role ||
      txn.transaction_role ||
      txn.source_role ||
      txn.qbo_txn_type ||
      txn.qbo_entity_type ||
      txn.source_entity_type ||
      ""
  ).toLowerCase();
  const amount = Number(txn.amount || 0);
  const sourceSystem = String(txn.source_system || txn.source || "").toLowerCase();
  const isQbo = rawType.includes("invoice") || rawType.includes("payment") || rawType.includes("salesreceipt") || rawType.includes("creditmemo") || sourceSystem.includes("qbo") || Boolean(txn.qbo_txn_id);

  if (rawType.includes("invoice")) {
    return { key: "invoice", label: "Invoice", source: "QBO", effect: "Adds to invoiced revenue once.", tone: "emerald" };
  }
  if (rawType.includes("payment")) {
    return { key: "payment", label: "Payment", source: "QBO", effect: "Adds collected cash and reduces receivables. It does not add invoiced revenue.", tone: "cyan" };
  }
  if (rawType.includes("deposit") || rawType.includes("settlement")) {
    return { key: "deposit", label: "Deposit evidence", source: isQbo ? "QBO" : "Bank", effect: "Links settlement evidence only. No additional revenue will be added.", tone: "slate" };
  }
  if (rawType.includes("salesreceipt") || rawType.includes("sales_receipt")) {
    return { key: "sales_receipt", label: "Sales receipt", source: "QBO", effect: "Adds paid-at-sale revenue according to the selected basis.", tone: "emerald" };
  }
  if (rawType.includes("creditmemo") || rawType.includes("credit_memo") || rawType.includes("credit")) {
    return { key: "credit", label: "Credit", source: "QBO", effect: "Reduces net invoiced revenue for its linked document.", tone: "rose" };
  }
  if (amount > 0) {
    return { key: "unmatched_inflow", label: "Unmatched inflow", source: isQbo ? "QBO" : "Bank", effect: "Choose whether this is separate job revenue or payment for an existing invoice.", tone: "amber" };
  }
  return { key: "cost", label: "Cost", source: isQbo ? "QBO" : "Bank", effect: "Adds to assigned job cost.", tone: "rose" };
}

export function normalizeAssignmentImpactView(impact = {}) {
  const role = String(impact.financial_role || impact.role || "non_job_transaction");
  const labels = {
    invoice: "Invoice",
    invoice_evidence: "Invoice",
    qbo_payment: "QBO payment",
    payment_evidence: "QBO payment",
    bank_deposit_evidence: "Bank/deposit evidence",
    settlement_evidence: "Bank/deposit evidence",
    sales_receipt: "Sales receipt",
    credit_memo: "Credit memo",
    unmatched_inflow: "Unmatched inflow",
    unmatched_revenue: "Unmatched inflow",
    expense: "Expense",
    expense_cost: "Expense",
    non_job_transaction: "Non-job transaction",
  };
  return {
    role,
    label: labels[role] || labels.non_job_transaction,
    amount: firstFiniteNumber(impact.amount),
    revenueDelta: firstFiniteNumber(impact.revenue_delta),
    costDelta: firstFiniteNumber(impact.cost_delta),
    collectedCashDelta: firstFiniteNumber(impact.collected_cash_delta),
    receivableDelta: firstFiniteNumber(impact.outstanding_receivable_delta),
    duplicateRevenuePrevented: Boolean(impact.duplicate_revenue_prevented),
    requiresUserChoice: Boolean(impact.requires_user_choice),
    safeToAssignWithoutConfirmation: Boolean(impact.safe_to_assign_without_confirmation),
    explanation: impact.explanation || "",
    choices: Array.isArray(impact.choices) ? impact.choices : [],
  };
}

export function canAssignWithoutImpactModal(impact = {}) {
  const view = normalizeAssignmentImpactView(impact);
  return view.safeToAssignWithoutConfirmation && !view.requiresUserChoice;
}

export function normalizeCandidateApprovalImpactView(preview = {}) {
  const duplicate = preview.duplicate_prevention || preview.duplicatePrevention || {};
  return {
    mode: preview.mode || preview.action || "approve",
    jobName: preview.job_to_create?.job_name || preview.job_to_link?.job_name || preview.job?.job_name || "Job",
    documentCount: firstFiniteNumber(preview.document_count, Array.isArray(preview.documents_to_attach) ? preview.documents_to_attach.length : undefined),
    invoicedRevenueChange: firstFiniteNumber(preview.invoiced_revenue_change),
    collectedCashChange: firstFiniteNumber(preview.collected_cash_change),
    receivableChange: firstFiniteNumber(preview.receivable_change),
    duplicatePreventionResult: duplicate.result || preview.duplicate_prevention_result || "not_reported",
    documentsToAttach: Array.isArray(preview.documents_to_attach) ? preview.documents_to_attach : [],
    raw: preview,
  };
}

export function normalizeRevenueSourceRecordView(source = {}) {
  const rawType = String(source.source_document_type || source.document_type || source.qbo_txn_type || source.match_type || source.type || "").toLowerCase();
  const type = rawType.includes("estimate") ? "estimate"
    : rawType.includes("payment") ? "payment"
      : rawType.includes("deposit") || rawType.includes("settlement") || rawType.includes("bank") ? "bank_evidence"
        : rawType.includes("sales") ? "sales_receipt"
          : rawType.includes("credit") ? "credit_memo"
            : rawType.includes("invoice") ? "invoice"
              : "source";
  const labels = {
    invoice: "Invoice detail",
    payment: "Payment detail",
    estimate: "Estimate detail",
    sales_receipt: "Sales receipt detail",
    credit_memo: "Credit memo detail",
    bank_evidence: "Bank evidence detail",
    source: "Source detail",
  };
  return {
    type,
    title: labels[type],
    displayId: source.document_number || source.external_document_id || source.external_payment_id || source.qbo_txn_id || source.bank_transaction_id || source.id || "Internal record",
    date: source.document_date || source.payment_date || source.txn_date || source.date || source.created_at || null,
    amount: firstFiniteNumber(source.total_amount, source.amount, source.applied_amount),
    status: source.status || source.sync_status || "",
    sourceSystem: source.source_system || source.source || (source.qbo_txn_id ? "quickbooks" : "internal"),
    explanation: source.explanation || source.source_snapshot?.explanation || "",
    raw: source,
  };
}

export function normalizeCandidateView(candidate = {}) {
  const confidence = firstFiniteNumber(candidate.confidence_score, candidate.confidence, 0);
  return {
    id: candidate.id,
    name: candidate.suggested_job_name || candidate.job_name || candidate.candidate_name || "Suggested job",
    customer: candidate.customer_name || candidate.display_name || candidate.source_customer_name || "Unknown customer",
    address: candidate.service_address || candidate.address || candidate.bill_addr || "",
    sourceDocument: candidate.document_number || candidate.source_document_number || candidate.source_entity_id || "Source document",
    amount: firstFiniteNumber(candidate.invoice_estimate_amount, candidate.document_amount, candidate.total_amount),
    date: candidate.document_date || candidate.txn_date || candidate.created_at,
    confidence,
    confidenceLevel: candidate.confidence_level || (confidence >= 85 ? "high" : confidence >= 60 ? "medium" : "review"),
    reasons: Array.isArray(candidate.detection_reasons) ? candidate.detection_reasons : [],
    possibleMatches: Array.isArray(candidate.possible_job_matches) ? candidate.possible_job_matches : [],
    raw: candidate,
  };
}

export function getPendingCandidateCount(candidates = []) {
  return candidates.filter((candidate) => String(candidate.candidate_status || candidate.status || "pending") === "pending").length;
}

export function getProjectsCapabilityView(capability = {}) {
  const status = String(capability.status || capability.capability_status || "unknown");
  const labels = {
    available_and_enabled: "QBO Projects available",
    available_but_projects_disabled: "Projects disabled in QuickBooks",
    scope_not_authorized: "Project scope not authorized",
    partner_entitlement_missing: "Projects entitlement missing",
    unsupported_qbo_plan: "QBO plan does not support Projects",
    graphql_unavailable: "Projects API unavailable",
    unknown: "Projects capability unknown",
    error: "Projects check failed",
  };
  return {
    status,
    available: status === "available_and_enabled",
    label: labels[status] || labels.unknown,
    detail: capability.detail || capability.error_message || capability.entitlement_error || "",
  };
}
