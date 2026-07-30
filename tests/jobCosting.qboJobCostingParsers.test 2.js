import assert from "node:assert/strict";
import { describe, test } from "node:test";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const {
  buildPaymentAllocationsFromPayment,
  normalizeQboCustomer,
  normalizeQboPaymentRecord,
  normalizeQboRevenueDocument,
  parseDocumentLinkedTxns,
  parsePaymentLineLinkedTxns,
} = await import("../src/services/jobCosting/qboJobCostingParsers.js");
const {
  getQboEntityImportKey,
  withQboRetry,
} = await import("../src/services/jobCosting/qboJobCostingSyncService.js");

const context = {
  businessId: "11111111-1111-4111-8111-111111111111",
  realmId: "12345",
  now: new Date("2026-07-24T12:00:00.000Z"),
};

describe("QuickBooks job costing parsers", () => {
  test("normalizes full customer imports and sub-customer metadata", () => {
    const customer = normalizeQboCustomer({
      Id: "42",
      SyncToken: "7",
      Active: true,
      DisplayName: "Johnson Deck Rebuild",
      FullyQualifiedName: "Maya Johnson:Johnson Deck Rebuild",
      CompanyName: "Maya Johnson",
      ParentRef: { value: "9", name: "Maya Johnson" },
      Job: true,
      BillAddr: { Line1: "1 Main", City: "Austin", PostalCode: "78701" },
      ShipAddr: { Line1: "2 Site", City: "Austin" },
      PrimaryEmailAddr: { Address: "maya@example.com" },
      PrimaryPhone: { FreeFormNumber: "555-0100" },
      Balance: 1200,
      BalanceWithJobs: 5000,
      CurrencyRef: { value: "USD", name: "United States Dollar" },
      MetaData: { LastUpdatedTime: "2026-07-23T10:00:00-05:00" },
    }, context);

    assert.equal(customer.canonicalCustomer.display_name, "Johnson Deck Rebuild");
    assert.equal(customer.qboCustomer.is_sub_customer, true);
    assert.equal(customer.qboCustomer.qbo_parent_customer_id, "9");
    assert.equal(customer.qboCustomer.balance_with_jobs, 5000);
    assert.equal(customer.externalLink.potential_job_source, true);
    assert.equal(customer.externalLink.currency, "USD");
  });

  test("normalizes inactive customer updates", () => {
    const customer = normalizeQboCustomer({ Id: "5", DisplayName: "Old Customer", Active: false }, context);
    assert.equal(customer.canonicalCustomer.status, "inactive");
    assert.equal(customer.qboCustomer.active, false);
  });

  test("normalizes invoice fields including ProjectRef, LinkedTxn, line items, addresses, balance, and status", () => {
    const invoice = normalizeQboRevenueDocument({
      Id: "100",
      SyncToken: "3",
      DocNumber: "INV-100",
      TxnDate: "2026-07-01",
      DueDate: "2026-07-31",
      CustomerRef: { value: "42", name: "Johnson Deck Rebuild" },
      ProjectRef: { value: "900", name: "Project Alpha" },
      LinkedTxn: [{ TxnId: "80", TxnType: "Estimate" }],
      TotalAmt: 7200,
      Balance: 1200,
      CurrencyRef: { value: "USD" },
      ExchangeRate: 1,
      BillAddr: { Line1: "1 Main" },
      ShipAddr: { Line1: "2 Site" },
      EmailStatus: "EmailSent",
      PrintStatus: "NeedToPrint",
      PrivateNote: "internal",
      CustomerMemo: { value: "Thanks" },
      Line: [{
        Id: "1",
        Description: "Progress billing",
        Amount: 7200,
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: {
          ItemRef: { value: "11", name: "Labor" },
          Qty: 2,
          UnitPrice: 3600,
          ServiceDate: "2026-07-01",
        },
      }],
      MetaData: { LastUpdatedTime: "2026-07-02T09:00:00-05:00" },
    }, "Invoice", { ...context, customerId: "cust-1", jobId: "job-1" });

    assert.equal(invoice.source_document_type, "invoice");
    assert.equal(invoice.external_document_id, "100");
    assert.equal(invoice.project_ref.value, "900");
    assert.equal(invoice.linked_txn[0].linked_transaction_type, "estimate");
    assert.equal(invoice.line_summaries[0].item_ref.name, "Labor");
    assert.equal(invoice.open_balance, 1200);
    assert.equal(invoice.status, "partially_paid");
    assert.equal(invoice.email_status, "EmailSent");
  });

  test("parses estimate-to-invoice links from document and line LinkedTxn", () => {
    const links = parseDocumentLinkedTxns({
      LinkedTxn: [{ TxnId: "200", TxnType: "Invoice" }],
      Line: [{ Id: "10", Amount: 50, LinkedTxn: [{ TxnId: "201", TxnType: "Invoice" }] }],
    });
    assert.deepEqual(links.map((link) => link.linked_transaction_id), ["200", "201"]);
    assert.equal(links[0].linked_transaction_type, "invoice");
  });

  test("normalizes estimates, sales receipts, credit memos, and voided status", () => {
    const estimate = normalizeQboRevenueDocument({ Id: "e1", TotalAmt: 5000, ExpirationDate: "2026-08-01", TxnStatus: "Accepted" }, "Estimate", context);
    const salesReceipt = normalizeQboRevenueDocument({ Id: "sr1", TotalAmt: 300, Balance: 0 }, "SalesReceipt", context);
    const creditMemo = normalizeQboRevenueDocument({ Id: "cm1", TotalAmt: 75, Balance: 0, LinkedTxn: [{ TxnId: "100", TxnType: "Invoice" }] }, "CreditMemo", context);
    const voidedInvoice = normalizeQboRevenueDocument({ Id: "void", PrivateNote: "Voided" }, "Invoice", context);

    assert.equal(estimate.source_document_type, "estimate");
    assert.equal(estimate.expiration_date, "2026-08-01");
    assert.equal(estimate.status, "accepted");
    assert.equal(salesReceipt.source_document_type, "sales_receipt");
    assert.equal(creditMemo.source_document_type, "credit_memo");
    assert.equal(creditMemo.linked_txn[0].linked_transaction_type, "invoice");
    assert.equal(voidedInvoice.status, "voided");
  });

  test("parses full, partial, multi-invoice, and unapplied payment allocations", () => {
    const payment = {
      Id: "pay-1",
      SyncToken: "2",
      TxnDate: "2026-07-04",
      TotalAmt: 1000,
      UnappliedAmt: 100,
      CustomerRef: { value: "42" },
      DepositToAccountRef: { value: "35", name: "Undeposited Funds" },
      Line: [
        { Id: "1", Amount: 600, LinkedTxn: [{ TxnId: "100", TxnType: "Invoice" }] },
        { Id: "2", Amount: 300, LinkedTxn: [{ TxnId: "101", TxnType: "Invoice" }] },
        { Id: "3", Amount: 100 },
      ],
    };

    const record = normalizeQboPaymentRecord(payment, { ...context, customerId: "cust-1" });
    const parsed = parsePaymentLineLinkedTxns(payment);
    const documentByExternalKey = new Map([
      ["invoice:100", { id: "doc-100" }],
      ["invoice:101", { id: "doc-101" }],
    ]);
    const { allocations, orphans } = buildPaymentAllocationsFromPayment({
      paymentRecordId: "payment-row-1",
      payment,
      documentByExternalKey,
      now: context.now,
    });

    assert.equal(record.total_amount, 1000);
    assert.equal(record.unapplied_amount, 100);
    assert.equal(parsed.length, 3);
    assert.equal(allocations.length, 2);
    assert.equal(allocations[0].applied_amount, 600);
    assert.equal(orphans[0].reason, "unapplied_payment_line");
  });

  test("payment before invoice is preserved as an orphan allocation diagnostic", () => {
    const { allocations, orphans } = buildPaymentAllocationsFromPayment({
      paymentRecordId: "payment-row-1",
      payment: {
        Id: "pay-2",
        Line: [{ Amount: 250, LinkedTxn: [{ TxnId: "missing", TxnType: "Invoice" }] }],
      },
      documentByExternalKey: new Map(),
      now: context.now,
    });

    assert.equal(allocations.length, 0);
    assert.equal(orphans[0].reason, "missing_revenue_document");
    assert.equal(orphans[0].lookup_key, "invoice:missing");
  });

  test("import keys are stable for duplicate import protection", () => {
    assert.equal(getQboEntityImportKey("Customer", { Id: "42" }), "customer:42");
    assert.equal(getQboEntityImportKey("Invoice", { Id: "100" }), "invoice:100");
    assert.equal(getQboEntityImportKey("Payment", { Id: "pay-1" }), "payment:pay-1");
  });

  test("sync retry retries rate-limited calls", async () => {
    let attempts = 0;
    const result = await withQboRetry(async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("rate limited");
        error.status = 429;
        throw error;
      }
      return "ok";
    }, { attempts: 2, baseDelayMs: 1 });

    assert.equal(result, "ok");
    assert.equal(attempts, 2);
  });
});
