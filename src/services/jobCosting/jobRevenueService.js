import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import {
  isCostTransaction,
  isRevenueTransaction,
} from "./accountClassification.js";

export const REVENUE_BASIS = Object.freeze({
  INVOICED: "invoiced",
  COLLECTED: "collected",
  CONTRACT_VALUE: "contract_value",
  RECOGNIZED: "recognized",
});

const BASIS_LABELS = Object.freeze({
  [REVENUE_BASIS.INVOICED]: "Net invoiced revenue",
  [REVENUE_BASIS.COLLECTED]: "Collected cash",
  [REVENUE_BASIS.CONTRACT_VALUE]: "Contract value",
  [REVENUE_BASIS.RECOGNIZED]: "Recognized revenue",
});

const ACTIVE_DOCUMENT_STATUSES = new Set(["active", "open", "accepted", "approved", "sent", "paid", "partially_paid", "closed"]);
const CONFIRMED_EVIDENCE_STATUSES = new Set(["confirmed", "approved", "recognized"]);
const INVOICE_TYPES = new Set(["invoice"]);
const ESTIMATE_TYPES = new Set(["estimate"]);
const CONTRACT_TYPES = new Set(["contract", "change_order"]);
const CREDIT_TYPES = new Set(["credit_memo"]);
const SALES_RECEIPT_TYPES = new Set(["sales_receipt"]);
const MISSING_SCHEMA_CODES = new Set(["42P01", "42703", "PGRST204", "PGRST205"]);

