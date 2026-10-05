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
  assert.match(table, /disabled=\{selectedChanged \|\| manualPostBusy/);
  assert.match(modal, /preview\?\.line_gl_account\?\.name \|\| transaction\.final_qbo_account_name/);
  assert.doesNotMatch(modal, /transaction\.glAccountName \|\| transaction\.final_qbo_account_name/);
  assert.match(worker, /compileCanonicalDepositPosting/);
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
  assert.match(modal, /onClose\?\.\(\);\s*await onComplete\?\.\(\{ \.\.\.outcome, intent \}\)/);
  assert.match(page, /finally \{\s*setManualPostingRequest\(null\);\s*if \(transactionId\) setManualPostingBusy/);
  assert.match(modal, /<button type="button"/);
  assert.doesNotMatch(modal, /<button(?! type="button")/);
});
