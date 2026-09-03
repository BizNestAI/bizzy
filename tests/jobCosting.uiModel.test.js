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

test("Job Costing hydrates live route from a short-lived per-business memory cache", async () => {
  const source = await readFile(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
  assert.equal(source.includes("const JOB_COSTING_LIVE_CACHE_TTL_MS = 5 * 60 * 1000"), true);
  assert.equal(source.includes("const jobCostingLiveCache = new Map()"), true);
  assert.equal(source.includes("readJobCostingLiveCache(businessId, readOnly)"), true);
  assert.equal(source.includes("useState(() => initialLiveCache?.transactions || [])"), true);
  assert.equal(source.includes("useState(() => initialLiveCache?.jobs || [])"), true);
  assert.equal(source.includes("useState(() => initialLiveCache?.jobCandidates || [])"), true);
  assert.equal(source.includes("useState(() => Number(initialLiveCache?.jobCandidatesTotal || 0))"), true);
});

test("Job Costing live refresh preserves cached data instead of showing empty zero state", async () => {
  const source = await readFile(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
  const start = source.indexOf("const loadJobCosting = useCallback(async () => {");
  const end = source.indexOf("const loadSuggestions = useCallback", start);
  assert.ok(start > 0);
  assert.ok(end > start);
  const loaderSource = source.slice(start, end);

  assert.equal(loaderSource.includes("setLoading(!hasVisibleJobCostingDataRef.current)"), true);
  assert.equal(loaderSource.includes("writeJobCostingLiveCache(businessId, readOnly, { transactions: nextTransactions })"), true);
  assert.equal(loaderSource.includes("writeJobCostingLiveCache(businessId, readOnly, { jobs: nextJobs })"), true);
  assert.equal(loaderSource.includes("setTransactions([]);"), false);
  assert.equal(loaderSource.includes("setJobs([]);"), false);
});

test("Live candidate-created jobs expose the Back to Suggested action from production source fields", async () => {
  const source = await readFile(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
  const start = source.indexOf("function isSuggestedCandidateJob(job = {})");
  const end = source.indexOf("function isManualBizziJob", start);
  assert.ok(start > 0);
  assert.ok(end > start);
  const predicateSource = source.slice(start, end);

  assert.equal(predicateSource.includes('creationMethod === "job_candidate"'), true);
  assert.equal(predicateSource.includes('sourceType.includes("candidate")'), true);
  assert.equal(predicateSource.includes('sourceType === "bizzi"'), false);
  assert.equal(predicateSource.includes("job.job_candidate_id || job.candidate_id || job.source_candidate_id"), true);
  assert.equal(predicateSource.includes('sourceEntityType.includes("invoice")'), true);
  assert.equal(predicateSource.includes('!sourceType.includes("manual")'), true);
  assert.equal(source.includes("const canShowRevertCandidateJob = !completed && onRevertCandidateJob && isSuggestedCandidateJob(job) && assignedTransactionCount <= 0"), true);
  assert.equal(source.includes("Back to Suggested"), true);
});

test("candidate create and revert keep the user on the current Job Costing tab", async () => {
  const source = await readFile(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
  const approveStart = source.indexOf("const approveCandidateNew = useCallback(async (candidate) => {");
  const approveEnd = source.indexOf("const linkCandidateExisting = useCallback", approveStart);
  const revertStart = source.indexOf("const revertCandidateJob = useCallback(async (job) => {");
  const revertEnd = source.indexOf("const removeAssignment = useCallback", revertStart);
  assert.ok(approveStart > 0);
  assert.ok(approveEnd > approveStart);
  assert.ok(revertStart > 0);
  assert.ok(revertEnd > revertStart);

  const approveSource = source.slice(approveStart, approveEnd);
  const revertSource = source.slice(revertStart, revertEnd);
  assert.equal(approveSource.includes('setBucketMode("live")'), false);
  assert.equal(revertSource.includes('setBucketMode("suggested")'), false);
  assert.equal(source.includes("revertingCandidateJob ? \"scale-[0.98] opacity-55\""), true);
  assert.equal(source.includes("busy ? \"scale-[0.98] opacity-55\""), true);
});

test("Job Costing first-load state shows an explicit loading animation instead of empty zero data", async () => {
  const source = await readFile(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
  assert.equal(source.includes("function JobCostingInitialLoadingState"), true);
  assert.equal(source.includes("Loading live job costing data"), true);
  assert.equal(source.includes("Fetching saved jobs, suggested jobs, and posted QuickBooks transactions."), true);
  assert.equal(source.includes("Loading posted QuickBooks transactions..."), true);
  assert.equal(source.includes("<JobCostingInitialLoadingState />"), true);
  assert.equal(source.includes('<JobCostingInitialLoadingState type="transactions" />'), true);
});

test("Add Job opens in a dashboard-centered animated modal without Trade Type", async () => {
  const source = await readFile(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
  const modalStart = source.indexOf("function JobCostingModal({");
  const modalEnd = source.indexOf("function RevenueDetailDrawer", modalStart);
  const addStart = source.indexOf("function AddJobDrawer({");
  const addEnd = source.indexOf("function ImportJobsDrawer", addStart);
  assert.ok(modalStart > 0);
  assert.ok(modalEnd > modalStart);
  assert.ok(addStart > 0);
  assert.ok(addEnd > addStart);

  const modalSource = source.slice(modalStart, modalEnd);
  const addJobSource = source.slice(addStart, addEnd);

  assert.equal(modalSource.includes("items-center justify-center"), true);
  assert.equal(modalSource.includes("md:left-[var(--nav-w,0px)]"), true);
  assert.equal(modalSource.includes("transition-opacity duration-300"), true);
  assert.equal(modalSource.includes("pb-[220px]"), true);
  assert.equal(modalSource.includes("max-h-[calc(100vh-260px)]"), true);
  assert.equal(modalSource.includes("max-h-[calc(100vh-325px)]"), true);
  assert.equal(modalSource.includes("scale-[0.96]"), true);
  assert.equal(addJobSource.includes("<JobCostingModal open={open} title=\"Add Job\""), true);
  assert.equal(addJobSource.includes("submittingRef.current"), true);
  assert.equal(addJobSource.includes('className="grid gap-3 pb-8"'), true);
  assert.equal(addJobSource.includes('disabled={!form.customer.trim() || !form.jobName.trim() || submitting}'), true);
  assert.equal(addJobSource.includes('{submitting ? "Creating..." : "Add Job"}'), true);
  assert.equal(addJobSource.includes('<div className="grid gap-3 sm:grid-cols-2">'), true);
  assert.equal(addJobSource.includes("dark-dropdown mt-1 h-10 w-full appearance-none"), true);
  assert.equal(addJobSource.includes("[color-scheme:dark]"), true);
  assert.equal(addJobSource.includes('className="bg-[#0b0e12] text-white"'), true);
  assert.equal(addJobSource.includes("tradeType"), false);
  assert.equal(addJobSource.includes("Trade type"), false);
  assert.equal(addJobSource.includes("trade_type"), false);
});

test("Manual Job buckets expose guarded delete and create handlers", async () => {
  const source = await readFile(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
  const cardStart = source.indexOf("function JobBucketCard({");
  const cardEnd = source.indexOf("function ChangeOrderOverview", cardStart);
  const pageStart = source.indexOf("function JobCostingPage({");
  const pageEnd = source.indexOf("function AssignedTransactionsModal", pageStart);
  assert.ok(cardStart > 0);
  assert.ok(cardEnd > cardStart);
  assert.ok(pageStart > 0);
  assert.ok(pageEnd > pageStart);

  const cardSource = source.slice(cardStart, cardEnd);
  const pageSource = source.slice(pageStart, pageEnd);
  assert.equal(source.includes("function isManualBizziJob"), true);
  assert.equal(source.includes("job.can_delete_manual_job === true || job.can_delete_job === true || job.is_manual_job === true"), true);
  assert.equal(source.includes('sourceType === "bizzi"'), true);
  assert.equal(cardSource.includes("canDeleteManualJob"), true);
  assert.equal(cardSource.includes("isManualBizziJob(job);"), true);
  assert.equal(cardSource.includes("isSuggestedCandidateJob(job) && assignedTransactionCount <= 0"), true);
  assert.equal(cardSource.includes('"No revenue source yet"'), true);
  assert.equal(source.includes('emptyManualJob ? "New" : "Revenue Needed"'), true);
  assert.equal(source.includes('"Revenue Needed"'), true);
  assert.equal(cardSource.includes("<Trash2"), true);
  assert.equal(cardSource.includes('Delete this manually created job.'), true);
  assert.equal(cardSource.includes('{deletingJob ? "Deleting..." : "Delete"}'), true);
  assert.equal(pageSource.includes("setTransactions(data.transactions)"), true);
  assert.equal(pageSource.includes("creatingManualJobRef.current"), true);
  assert.equal(pageSource.includes("optimistic-manual-job"), true);
  assert.equal(pageSource.includes('revenue_source_status: "manual_no_revenue_source"'), true);
  assert.equal(pageSource.includes("const deleteManualJob = useCallback"), true);
  assert.equal(pageSource.includes("getLocalJobId(job)"), true);
  assert.equal(pageSource.includes("setSelectedJob(previousSelectedJob || null)"), true);
  assert.equal(pageSource.includes('method: "DELETE"'), true);
});

test("Job Costing dashboard filters archived and deleted jobs from summary and cache payloads", async () => {
  const source = await readFile(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
  const cacheStart = source.indexOf("function writeJobCostingLiveCache");
  const normalizeStart = source.indexOf("function isArchivedUiJob");
  const loaderStart = source.indexOf("const loadJobCosting = useCallback(async () => {");
  const deleteStart = source.indexOf("const deleteManualJob = useCallback(async (job) => {");
  const deleteEnd = source.indexOf("const syncQboProjects = useCallback", deleteStart);
  assert.ok(cacheStart > 0);
  assert.ok(normalizeStart > 0);
  assert.ok(loaderStart > 0);
  assert.ok(deleteStart > 0);
  assert.ok(deleteEnd > deleteStart);

  const cacheSource = source.slice(cacheStart, source.indexOf("function SkeletonCard", cacheStart));
  const normalizeSource = source.slice(normalizeStart, source.indexOf("function getLocalJobId", normalizeStart));
  const loaderSource = source.slice(loaderStart, source.indexOf("const loadSuggestions = useCallback", loaderStart));
  const deleteSource = source.slice(deleteStart, deleteEnd);

  assert.equal(normalizeSource.includes("function isArchivedUiJob"), true);
  assert.equal(normalizeSource.includes('trim().toLowerCase() === "archived"'), true);
  assert.equal(normalizeSource.includes("function filterActiveUiJobs"), true);
  assert.equal(cacheSource.includes("filterActiveUiJobs(patch.jobs)"), true);
  assert.equal(loaderSource.includes("pendingDeletedJobIdsRef.current"), true);
  assert.equal(loaderSource.includes("confirmedDeletedJobIdsRef.current"), true);
  assert.equal(loaderSource.includes("filterActiveUiJobs("), true);
  assert.equal(deleteSource.includes("pendingDeletedJobIdsRef.current.add(jobId)"), true);
  assert.equal(deleteSource.includes("confirmedDeletedJobIdsRef.current.add(jobId)"), true);
  assert.equal(deleteSource.includes("filterActiveUiJobs(data.jobs, confirmedDeletedJobIdsRef.current)"), true);
});

test("Import Jobs opens in the dashboard-centered animated modal", async () => {
  const source = await readFile(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
  const boardStart = source.indexOf("function JobAssignmentBoard({");
  const boardEnd = source.indexOf("const [dateRangeFilter]", boardStart);
  const importStart = source.indexOf("function ImportJobsDrawer({");
  const importEnd = source.indexOf("function JobCostingPage", importStart);
  assert.ok(boardStart > 0);
  assert.ok(boardEnd > boardStart);
  assert.ok(importStart > 0);
  assert.ok(importEnd > importStart);

  const boardSource = source.slice(boardStart, boardEnd);
  const importJobsSource = source.slice(importStart, importEnd);
  assert.equal(boardSource.includes('const importJobsLabel = "Import Jobs";'), true);
  assert.equal(boardSource.includes('"Review Jobs"'), false);
  assert.equal(importJobsSource.includes("<JobCostingModal open={open} title=\"Import Jobs\""), true);
  assert.equal(importJobsSource.includes("widthClass=\"max-w-[640px]\""), true);
  assert.equal(importJobsSource.includes("<JobCostingDrawer"), false);
  assert.equal(importJobsSource.includes('key: "projects"'), true);
  assert.equal(importJobsSource.includes('key: "csv"'), true);
  assert.equal(importJobsSource.includes('key: "subcustomers"'), false);
  assert.equal(importJobsSource.includes('key: "documents"'), false);
  assert.equal(importJobsSource.includes("QBO sub-customers"), false);
  assert.equal(importJobsSource.includes("Invoice and estimate candidates"), false);
});

test("Create Job confirmation hides duplicate-prevention implementation details", async () => {
  const source = await readFile(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
  const modalStart = source.indexOf("function CandidateApprovalImpactModal({");
  const modalEnd = source.indexOf("function AddJobDrawer", modalStart);
  assert.ok(modalStart > 0);
  assert.ok(modalEnd > modalStart);

  const modalSource = source.slice(modalStart, modalEnd);
  assert.equal(modalSource.includes("Duplicate prevention:"), false);
  assert.equal(modalSource.includes("duplicatePreventionResult"), false);
});
