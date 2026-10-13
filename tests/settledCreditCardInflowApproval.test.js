import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildSpecializedInflowDecision,
  canCompleteSettledAccountingReview,
} from "../src/services/bookkeeping/specializedTypeAuthority.js";
import { resolveCanonicalPostingRail } from "../src/services/bookkeeping/canonicalPostingCompiler.js";

const authority = { confirmed_at: "2026-10-13T20:55:24.008Z", statement_confirmed_date: "2026-08-25", statement_confirmed_amount: 75.76 };

test("statement-settled credit-card inflow review requires a durable specialized type and GL", () => {
  const bankTransaction = {
    pending: false,
    pending_resolution_state: "promoted_to_settled",
    pending_resolution_payload: authority,
    accounting_review_required: true,
    accounting_review_reason: "operator_confirmed_settlement",
  };
  assert.equal(canCompleteSettledAccountingReview({ bankTransaction, decision: null }), false);
  const decision = buildSpecializedInflowDecision({
    resolution: "merchant_refund",
    accountId: "entertainment-qbo-id",
    accountName: "Entertainment",
    actor: "operator-id",
    source: "monthly_review",
    statementAuthority: authority,
  });
  assert.equal(canCompleteSettledAccountingReview({ bankTransaction, decision }), true);
  assert.equal(decision.statement_settlement_authority.statement_confirmed_amount, 75.76);
});

test("merchant refund authority compiles a settled credit-card inflow as CreditCardCredit", () => {
  const decision = buildSpecializedInflowDecision({ resolution: "merchant_refund", accountId: "24", actor: "operator-id" });
  assert.equal(resolveCanonicalPostingRail({
    bankTransaction: { amount: 75.76, direction: "INFLOW" },
    categorization: { meta: { credit_card_inflow_resolution: decision } },
    mapping: { qbo_account_type: "CreditCard" },
  }), "CreditCardCredit");
});

test("Monthly Review exposes the type choice, sends it with approval, and keeps row-local refresh", () => {
  const table = fs.readFileSync(new URL("../src/components/Accounting/BookkeepingTransactionMirrorTable.jsx", import.meta.url), "utf8");
  const consoleSource = fs.readFileSync(new URL("../src/pages/Admin/MonthlyReviewConsole.jsx", import.meta.url), "utf8");
  assert.match(table, /Merchant Refund/);
  assert.match(table, /Cash Back \/ Statement Credit/);
  assert.match(table, /Credit Card Payment \/ Transfer/);
  assert.match(table, /Keep for review/);
  assert.match(table, /creditCardInflowResolution/);
  assert.match(consoleSource, /credit_card_inflow_resolution: options\?\.creditCardInflowResolution/);
  assert.match(consoleSource, /patchBookkeepingFeedsAfterApproval/);
  assert.doesNotMatch(consoleSource.slice(consoleSource.indexOf('const runBookkeepingFeedAction'), consoleSource.indexOf('const recoverBookkeepingFeedRow')), /refreshExpandedBookkeepingFeeds/);
});

test("atomic approval clears only operator-confirmed settlement review and records both authorities", () => {
  const migration = fs.readFileSync(new URL("../supabase/migrations/20261013170000_settled_credit_card_inflow_approval.sql", import.meta.url), "utf8");
  assert.match(migration, /accounting_review_reason <> 'operator_confirmed_settlement'/);
  assert.match(migration, /pending_resolution_state <> 'promoted_to_settled'/);
  assert.match(migration, /accounting_review_required=false/);
  assert.match(migration, /credit_card_inflow_resolution/);
  assert.match(migration, /statement_settlement_authority/);
});

test("raw Plaid review code has a friendly Monthly Review translation", () => {
  const route = fs.readFileSync(new URL("../src/api/admin/monthlyReview.routes.js", import.meta.url), "utf8");
  assert.match(route, /plaid_accounting_review_required: "This transaction still requires accounting review/);
  assert.match(route, /credit_card_inflow_type_required: "Confirm whether this credit-card inflow/);
});
