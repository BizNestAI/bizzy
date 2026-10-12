/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
const read = (file) => readFileSync(join(process.cwd(), file), "utf8");

test("canonical deposit compiler uses destination bank and approved final line account", async () => {
  const { compileCanonicalDepositPosting } = await import("../src/services/bookkeeping/canonicalPostingCompiler.js");
  const compiled = compileCanonicalDepositPosting({
    bankTransaction: { date: "2026-06-09", amount: 500, direction: "INFLOW" },
    destinationAccount: { id: "bank-8626", name: "Checking 8626" },
    approvedLineAccount: { id: "12", name: "Sales of Product Income", active: true },
    requestId: "stable-request",
  });
  assert.equal(compiled.entity_type, "Deposit");
  assert.equal(compiled.approved_final_account_id, "12");
  assert.equal(compiled.payload.DepositToAccountRef.value, "bank-8626");
  assert.equal(compiled.payload.Line[0].DepositLineDetail.AccountRef.value, "12");
  assert.equal(compiled.line_account.name, "Sales of Product Income");
});

test("canonical compiler fails closed without an approved stable account", async () => {
  const { compileCanonicalDepositPosting } = await import("../src/services/bookkeeping/canonicalPostingCompiler.js");
  assert.throws(() => compileCanonicalDepositPosting({
    bankTransaction: { date: "2026-06-09", amount: 500, direction: "INFLOW" },
    destinationAccount: { id: "bank-8626" },
    approvedLineAccount: { name: "Uncategorized Income" },
  }), /Choose and save/);
});

test("credit-card refunds compile with the mapped card as source and selected GL as line", async () => {
  const { resolveCanonicalPostingRail } = await import("../src/services/bookkeeping/canonicalPostingCompiler.js");
  const { buildCreditCardCreditPayload } = await import("../src/services/bookkeeping/creditCardMerchantRefundPayload.js");
  const entityType = resolveCanonicalPostingRail({
    bankTransaction: { date: "2026-06-21", amount: 72, direction: "INFLOW" },
    categorization: { meta: { credit_card_inflow_resolution: { resolution_type: "merchant_refund", qbo_disposition: "create_new" } } },
    mapping: { qbo_account_type: "Credit Card" },
  });
  const payload = buildCreditCardCreditPayload({
    amount: 72,
    txnDate: "2026-06-21",
    sourceCreditCardAccountId: "card-6735",
    categoryAccountId: "entertainment",
  });
  assert.equal(entityType, "CreditCardCredit");
  assert.equal(payload.AccountRef.value, "card-6735");
  assert.equal(payload.Line[0].AccountBasedExpenseLineDetail.AccountRef.value, "entertainment");
  assert.equal(payload.Credit, true);
});

test("Rebill card outflow compiles to the proven successful Purchase payload shape", async () => {
  const { compileCanonicalCreditCardChargePosting } = await import("../src/services/bookkeeping/canonicalPostingCompiler.js");
  const compiled = compileCanonicalCreditCardChargePosting({
    bankTransaction: { date: "2026-06-29", amount: -72, signed_amount: -72, direction: "OUTFLOW" },
    sourceCreditCardAccount: { id: "19", name: "CREDIT CARD (8193) - 3" },
    approvedLineAccount: { id: "1150040020", name: "Entertainment", active: true },
    requestId: "bizzi_48634a3b9fedcc79aeaa0c2fdd27a27572a66da1",
    privateNote: "Rebill Gametime · Posted by Bizzi",
    lineDescription: "Rebill Gametime · Posted by Bizzi",
  });
  assert.equal(compiled.entity_type, "CreditCardCharge");
  assert.equal(compiled.amount, 72);
  assert.deepEqual(compiled.payload, {
    requestId: "bizzi_48634a3b9fedcc79aeaa0c2fdd27a27572a66da1",
    PaymentType: "CreditCard",
    AccountRef: { value: "19" },
    TxnDate: "2026-06-29",
    TotalAmt: 72,
    PrivateNote: "Rebill Gametime · Posted by Bizzi",
    Line: [{
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: 72,
      Description: "Rebill Gametime · Posted by Bizzi",
      AccountBasedExpenseLineDetail: { AccountRef: { value: "1150040020" } },
    }],
  });
});

test("MRP preview scopes cached accounts to the active realm and returns typed failures", () => {
  const compiler = read("src/services/bookkeeping/canonicalPostingCompiler.js");
  const route = read("src/api/admin/monthlyReview.routes.js");
  assert.match(compiler, /from\("quickbooks_tokens"\)/);
  assert.match(compiler, /eq\("realm_id", qboConnection\.realm_id\)/);
  assert.match(compiler, /eq\("qbo_env", qboConnection\.qbo_env \|\| qboEnvName\)/);
  assert.match(route, /action_code: actionCode/);
  assert.match(route, /preview_ready: false/);
  assert.doesNotMatch(route.slice(route.indexOf('router.get("/runs/:runId/transactions/:transactionId/post-qbo-preview"'), route.indexOf('router.put("/runs/:runId/transactions/:transactionId/credit-card-inflow-resolution"')), /Could not safely compile/);
});

