import assert from "node:assert/strict";
import { describe, test } from "node:test";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const {
  REVENUE_BASIS,
  buildAssignmentImpactPreview,
  backfillLegacyAssignmentFinancialRoles,
  calculateJobRevenueSummary,
  classifyAssignmentFinancialRole,
  classifyLegacyAssignmentFinancialRole,
} = await import("../src/services/jobCosting/jobRevenueService.js");
const {
  isCostTransaction,
} = await import("../src/services/jobCosting/accountClassification.js");

function invoice(id, amount, overrides = {}) {
  return {
    id,
    source_document_type: "invoice",
    total_amount: amount,
    status: "open",
    ...overrides,
  };
}

function paymentAllocation(revenueDocumentId, amount, overrides = {}) {
  return {
    id: `alloc-${revenueDocumentId}-${amount}`,
    revenue_document_id: revenueDocumentId,
    applied_amount: amount,
    ...overrides,
  };
}

function createRoleBackfillDb(seed = {}) {
  const tables = {
    job_transaction_assignment_role_backfill_runs: [],
    job_transaction_assignments: [],
    bank_transactions: [],
    transaction_categorizations: [],
    job_revenue_evidence: [],
    ...seed,
  };
  const matches = (row, filters, inFilters) => filters.every(([key, value]) => row[key] === value) && inFilters.every(([key, values]) => values.includes(row[key]));
  return {
    tables,
    from(table) {
      if (!tables[table]) tables[table] = [];
      const filters = [];
      const inFilters = [];
      const chain = {
        select() { return chain; },
        eq(key, value) { filters.push([key, value]); return chain; },
        in(key, values) { inFilters.push([key, values]); return chain; },
        limit() { return chain; },
        maybeSingle() {
          return Promise.resolve({ data: tables[table].find((row) => matches(row, filters, inFilters)) || null, error: null });
        },
        then(resolve) {
          return resolve({ data: tables[table].filter((row) => matches(row, filters, inFilters)), error: null });
        },
        insert(payload) {
          const row = { id: payload.id || `${table}-${tables[table].length + 1}`, ...payload };
          tables[table].push(row);
          return { select: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) };
        },
        update(payload) {
          const query = {
            eq(key, value) { filters.push([key, value]); return query; },
            then(resolve) {
              const rows = tables[table].filter((row) => matches(row, filters, inFilters));
              rows.forEach((row) => Object.assign(row, payload));
              return resolve({ data: rows, error: null });
            },
          };
          return query;
        },
      };
      return chain;
    },
  };
}

