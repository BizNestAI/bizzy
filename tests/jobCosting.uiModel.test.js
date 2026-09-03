import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  getJobRevenueBasisView,
  getPendingCandidateCount,
  getProjectsCapabilityView,
  getRevenueWaterfallRows,
  getTransactionRoleMeta,
  canAssignWithoutImpactModal,
  hasCanonicalRevenueSummary,
  normalizeAssignmentImpactView,
  normalizeCandidateApprovalImpactView,
  normalizeCandidateView,
  normalizeRevenueSourceRecordView,
} from "../src/pages/LeadsJobs/jobCostingUiModel.js";

test("job revenue basis view uses canonical selected basis fields", () => {
  const collected = getJobRevenueBasisView({
    job_costing_revenue_basis: "collected",
    selected_basis_amount: 4200,
    net_invoiced_revenue: 9000,
    revenue_source_status: "available",
  });

  assert.equal(collected.key, "collected");
  assert.equal(collected.label, "Collected cash");
  assert.equal(collected.shortLabel, "Collected");
  assert.equal(collected.amount, 4200);
  assert.equal(collected.sourceStatus, "available");
});

test("live revenue basis view does not fall back to positive assigned transactions", () => {
  const basis = getJobRevenueBasisView({
    job_costing_revenue_basis: "invoiced",
    revenue: 4500,
    total_revenue: 4500,
    assigned_transaction_count: 2,
  });

  assert.equal(hasCanonicalRevenueSummary({ revenue_source_status: "summary_refreshing" }), false);
  assert.equal(basis.available, false);
  assert.equal(basis.amount, null);
  assert.equal(basis.unavailableLabel, "Revenue unavailable");
  assert.equal(basis.refreshingLabel, "Summary refreshing");
  assert.equal(basis.retryLabel, "Retry");
});

test("mock mode can use canonical summary contract", () => {
  const basis = getJobRevenueBasisView({
    revenue_source_status: "canonical",
    job_costing_revenue_basis: "invoiced",
    selected_basis_amount: 7200,
    net_invoiced_revenue: 7200,
  });

  assert.equal(basis.available, true);
  assert.equal(basis.amount, 7200);
});

test("revenue waterfall exposes traceable rows and selected basis", () => {
  const rows = getRevenueWaterfallRows({
    revenue_source_status: "canonical",
    job_costing_revenue_basis: "invoiced",
    contract_value: 10000,
    gross_invoiced_revenue: 7500,
    credit_memo_amount: 500,
    net_invoiced_revenue: 7000,
    payments_applied: 4500,
    collected_cash: 4500,
    outstanding_receivable: 2500,
    remaining_to_bill: 3000,
    recognized_revenue: 6000,
  });

  assert.equal(rows.find((row) => row.key === "credits").inverse, true);
  assert.equal(rows.find((row) => row.key === "selected").amount, 7000);
  assert.equal(rows.find((row) => row.key === "selected").label, "Selected job-costing revenue (Invoiced)");
});

test("transaction role metadata distinguishes documents from bank evidence", () => {
  assert.deepEqual(
    getTransactionRoleMeta({ financial_role: "qbo_invoice", amount: 1000 }).key,
    "invoice"
  );
  assert.match(
    getTransactionRoleMeta({ financial_role: "qbo_payment", amount: 1000 }).effect,
    /does not add invoiced revenue/
  );
  assert.equal(
    getTransactionRoleMeta({ financial_role: "settlement_evidence", amount: 1000 }).key,
    "deposit"
  );
  assert.equal(getTransactionRoleMeta({ amount: 500 }).key, "unmatched_inflow");
  assert.equal(getTransactionRoleMeta({ amount: -500 }).key, "cost");
});

test("assignment impact view requires backend-safe classification for direct assignment", () => {
  assert.equal(canAssignWithoutImpactModal({ financial_role: "expense", safe_to_assign_without_confirmation: true }), true);
  assert.equal(canAssignWithoutImpactModal({ financial_role: "unmatched_inflow", requires_user_choice: true }), false);

  const payment = normalizeAssignmentImpactView({
    financial_role: "qbo_payment",
    collected_cash_delta: 1000,
    outstanding_receivable_delta: -1000,
    duplicate_revenue_prevented: true,
  });

  assert.equal(payment.label, "QBO payment");
  assert.equal(payment.collectedCashDelta, 1000);
  assert.equal(payment.duplicateRevenuePrevented, true);
});