function asNum(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeText(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isMissingSchemaError(error) {
  const message = String(error?.message || error?.details || "");
  return MISSING_SCHEMA_CODES.has(error?.code) || /does not exist|schema cache|column/i.test(message);
}

function isActiveDocument(row = {}) {
  const status = normalizeText(row.status || "active");
  return ACTIVE_DOCUMENT_STATUSES.has(status) && !["void", "voided", "deleted", "inactive"].includes(status);
}

function normalizeBasis(value, fallback = REVENUE_BASIS.INVOICED) {
  const normalized = normalizeText(value);
  return Object.values(REVENUE_BASIS).includes(normalized) ? normalized : fallback;
}

function sumBy(rows = [], predicate, amountSelector = (row) => row.total_amount) {
  return rows.reduce((sum, row) => (predicate(row) ? sum + Math.abs(asNum(amountSelector(row))) : sum), 0);
}

export function classifyAssignmentFinancialRole(transaction = {}, categorization = {}) {
  const qboType = normalizeText(categorization.qbo_txn_type || transaction.qbo_txn_type);
  if (qboType === "invoice") return "invoice";
  if (qboType === "payment" || qboType === "receive_payment") return "qbo_payment";
  if (qboType === "deposit" || qboType === "bank_deposit") return "bank_deposit_evidence";
  if (qboType === "salesreceipt" || qboType === "sales_receipt") return "sales_receipt";
  if (qboType === "creditmemo" || qboType === "credit_memo") return "credit_memo";
  if (isCostTransaction(transaction, categorization)) return "expense";
  if (isRevenueTransaction(transaction, categorization)) return "unmatched_inflow";
  return "non_job_transaction";
}

export function buildAssignmentImpactPreview({
  transaction = {},
  categorization = {},
  allocationPercent = 100,
  allocatedAmount = null,
} = {}) {
  const safePercent = Number.isFinite(Number(allocationPercent)) ? Number(allocationPercent) : 100;
  const amount = allocatedAmount === null || allocatedAmount === undefined || allocatedAmount === ""
    ? Math.abs(asNum(transaction.amount)) * (safePercent / 100)
    : Math.abs(asNum(allocatedAmount));
  const financialRole = classifyAssignmentFinancialRole(transaction, categorization);
  const qboType = normalizeText(categorization.qbo_txn_type || transaction.qbo_txn_type);
  const duplicateRisk = ["invoice", "qbo_payment", "bank_deposit_evidence"].includes(financialRole);

  const impact = {
    financial_role: financialRole,
    amount,
    allocation_percent: safePercent,
    revenue_delta: 0,
    cost_delta: 0,
    collected_cash_delta: 0,
    outstanding_receivable_delta: 0,
    duplicate_revenue_prevented: duplicateRisk,
    requires_user_choice: false,
    safe_to_assign_without_confirmation: false,
    choices: [],
    explanation: "",
  };

  if (financialRole === "expense") {
    impact.cost_delta = amount;
    impact.safe_to_assign_without_confirmation = true;
    impact.explanation = "This assignment increases job cost only.";
  } else if (financialRole === "invoice") {
    impact.revenue_delta = amount;
    impact.outstanding_receivable_delta = amount;
    impact.explanation = "This links invoice evidence to the job; invoice revenue is counted once from the canonical document.";
  } else if (financialRole === "qbo_payment") {
    impact.collected_cash_delta = amount;
    impact.outstanding_receivable_delta = -amount;
    impact.explanation = "This links payment evidence to the job and increases collected cash only when applied to a revenue document.";
  } else if (financialRole === "bank_deposit_evidence") {
    impact.explanation = "This stores bank deposit settlement evidence and does not create another copy of revenue.";
  } else if (financialRole === "sales_receipt") {
    impact.revenue_delta = amount;
    impact.collected_cash_delta = amount;
    impact.explanation = "This adds paid-at-sale revenue through the canonical sales receipt.";
  } else if (financialRole === "credit_memo") {
    impact.revenue_delta = -amount;
    impact.outstanding_receivable_delta = -amount;
    impact.explanation = "This reduces net invoiced revenue through the canonical credit memo.";
  } else if (financialRole === "unmatched_inflow") {
    impact.requires_user_choice = true;
    impact.choices = impact.requires_user_choice
      ? ["match_existing_invoice_or_payment", "record_separate_job_revenue", "split_between_jobs", "not_job_revenue"]
      : [];
    impact.explanation = "This unmatched inflow needs an explicit revenue decision before it becomes job-costing revenue.";
  } else {
    impact.explanation = "This transaction is stored as non-job financial evidence.";
  }

  return impact;
}

export function calculateJobRevenueSummary({
  job = {},
  documents = [],
  paymentAllocations = [],
  evidence = [],
  assignedRevenueFallback = 0,
  businessDefaultBasis = REVENUE_BASIS.INVOICED,
} = {}) {
  const activeDocs = (documents || []).filter(isActiveDocument);
  const docIds = new Set(activeDocs.map((row) => String(row.id)).filter(Boolean));
  const relevantAllocations = (paymentAllocations || []).filter((row) => docIds.has(String(row.revenue_document_id)));

  const estimatedValue = sumBy(activeDocs, (row) => ESTIMATE_TYPES.has(normalizeText(row.source_document_type)));
  const contractDocumentValue = sumBy(activeDocs, (row) => CONTRACT_TYPES.has(normalizeText(row.source_document_type)));
  const contractValue = Math.abs(asNum(job.contract_amount)) || contractDocumentValue || estimatedValue;
  const grossInvoicedRevenue = sumBy(activeDocs, (row) => INVOICE_TYPES.has(normalizeText(row.source_document_type)));
  const creditMemoAmount = sumBy(activeDocs, (row) => CREDIT_TYPES.has(normalizeText(row.source_document_type)));
  const salesReceiptRevenue = sumBy(activeDocs, (row) => SALES_RECEIPT_TYPES.has(normalizeText(row.source_document_type)));
  const netInvoicedRevenue = Math.max(grossInvoicedRevenue - creditMemoAmount, 0);
  const appliedPaymentAllocations = relevantAllocations.reduce((sum, row) => sum + Math.abs(asNum(row.applied_amount)), 0);
  const confirmedUnmatchedCash = (evidence || []).reduce((sum, row) => {
    const matchType = normalizeText(row.match_type);
    const status = normalizeText(row.status);
    if (matchType === "unmatched_bank_inflow" && CONFIRMED_EVIDENCE_STATUSES.has(status)) {
      return sum + Math.abs(asNum(row.amount));
    }
    return sum;
  }, 0);

  const collectedCash = appliedPaymentAllocations + salesReceiptRevenue + confirmedUnmatchedCash;
  const outstandingReceivable = Math.max(netInvoicedRevenue - appliedPaymentAllocations, 0);
  const remainingToBill = Math.max(contractValue - netInvoicedRevenue, 0);
  const recognizedRevenue = netInvoicedRevenue + salesReceiptRevenue + confirmedUnmatchedCash;
  const hasCanonicalRevenue =
    activeDocs.some((row) => ["invoice", "credit_memo", "sales_receipt", "contract", "change_order"].includes(normalizeText(row.source_document_type))) ||
    relevantAllocations.length > 0 ||
    confirmedUnmatchedCash > 0;
  const selectedBasis = normalizeBasis(job.job_costing_revenue_basis, normalizeBasis(businessDefaultBasis));

  const basisAmounts = {
    [REVENUE_BASIS.INVOICED]: hasCanonicalRevenue ? netInvoicedRevenue + salesReceiptRevenue + confirmedUnmatchedCash : 0,
    [REVENUE_BASIS.COLLECTED]: hasCanonicalRevenue ? collectedCash : 0,
    [REVENUE_BASIS.CONTRACT_VALUE]: contractValue,
    [REVENUE_BASIS.RECOGNIZED]: hasCanonicalRevenue ? recognizedRevenue : 0,
  };
  const basisAmount = Math.max(asNum(basisAmounts[selectedBasis]), 0);

  return {
    estimatedValue,
    estimated_value: estimatedValue,
    contractValue,
    contract_value: contractValue,
    grossInvoicedRevenue,
    gross_invoiced_revenue: grossInvoicedRevenue,
    creditMemoAmount,
    credit_memo_amount: creditMemoAmount,
    netInvoicedRevenue,
    net_invoiced_revenue: netInvoicedRevenue,
    collectedCash,
    collected_cash: collectedCash,
    outstandingReceivable,
    outstanding_receivable: outstandingReceivable,
    remainingToBill,
    remaining_to_bill: remainingToBill,
    recognizedRevenue,
    recognized_revenue: recognizedRevenue,
    jobCostingRevenue: basisAmount,
    job_costing_revenue: basisAmount,
    selectedBasis,
    selected_basis: selectedBasis,
    basisAmount,
    basis_amount: basisAmount,
    basisLabel: BASIS_LABELS[selectedBasis],
    basis_label: BASIS_LABELS[selectedBasis],
    sourceStatus: hasCanonicalRevenue ? "canonical" : "summary_refreshing",
    source_status: hasCanonicalRevenue ? "canonical" : "summary_refreshing",
    appliedPaymentAllocations: appliedPaymentAllocations,
    applied_payment_allocations: appliedPaymentAllocations,
    confirmedUnmatchedCash: confirmedUnmatchedCash,
    confirmed_unmatched_cash: confirmedUnmatchedCash,
  };
}

async function safeSelect(supabase, table, buildQuery, fallback = []) {
  const query = buildQuery(supabase.from(table));
  const { data, error } = await query;
  if (error) {
    if (isMissingSchemaError(error)) return fallback;
    throw error;
  }
  return data || fallback;
}

export async function fetchBusinessRevenueBasis(businessId, { supabase = defaultSupabase } = {}) {
  return REVENUE_BASIS.INVOICED;
}

export async function fetchCanonicalJobRevenueSummaries({
  businessId,
  jobs = [],
  assignedRevenueByJob = {},
  businessDefaultBasis = null,
  supabase = defaultSupabase,
} = {}) {
  const jobIds = (jobs || []).map((job) => job.id).filter(Boolean);
  if (!businessId || !jobIds.length) return {};
  const defaultBasis = businessDefaultBasis || await fetchBusinessRevenueBasis(businessId, { supabase });

  const [documents, evidence] = await Promise.all([
    safeSelect(
      supabase,
      "job_revenue_documents",
      (query) => query.select("*").eq("business_id", businessId).in("job_id", jobIds),
      []
    ),
    safeSelect(
      supabase,
      "job_revenue_evidence",
      (query) => query.select("*").eq("business_id", businessId).in("job_id", jobIds),
      []
    ),
  ]);

  const documentIds = documents.map((row) => row.id).filter(Boolean);
  const allocations = documentIds.length
    ? await safeSelect(
      supabase,
      "job_payment_allocations",
      (query) => query.select("*").eq("business_id", businessId).in("revenue_document_id", documentIds),
      []
    )
    : [];

  const docsByJob = {};
  for (const doc of documents) {
    const key = String(doc.job_id);
    if (!docsByJob[key]) docsByJob[key] = [];
    docsByJob[key].push(doc);
  }
  const evidenceByJob = {};
  for (const row of evidence) {
    const key = String(row.job_id);
    if (!evidenceByJob[key]) evidenceByJob[key] = [];
    evidenceByJob[key].push(row);
  }

  return (jobs || []).reduce((acc, job) => {
    const key = String(job.id);
    acc[key] = calculateJobRevenueSummary({
      job,
      documents: docsByJob[key] || [],
      paymentAllocations: allocations,
      evidence: evidenceByJob[key] || [],
      assignedRevenueFallback: assignedRevenueByJob[key] || 0,
      businessDefaultBasis: defaultBasis,
    });
    return acc;
  }, {});
}

export async function createRevenueEvidenceForAssignment({
  businessId,
  job,
  transaction,
  categorization = {},
  assignment = {},
  financialRole = null,
  supabase = defaultSupabase,
} = {}) {
  const role = financialRole || classifyAssignmentFinancialRole(transaction, categorization);
  if (role === "expense") {
    return { financial_role: role, evidence: null, assignment_resolution: buildAssignmentImpactPreview({ transaction, categorization, allocationPercent: assignment.allocation_percent, allocatedAmount: assignment.allocated_amount }) };
  }

  const preview = buildAssignmentImpactPreview({
    transaction,
    categorization,
    allocationPercent: assignment.allocation_percent,
    allocatedAmount: assignment.allocated_amount,
  });
  const matchTypeByRole = {
    unmatched_inflow: "unmatched_bank_inflow",
    sales_receipt: "sales_receipt",
    credit_memo: "credit_memo",
    invoice: "invoice_evidence",
    qbo_payment: "payment_evidence",
    bank_deposit_evidence: "settlement_evidence",
    non_job_transaction: "non_job_transaction",
  };
  const payload = {
    business_id: businessId,
    job_id: job.id,
    bank_transaction_id: transaction.id || null,
    realm_id: categorization.realm_id || categorization.qbo_realm_id || transaction.realm_id || transaction.qbo_realm_id || null,
    qbo_env: categorization.qbo_env || transaction.qbo_env || null,
    qbo_txn_id: categorization.qbo_txn_id || transaction.qbo_txn_id || null,
    qbo_txn_type: categorization.qbo_txn_type || transaction.qbo_txn_type || null,
    match_type: matchTypeByRole[role] || "non_job_transaction",
    match_confidence: null,
    amount: Math.abs(asNum(assignment.allocated_amount ?? transaction.amount)),
    status: role === "unmatched_inflow" && preview.requires_user_choice ? "pending_user_choice" : "confirmed",
    source_snapshot: {
      transaction_id: transaction.id || null,
      assignment_id: assignment.id || null,
      assignment_source: assignment.source || null,
      financial_role: role,
      duplicate_revenue_prevented: preview.duplicate_revenue_prevented,
    },
  };

  let existingQuery = supabase
    .from("job_revenue_evidence")
    .select("id")
    .eq("business_id", businessId)
    .eq("job_id", job.id);
  if (payload.qbo_txn_id) {
    existingQuery = existingQuery.eq("qbo_txn_type", payload.qbo_txn_type).eq("qbo_txn_id", payload.qbo_txn_id);
    existingQuery = payload.realm_id ? existingQuery.eq("realm_id", payload.realm_id) : existingQuery.is("realm_id", null);
  } else {
    existingQuery = existingQuery.eq("bank_transaction_id", payload.bank_transaction_id);
  }

  const existing = await existingQuery.maybeSingle();
  if (existing.error) {
    if (isMissingSchemaError(existing.error)) return { financial_role: role, evidence: null, assignment_resolution: preview };
    throw existing.error;
  }

  const result = existing.data?.id
    ? await supabase
      .from("job_revenue_evidence")
      .update(payload)
      .eq("business_id", businessId)
      .eq("id", existing.data.id)
      .select("*")
      .maybeSingle()
    : await supabase
      .from("job_revenue_evidence")
      .insert(payload)
      .select("*")
      .maybeSingle();
  if (result.error) {
    if (isMissingSchemaError(result.error)) return { financial_role: role, evidence: null, assignment_resolution: preview };
    throw result.error;
  }
  return { financial_role: role, evidence: result.data || null, assignment_resolution: preview };
}

export async function fetchJobFinancialDetail({ businessId, jobId, supabase = defaultSupabase } = {}) {
  if (!businessId || !jobId) return null;
  const [{ data: job, error: jobErr }, documents, evidence] = await Promise.all([
    supabase.from("jobs").select("*").eq("business_id", businessId).eq("id", jobId).maybeSingle(),
    safeSelect(supabase, "job_revenue_documents", (query) => query.select("*").eq("business_id", businessId).eq("job_id", jobId).order("document_date", { ascending: false }), []),
    safeSelect(supabase, "job_revenue_evidence", (query) => query.select("*").eq("business_id", businessId).eq("job_id", jobId).order("created_at", { ascending: false }), []),
  ]);
  if (jobErr) throw jobErr;
  if (!job) return null;
  const documentIds = documents.map((row) => row.id).filter(Boolean);
  const allocations = documentIds.length
    ? await safeSelect(supabase, "job_payment_allocations", (query) => query.select("*").eq("business_id", businessId).in("revenue_document_id", documentIds), [])
    : [];
  const defaultBasis = await fetchBusinessRevenueBasis(businessId, { supabase });
  const summary = calculateJobRevenueSummary({ job, documents, paymentAllocations: allocations, evidence, businessDefaultBasis: defaultBasis });
  return { job, summary, documents, payment_allocations: allocations, evidence };
}

export function classifyLegacyAssignmentFinancialRole({ assignment = {}, transaction = {}, categorization = {}, evidence = null } = {}) {
  const qboType = normalizeText(categorization.qbo_txn_type || transaction.qbo_txn_type || assignment.qbo_txn_type);
  const amount = asNum(transaction.amount ?? assignment.allocated_amount);
  const account = normalizeText(`${categorization.final_qbo_account_name || categorization.gl_account || ""} ${categorization.qbo_account_type || categorization.account_type || ""}`);
  if (assignment.revenue_document_id || qboType === "invoice") return { role: "invoice_evidence", confidence: "high", reason: "canonical_invoice_link" };
  if (assignment.payment_record_id || qboType === "payment" || qboType === "receive_payment") return { role: "payment_evidence", confidence: "high", reason: "canonical_payment_link" };
  if (assignment.revenue_evidence_id || qboType === "deposit" || qboType === "bank_deposit") {
    const matchType = normalizeText(evidence?.match_type);
    if (!evidence || ["settlement_evidence", "deposit_evidence", "payment_evidence"].includes(matchType)) {
      return { role: "settlement_evidence", confidence: "high", reason: "canonical_deposit_or_settlement_evidence" };
    }
  }
  if (amount < 0 && (isCostTransaction(transaction, categorization) || /expense|cost|cogs|materials|subcontractor|supplies/.test(account))) {
    return { role: "expense_cost", confidence: "high", reason: "negative_expense_like_posted_transaction" };
  }
  if (amount > 0 || isRevenueTransaction(transaction, categorization)) {
    return { role: "needs_financial_role_review", confidence: "review", reason: "ambiguous_positive_inflow" };
  }
  return { role: "non_job_transaction", confidence: "medium", reason: "not_cost_or_revenue_like" };
}

export async function backfillLegacyAssignmentFinancialRoles({ businessId, db = defaultSupabase, now = new Date(), limit = 1000 } = {}) {
  if (!businessId) throw new Error("businessId is required");
  const diagnostics = { byRole: {}, reasons: {}, reviewed: 0, updated: 0, skipped: 0, needsReview: 0 };
  const runInsert = await db
    .from("job_transaction_assignment_role_backfill_runs")
    .insert({ business_id: businessId, status: "running", started_at: now.toISOString(), created_at: now.toISOString(), updated_at: now.toISOString() })
    .select("*")
    .maybeSingle();
  if (runInsert.error && !isMissingSchemaError(runInsert.error)) throw runInsert.error;
  const runId = runInsert.data?.id || null;
  try {
    const { data: assignments, error } = await db
      .from("job_transaction_assignments")
      .select("*")
      .eq("business_id", businessId)
      .limit(limit);
    if (error && !isMissingSchemaError(error)) throw error;
    const transactionIds = Array.from(new Set((assignments || []).map((row) => row.transaction_id).filter(Boolean)));
    const evidenceIds = Array.from(new Set((assignments || []).map((row) => row.revenue_evidence_id).filter(Boolean)));
    const [{ data: transactions }, { data: categorizations }, { data: evidenceRows }] = await Promise.all([
      transactionIds.length ? db.from("bank_transactions").select("*").eq("business_id", businessId).in("id", transactionIds) : { data: [] },
      transactionIds.length ? db.from("transaction_categorizations").select("*").eq("business_id", businessId).in("transaction_id", transactionIds) : { data: [] },
      evidenceIds.length ? db.from("job_revenue_evidence").select("*").eq("business_id", businessId).in("id", evidenceIds) : { data: [] },
    ]);
    const transactionById = new Map((transactions || []).map((row) => [String(row.id), row]));
    const categorizationByTxn = new Map((categorizations || []).map((row) => [String(row.transaction_id), row]));
    const evidenceById = new Map((evidenceRows || []).map((row) => [String(row.id), row]));
    for (const assignment of assignments || []) {
      diagnostics.reviewed += 1;
      if (assignment.financial_role && assignment.financial_role !== "unmatched_revenue") {
        diagnostics.skipped += 1;
        continue;
      }
      const classification = classifyLegacyAssignmentFinancialRole({
        assignment,
        transaction: transactionById.get(String(assignment.transaction_id)) || {},
        categorization: categorizationByTxn.get(String(assignment.transaction_id)) || {},
        evidence: evidenceById.get(String(assignment.revenue_evidence_id)) || null,
      });
      diagnostics.byRole[classification.role] = (diagnostics.byRole[classification.role] || 0) + 1;
      diagnostics.reasons[classification.reason] = (diagnostics.reasons[classification.reason] || 0) + 1;
      if (classification.role === "needs_financial_role_review") diagnostics.needsReview += 1;
      const update = await db
        .from("job_transaction_assignments")
        .update({
          financial_role: classification.role,
          assignment_resolution: {
            ...(assignment.assignment_resolution || {}),
            legacy_role_backfill: {
              confidence: classification.confidence,
              reason: classification.reason,
              reviewed_at: now.toISOString(),
            },
          },
          updated_at: now.toISOString(),
        })
        .eq("business_id", businessId)
        .eq("id", assignment.id);
      if (update.error && !isMissingSchemaError(update.error)) throw update.error;
      diagnostics.updated += 1;
    }
    if (runId) {
      await db.from("job_transaction_assignment_role_backfill_runs").update({
        status: "succeeded",
        reviewed_count: diagnostics.reviewed,
        updated_count: diagnostics.updated,
        needs_review_count: diagnostics.needsReview,
        skipped_count: diagnostics.skipped,
        diagnostics,
        finished_at: now.toISOString(),
        updated_at: now.toISOString(),
      }).eq("id", runId);
    }
    return { ok: true, runId, ...diagnostics };
  } catch (error) {
    if (runId) {
      await db.from("job_transaction_assignment_role_backfill_runs").update({
        status: "failed",
        error_message: error.message,
        diagnostics,
        updated_at: now.toISOString(),
      }).eq("id", runId);
    }
    throw error;
  }
}