test("preview uses metadata taxonomy contract and sanitizes missing-column failures", async () => {
  const { buildCanonicalPostingPreview } = await import("../src/services/bookkeeping/canonicalPostingCompiler.js");
  const tables = [];
  const db = {
    from(table) {
      tables.push(table);
      const query = {
        select() { return query; },
        eq() { return query; },
        order() { return query; },
        limit() { return query; },
        async maybeSingle() {
          if (table === "transaction_categorizations") {
            return { data: null, error: { code: "42703", message: "column transaction_categorizations.taxonomy_type does not exist" } };
          }
          return { data: null, error: null };
        },
      };
      return query;
    },
  };
  await assert.rejects(
    buildCanonicalPostingPreview({ db, businessId: "business-1", transactionId: "transaction-1" }),
    (error) => error.code === "bookkeeping_schema_contract_unavailable" &&
      error.status === 503 &&
      !error.message.includes("taxonomy_type")
  );
  assert.deepEqual(tables.sort(), ["bank_transactions", "transaction_categorizations"]);

  const compiler = read("src/services/bookkeeping/canonicalPostingCompiler.js");
  const categorizationSelect = compiler.match(/from\("transaction_categorizations"\)\s*\.select\("([^"]+)"\)/)?.[1] || "";
  assert.doesNotMatch(categorizationSelect, /taxonomy_type|cc_payment_pair_id/);
  assert.match(categorizationSelect, /meta/);
});

test("MRP preview response hides raw PostgreSQL details and supplies a request id", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const start = route.indexOf('router.get("/runs/:runId/transactions/:transactionId/post-qbo-preview"');
  const end = route.indexOf('router.put("/runs/:runId/transactions/:transactionId/credit-card-inflow-resolution"', start);
  const previewRoute = route.slice(start, end);
  assert.match(previewRoute, /crypto\.randomUUID\(\)/);
  assert.match(previewRoute, /request_id: requestId/);
  assert.match(previewRoute, /source_error: error\?\.cause\?\.message/);
  assert.doesNotMatch(previewRoute, /message:\s*error\?\.cause/);
});

test("MRP preview and post share final-account authority and block unsaved dropdown changes", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const table = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
  const modal = read("src/components/Accounting/ManualQuickBooksPostingWorkflow.jsx");
  const worker = read("src/jobs/booksPost.cron.js");
  assert.match(route, /post-qbo-preview/);
  assert.match(route, /posting_preview_account_changed/);
  assert.match(page, /posting_preview: response\?\.preview/);
  assert.match(page, /approved_final_account_id: options\.approvedFinalAccountId/);
  assert.match(page, /confirmed_execution: options\.confirmedExecution === true/);
  assert.match(page, /preview_token: options\.previewToken/);
  assert.match(table, /busy=\{selectedChanged \|\| manualPostBusy/);
  assert.match(modal, /preview\?\.line_gl_account\?\.name \|\| transaction\.final_qbo_account_name/);
  assert.doesNotMatch(modal, /transaction\.glAccountName \|\| transaction\.final_qbo_account_name/);
  assert.match(worker, /compileCanonicalDepositPosting/);
  assert.match(worker, /compileCanonicalCreditCardChargePosting/);
});

test("MRP Post now immediately processes the exact durable operation and exposes polling", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const modal = read("src/components/Accounting/ManualQuickBooksPostingWorkflow.jsx");
  assert.match(route, /requestInteractiveTransactionPosting\(\{/);
  assert.match(route, /runInteractivePostingCommandWorkerOnce\(\{ operationId: result\.operation_id \}\)/);
  assert.match(route, /getInteractivePostingCommandStatus\(\{/);
  assert.match(route, /post-qbo-operations\/\$\{encodeURIComponent\(result\.operation_id\)\}/);
  assert.match(page, /outcome\.response\?\.status_url/);
  assert.match(page, /operation\?\.outcome === "processing"/);
  assert.match(page, /patchManualPostingRow/);
  assert.doesNotMatch(page, /window\.location\.reload\(\)/);
  assert.match(modal, /onClose\?\.\(\);\s*await onComplete\?\.\(\{ \.\.\.outcome, intent \}\)/);
  assert.match(page, /finally \{\s*setManualPostingRequest\(null\);\s*if \(transactionId\) setManualPostingBusy/);
  assert.match(modal, /<button type="button"/);
  assert.doesNotMatch(modal, /<button(?! type="button")/);
});