describe("canonical job revenue service", () => {
  test("one invoice and one full payment count invoice revenue once and collected cash once", () => {
    const summary = calculateJobRevenueSummary({
      job: { id: "job-1" },
      documents: [invoice("inv-1", 7200)],
      paymentAllocations: [paymentAllocation("inv-1", 7200)],
    });

    assert.equal(summary.grossInvoicedRevenue, 7200);
    assert.equal(summary.netInvoicedRevenue, 7200);
    assert.equal(summary.collectedCash, 7200);
    assert.equal(summary.outstandingReceivable, 0);
    assert.equal(summary.jobCostingRevenue, 7200);
  });

  test("partial payments reduce receivable without reducing net invoiced revenue", () => {
    const summary = calculateJobRevenueSummary({
      job: { id: "job-1" },
      documents: [invoice("inv-1", 7200)],
      paymentAllocations: [paymentAllocation("inv-1", 3000)],
    });

    assert.equal(summary.netInvoicedRevenue, 7200);
    assert.equal(summary.collectedCash, 3000);
    assert.equal(summary.outstandingReceivable, 4200);
  });

  test("one payment applied to multiple invoices is summed by allocation", () => {
    const summary = calculateJobRevenueSummary({
      job: { id: "job-1" },
      documents: [invoice("inv-1", 4000), invoice("inv-2", 2500)],
      paymentAllocations: [
        paymentAllocation("inv-1", 3000, { payment_record_id: "pay-1" }),
        paymentAllocation("inv-2", 1000, { payment_record_id: "pay-1" }),
      ],
    });

    assert.equal(summary.grossInvoicedRevenue, 6500);
    assert.equal(summary.collectedCash, 4000);
    assert.equal(summary.outstandingReceivable, 2500);
  });

  test("multiple progress invoices accumulate into gross invoiced revenue", () => {
    const summary = calculateJobRevenueSummary({
      documents: [invoice("inv-1", 2000), invoice("inv-2", 3000), invoice("inv-3", 1500)],
    });

    assert.equal(summary.grossInvoicedRevenue, 6500);
    assert.equal(summary.remainingToBill, 0);
  });

  test("credit memo lowers net invoiced revenue and receivable", () => {
    const summary = calculateJobRevenueSummary({
      documents: [
        invoice("inv-1", 7200),
        { id: "cm-1", source_document_type: "credit_memo", total_amount: 700, status: "active" },
      ],
      paymentAllocations: [paymentAllocation("inv-1", 2000)],
    });

    assert.equal(summary.creditMemoAmount, 700);
    assert.equal(summary.netInvoicedRevenue, 6500);
    assert.equal(summary.outstandingReceivable, 4500);
  });

  test("sales receipts contribute to invoiced, collected, and recognized bases without separate payment duplication", () => {
    const summary = calculateJobRevenueSummary({
      documents: [
        { id: "sr-1", source_document_type: "sales_receipt", total_amount: 900, status: "paid" },
      ],
    });

    assert.equal(summary.netInvoicedRevenue, 0);
    assert.equal(summary.collectedCash, 900);
    assert.equal(summary.recognizedRevenue, 900);
    assert.equal(summary.jobCostingRevenue, 900);
  });

  test("grouped bank deposit evidence does not add revenue unless confirmed as unmatched revenue", () => {
    const summary = calculateJobRevenueSummary({
      documents: [invoice("inv-1", 1000)],
      paymentAllocations: [paymentAllocation("inv-1", 1000)],
      evidence: [{ match_type: "settlement_evidence", status: "confirmed", amount: 1000 }],
    });

    assert.equal(summary.netInvoicedRevenue, 1000);
    assert.equal(summary.collectedCash, 1000);
    assert.equal(summary.jobCostingRevenue, 1000);
  });

  test("processor fee net deposit should remain settlement evidence and not lower invoice revenue", () => {
    const summary = calculateJobRevenueSummary({
      documents: [invoice("inv-1", 1000)],
      paymentAllocations: [paymentAllocation("inv-1", 1000)],
      evidence: [{ match_type: "settlement_evidence", status: "confirmed", amount: 970 }],
    });

    assert.equal(summary.netInvoicedRevenue, 1000);
    assert.equal(summary.collectedCash, 1000);
  });

  test("duplicate imports should be neutral to formulas when only one active document is passed", () => {
    const summary = calculateJobRevenueSummary({
      documents: [invoice("inv-1", 1000)],
      paymentAllocations: [paymentAllocation("inv-1", 1000)],
    });

    assert.equal(summary.netInvoicedRevenue, 1000);
    assert.equal(summary.collectedCash, 1000);
  });

  test("dragged invoice, payment, bank deposit, and unmatched receipt produce distinct impacts", () => {
    assert.equal(classifyAssignmentFinancialRole({}, { qbo_txn_type: "Invoice" }), "invoice");
    assert.equal(classifyAssignmentFinancialRole({}, { qbo_txn_type: "Payment" }), "qbo_payment");
    assert.equal(classifyAssignmentFinancialRole({}, { qbo_txn_type: "Deposit" }), "bank_deposit_evidence");

    const unmatched = buildAssignmentImpactPreview({
      transaction: { direction: "INFLOW", amount: 500 },
      categorization: {},
    });
    assert.equal(unmatched.financial_role, "unmatched_inflow");
    assert.equal(unmatched.requires_user_choice, true);
  });

  test("split payment is represented by two payment allocations", () => {
    const summary = calculateJobRevenueSummary({
      documents: [invoice("inv-1", 1000), invoice("inv-2", 1000)],
      paymentAllocations: [
        paymentAllocation("inv-1", 400, { payment_record_id: "pay-1" }),
        paymentAllocation("inv-2", 600, { payment_record_id: "pay-1" }),
      ],
      businessDefaultBasis: REVENUE_BASIS.COLLECTED,
    });

    assert.equal(summary.collectedCash, 1000);
    assert.equal(summary.jobCostingRevenue, 1000);
    assert.equal(summary.selectedBasis, "collected");
  });

  test("all four revenue bases select the expected basis amount", () => {
    const docs = [invoice("inv-1", 700), { id: "contract-1", source_document_type: "contract", total_amount: 1000, status: "active" }];
    const allocations = [paymentAllocation("inv-1", 500)];

    assert.equal(calculateJobRevenueSummary({ documents: docs, paymentAllocations: allocations, businessDefaultBasis: "invoiced" }).jobCostingRevenue, 700);
    assert.equal(calculateJobRevenueSummary({ documents: docs, paymentAllocations: allocations, businessDefaultBasis: "collected" }).jobCostingRevenue, 500);
    assert.equal(calculateJobRevenueSummary({ documents: docs, paymentAllocations: allocations, businessDefaultBasis: "contract_value" }).jobCostingRevenue, 1000);
    assert.equal(calculateJobRevenueSummary({ documents: docs, paymentAllocations: allocations, businessDefaultBasis: "recognized" }).jobCostingRevenue, 700);
  });

  test("existing cost assignments remain classified as costs", () => {
    const transaction = { direction: "OUTFLOW", amount: -1842 };
    const categorization = { final_qbo_account_name: "Job Materials", account_type: "Expense" };

    assert.equal(isCostTransaction(transaction, categorization), true);
    assert.equal(classifyAssignmentFinancialRole(transaction, categorization), "expense");
  });

  test("legacy role classifier only high-confidence labels obvious records", () => {
    assert.equal(classifyLegacyAssignmentFinancialRole({
      transaction: { amount: -200 },
      categorization: { final_qbo_account_name: "Materials COGS", qbo_account_type: "Cost of Goods Sold" },
    }).role, "expense_cost");
    assert.equal(classifyLegacyAssignmentFinancialRole({ assignment: { payment_record_id: "pay-row" } }).role, "payment_evidence");
    assert.equal(classifyLegacyAssignmentFinancialRole({ assignment: { revenue_document_id: "doc-row" } }).role, "invoice_evidence");
    assert.equal(classifyLegacyAssignmentFinancialRole({ transaction: { amount: 1200, direction: "INFLOW" } }).role, "needs_financial_role_review");
  });

  test("legacy assignment role backfill marks ambiguous inflows for review", async () => {
    const db = createRoleBackfillDb({
      job_transaction_assignments: [
        { id: "a1", business_id: "business-1", transaction_id: "txn-cost", job_id: "job-1" },
        { id: "a2", business_id: "business-1", transaction_id: "txn-income", job_id: "job-1" },
        { id: "a3", business_id: "business-1", transaction_id: "txn-payment", job_id: "job-1", payment_record_id: "pay-1" },
      ],
      bank_transactions: [
        { id: "txn-cost", business_id: "business-1", amount: -500, direction: "OUTFLOW" },
        { id: "txn-income", business_id: "business-1", amount: 1200, direction: "INFLOW" },
        { id: "txn-payment", business_id: "business-1", amount: 1200, direction: "INFLOW" },
      ],
      transaction_categorizations: [
        { transaction_id: "txn-cost", business_id: "business-1", final_qbo_account_name: "Materials COGS", qbo_account_type: "Cost of Goods Sold" },
        { transaction_id: "txn-income", business_id: "business-1", final_qbo_account_name: "Sales Income", qbo_account_type: "Income" },
        { transaction_id: "txn-payment", business_id: "business-1", qbo_txn_type: "Payment" },
      ],
    });

    const result = await backfillLegacyAssignmentFinancialRoles({ businessId: "business-1", db, now: new Date("2026-07-29T12:00:00.000Z") });

    assert.equal(result.ok, true);
    assert.equal(result.byRole.expense_cost, 1);
    assert.equal(result.byRole.needs_financial_role_review, 1);
    assert.equal(result.byRole.payment_evidence, 1);
    assert.equal(result.needsReview, 1);
    assert.equal(db.tables.job_transaction_assignments.find((row) => row.id === "a2").financial_role, "needs_financial_role_review");
  });

  test("missing canonical summary does not use assigned revenue fallback", () => {
    const summary = calculateJobRevenueSummary({
      assignedRevenueFallback: 2500,
    });

    assert.equal(summary.jobCostingRevenue, 0);
    assert.equal(summary.sourceStatus, "summary_refreshing");
  });
});
