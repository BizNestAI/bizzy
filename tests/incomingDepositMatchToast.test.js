import test from "node:test";
import assert from "node:assert/strict";
import { confirmedMatchToastDescription } from "../src/services/bookkeeping/incomingDepositMatchOutcome.js";

test("received invoice payments are described as income linked to invoices", () => {
  const transaction = { amount: 675, direction: "inflow", name: "DEPOSIT INTUIT 25960703 OPTIMIST BOOKKEEPING ACH CREDIT" };
  const patch = { incoming_deposit_candidates: [{ qbo_entity_type: "Deposit", invoice_refs: [{ document_number: "1109" }, { document_number: "1110" }] }] };
  assert.equal(confirmedMatchToastDescription(transaction, patch, "$675.00"), "$675.00 income linked to existing QuickBooks invoices");
});

test("inflows without invoice evidence use an accurate generic QuickBooks match description", () => {
  assert.equal(confirmedMatchToastDescription({ signed_amount: 100 }, {}, "$100.00"), "$100.00 income linked to an existing QuickBooks transaction");
});

test("only processing-fee outflows use the existing expense wording", () => {
  const transaction = { amount: -18.90, direction: "OUTFLOW", name: "TRAN FEE INTUIT 26299703 OPTIMIST BOOKKEEPING" };
  assert.equal(confirmedMatchToastDescription(transaction, {}, "$18.90"), "$18.90 fee linked to an existing QuickBooks expense");
  assert.equal(confirmedMatchToastDescription({ amount: -20, name: "Other payment" }, {}, "$20.00"), "$20.00 payment linked to an existing QuickBooks transaction");
});

test("an incoming amount is never described as an expense even with stale fee metadata", () => {
  assert.equal(confirmedMatchToastDescription({ amount: 675, direction: "INFLOW", processor_fee: { matchState: "confirmed" } }, {}, "$675.00"),
    "$675.00 income linked to an existing QuickBooks transaction");
});

test("confirmed response evidence takes priority over earlier invoice candidates", () => {
  const transaction = { amount: 100, incoming_deposit_candidates: [{ invoice_refs: [{ id: "old" }] }] };
  assert.equal(confirmedMatchToastDescription(transaction, { incoming_deposit_candidates: [{ qbo_entity_type: "SalesReceipt" }] }, "$100.00"),
    "$100.00 income linked to an existing QuickBooks transaction");
});