test("candidate approval impact view is backend derived", () => {
  const view = normalizeCandidateApprovalImpactView({
    job_to_create: { job_name: "Kitchen refresh" },
    documents_to_attach: [{ source_entity_id: "inv-1" }],
    invoiced_revenue_change: 8500,
    collected_cash_change: 0,
    receivable_change: 8500,
    duplicate_prevention: { result: "source_document_identity_checked" },
  });

  assert.equal(view.jobName, "Kitchen refresh");
  assert.equal(view.documentCount, 1);
  assert.equal(view.invoicedRevenueChange, 8500);
  assert.equal(view.duplicatePreventionResult, "source_document_identity_checked");
});

test("revenue drawer source routes normalize supported record types", () => {
  assert.equal(normalizeRevenueSourceRecordView({ source_document_type: "invoice", external_document_id: "inv-1" }).title, "Invoice detail");
  assert.equal(normalizeRevenueSourceRecordView({ external_payment_id: "pay-1", qbo_txn_type: "Payment" }).title, "Payment detail");
  assert.equal(normalizeRevenueSourceRecordView({ source_document_type: "estimate" }).title, "Estimate detail");
  assert.equal(normalizeRevenueSourceRecordView({ source_document_type: "sales_receipt" }).title, "Sales receipt detail");
  assert.equal(normalizeRevenueSourceRecordView({ source_document_type: "credit_memo" }).title, "Credit memo detail");
  assert.equal(normalizeRevenueSourceRecordView({ match_type: "deposit_evidence", qbo_txn_id: "dep-1" }).title, "Bank evidence detail");
});

test("candidate helpers normalize pending suggested jobs", () => {
  const candidates = [
    {
      id: "candidate-1",
      candidate_status: "pending",
      suggested_job_name: "Kitchen refresh",
      customer_name: "Avery Smith",
      invoice_estimate_amount: "8500",
      confidence_score: 88,
      detection_reasons: ["Unique service address", "Estimate linked to invoice"],
    },
    { id: "candidate-2", candidate_status: "dismissed" },
  ];

  const normalized = normalizeCandidateView(candidates[0]);

  assert.equal(getPendingCandidateCount(candidates), 1);
  assert.equal(normalized.name, "Kitchen refresh");
  assert.equal(normalized.customer, "Avery Smith");
  assert.equal(normalized.amount, 8500);
  assert.equal(normalized.confidenceLevel, "high");
  assert.equal(normalized.reasons.length, 2);
});

test("projects capability helper preserves unavailable states", () => {
  assert.equal(getProjectsCapabilityView({ status: "available_and_enabled" }).available, true);
  assert.equal(getProjectsCapabilityView({ status: "scope_not_authorized" }).available, false);
  assert.equal(
    getProjectsCapabilityView({ status: "partner_entitlement_missing" }).label,
    "Projects entitlement missing"
  );
});

test("launch Job Costing loader is not coupled to Change Order endpoints", async () => {
  const source = await readFile(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
  const start = source.indexOf("const loadJobCosting = useCallback(async () => {");
  const end = source.indexOf("const loadSuggestions = useCallback", start);
  assert.ok(start > 0);
  assert.ok(end > start);
  const loaderSource = source.slice(start, end);

  assert.equal(loaderSource.includes("/api/job-costing/change-orders"), false);
  assert.equal(loaderSource.includes("/api/job-costing/potential-change-orders"), false);
  assert.equal(loaderSource.includes("Promise.allSettled"), true);
});

test("Job Costing page load reads stored Projects capability instead of refreshing QBO", async () => {
  const source = await readFile(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
  const start = source.indexOf("const loadProjectsCapability = useCallback(async () => {");
  const end = source.indexOf("useEffect(() => {", start);
  assert.ok(start > 0);
  assert.ok(end > start);
  const loaderSource = source.slice(start, end);

  assert.equal(loaderSource.includes("/api/job-costing/qbo/projects/capability?business_id="), true);
  assert.equal(loaderSource.includes('method: "POST"'), false);
});
