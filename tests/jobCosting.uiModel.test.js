import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  getJobRevenueBasisView,
  getPendingCandidateCount,
  getPostedTransactionDisplayName,
  getProjectsCapabilityView,
  getRevenueWaterfallRows,
  getTransactionRoleMeta,
  canAssignWithoutImpactModal,
  hasCanonicalRevenueSummary,
  normalizeAssignmentImpactView,
  normalizeCandidateApprovalImpactView,
  formatCandidateAddress,
  normalizeCandidateView,
  normalizeCandidateReasons,
  normalizeCandidateMatches,
  normalizeRevenueSourceRecordView,
  cleanBankMemoDescription,
  safeDisplayText,
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

test("posted transaction display name preserves payee authority and useful fallbacks", () => {
  assert.deepEqual(
    getPostedTransactionDisplayName({
      qbo_vendor_name: "QBO Vendor LLC",
      normalized_merchant_name: "Normalized Merchant",
      merchant_name: "Plaid Merchant",
      bank_memo: "AplPay CHARGEONSITE.CHARLOTTE",
      qbo_txn_id: "purchase-1",
    }),
    {
      displayName: "QBO Vendor LLC",
      source: "qbo_payee",
      sourceLabel: "QBO payee",
      payee_is_verified: true,
    }
  );

  assert.equal(getPostedTransactionDisplayName({ normalized_merchant_name: "Normalized Merchant", merchant_name: "Plaid Merchant" }).displayName, "Normalized Merchant");
  assert.equal(getPostedTransactionDisplayName({ merchant_name: "Plaid Merchant", bank_memo: "Memo Merchant" }).displayName, "Plaid Merchant");

  const memoFallback = getPostedTransactionDisplayName({
    vendor: "Unknown payee",
    payee: "N/A",
    merchant_name: "",
    qbo_txn_id: "purchase-2",
    bank_memo: "AplPay CHARGEONSITE.CHARLOTTE",
  });
  assert.equal(memoFallback.displayName, "CHARGEONSITE.CHARLOTTE");
  assert.equal(memoFallback.source, "bank_memo");
  assert.equal(memoFallback.payee_is_verified, false);
  assert.equal(cleanBankMemoDescription("Apple Pay  CHARGEONSITE.CHARLOTTE"), "CHARGEONSITE.CHARLOTTE");
  assert.equal(getPostedTransactionDisplayName({ bank_memo: "   " }).displayName, "Unknown payee");
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

test("candidate address formatter supports production jsonb address objects", () => {
  assert.equal(
    formatCandidateAddress({
      line1: "123 Main St",
      line2: "Suite 4",
      line3: "",
      city: "Charlotte",
      country_subdivision_code: "NC",
      postal_code: "28202",
      country: "US",
      lat: 35.2271,
      long: -80.8431,
    }),
    "123 Main St, Suite 4, Charlotte, NC 28202"
  );

  assert.equal(formatCandidateAddress("42 Walnut Street, Anytown"), "42 Walnut Street, Anytown");
  assert.equal(formatCandidateAddress(null), "");
  assert.equal(formatCandidateAddress("   "), "");
  assert.equal(formatCandidateAddress({ lat: 35.2, long: -80.8 }), "");
  assert.equal(
    formatCandidateAddress({
      line1: "500 Trade St",
      line2: { unexpected: "ignored" },
      line3: "Floor 2",
      city: "Charlotte",
      country_subdivision_code: "NC",
      postal_code: "28202",
      country: "United States",
      metadata: { raw: "not rendered" },
    }),
    "500 Trade St, Floor 2, Charlotte, NC 28202"
  );
});

test("candidate view never exposes raw objects as directly rendered fields", () => {
  const normalized = normalizeCandidateView({
    id: "candidate-jsonb",
    candidate_status: "pending",
    suggested_job_name: { label: "Bad structured title" },
    job_name: "Fallback job",
    customer_name: { display: "Structured customer" },
    source_customer_name: "Fallback customer",
    service_address: {
      line1: "123 Main St",
      city: "Charlotte",
      country_subdivision_code: "NC",
      postal_code: "28202",
      country: "US",
      lat: 35.2271,
      long: -80.8431,
    },
    document_number: { value: "INV-1" },
    source_entity_id: "invoice-1",
    invoice_estimate_amount: "8500",
    confidence_score: 88,
    detection_reasons: [
      "Unique service address",
      { label: "Invoice has project-like line items" },
      { unknown_nested: { value: "not renderable" } },
      "Unique service address",
    ],
    possible_job_matches: [
      { job_id: "job-1", job_name: { value: "not renderable" }, name: "Existing job", confidence: "92" },
      { metadata: { invalid: true } },
    ],
  });

  assert.equal(normalized.name, "Fallback job");
  assert.equal(normalized.customer, "Fallback customer");
  assert.equal(normalized.address, "123 Main St, Charlotte, NC 28202");
  assert.equal(normalized.sourceDocument, "invoice-1");
  assert.equal(normalized.amount, 8500);
  assert.deepEqual(normalized.reasons, ["Unique service address", "Invoice has project-like line items"]);
  assert.equal(normalized.possibleMatches.length, 1);
  assert.equal(normalized.possibleMatches[0].job_name, "Existing job");
  assert.equal(normalized.possibleMatches[0].confidence, 92);

  for (const [key, value] of Object.entries(normalized)) {
    if (key === "raw" || key === "possibleMatches" || key === "reasons") continue;
    assert.equal(value === null || typeof value !== "object", true, `${key} should not be a directly rendered object`);
  }
  assert.equal(normalized.reasons.every((reason) => typeof reason === "string"), true);
  assert.equal(normalized.possibleMatches.every((match) => typeof match.job_name === "string" && typeof match.jobName === "string"), true);
});

test("candidate reason and match normalizers omit malformed structured values", () => {
  assert.deepEqual(
    normalizeCandidateReasons([
      "QBO sub-customer match",
      { message: "Service address matches scheduled work" },
      { reason: "Line items reference remodel labor" },
      { unsupported: { nested: true } },
      "",
      null,
    ]),
    ["QBO sub-customer match", "Service address matches scheduled work", "Line items reference remodel labor"]
  );

  assert.deepEqual(normalizeCandidateReasons(null), []);
  assert.deepEqual(normalizeCandidateReasons("Invoice evidence"), ["Invoice evidence"]);

  const matches = normalizeCandidateMatches([
    { job_id: "job-1", job_name: "Kitchen", confidence: "82" },
    { id: "job-2", jobName: { structured: true }, name: "Bathroom" },
    { metadata: { unusable: true } },
    null,
  ]);

  assert.equal(matches.length, 2);
  assert.equal(matches[0].job_name, "Kitchen");
  assert.equal(matches[1].job_name, "Bathroom");
});

test("candidate normalization handles all production-shaped suggested job fixtures safely", () => {
  const candidates = Array.from({ length: 102 }, (_, index) => ({
    id: `candidate-${index + 1}`,
    candidate_status: "pending",
    source_entity_type: "invoice",
    suggested_job_name: `Invoice job ${index + 1}`,
    customer_name: `Customer ${index + 1}`,
    service_address: {
      line1: `${index + 1} Main St`,
      line2: index % 3 === 0 ? "Suite 100" : "",
      line3: "",
      city: "Charlotte",
      country_subdivision_code: "NC",
      postal_code: "28202",
      country: "US",
      lat: 35.2,
      long: -80.8,
    },
    document_number: `INV-${index + 1}`,
    document_date: "2026-08-31",
    invoice_estimate_amount: 1000 + index,
    confidence_score: 80,
    detection_reasons: ["Invoice-derived candidate"],
    possible_job_matches: [],
  }));

  const normalized = candidates.map(normalizeCandidateView);
  assert.equal(normalized.length, 102);
  assert.equal(normalized.every((candidate) => typeof candidate.address === "string"), true);
  assert.equal(normalized.every((candidate) => candidate.reasons.every((reason) => typeof reason === "string")), true);
  assert.equal(normalized.some((candidate) => candidate.address.includes("[object Object]")), false);
});

test("safe display text rejects structured values and preserves meaningful scalars", () => {
  assert.equal(safeDisplayText("  Job name  "), "Job name");
  assert.equal(safeDisplayText(0), "0");
  assert.equal(safeDisplayText(null, "Fallback"), "Fallback");
  assert.equal(safeDisplayText(["Job"], "Fallback"), "Fallback");
  assert.equal(safeDisplayText({ label: "Job" }, "Fallback"), "Fallback");
  assert.equal(safeDisplayText(Symbol("job"), "Fallback"), "Fallback");
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

test("posted transactions table supports requested sort and filter controls", async () => {
  const source = await readFile(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
  const start = source.indexOf("function JobAssignmentBoard({");
  const end = source.indexOf("function ImportJobsDrawer", start);
  assert.ok(start > 0);
  assert.ok(end > start);
  const boardSource = source.slice(start, end);

  assert.equal(boardSource.includes("sourceFilter"), false);
  assert.equal(boardSource.includes("All sources"), false);
  assert.equal(boardSource.includes('setTransactionSort("date_desc")'), true);
  assert.equal(boardSource.includes('setTransactionSort("vendor_asc")'), true);
  assert.equal(boardSource.includes("getTransactionVendorName(a).localeCompare"), true);
  assert.equal(boardSource.includes("Vendor / Description"), true);
  assert.equal(source.includes("moneyCents.format(amount)"), true);
});

test("Suggested Jobs cards are wrapped in a card-level render boundary", async () => {
  const source = await readFile(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
  assert.equal(source.includes("class SuggestedJobCardBoundary extends React.Component"), true);
  assert.equal(source.includes("<SuggestedJobCardBoundary key={candidate.id} candidateId={candidate.id}>"), true);
  assert.equal(source.includes("Unable to display this suggested job."), true);
});
