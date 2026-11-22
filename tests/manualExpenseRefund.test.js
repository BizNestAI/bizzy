/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { decideBookkeepingCategorization } from "../src/services/bookkeeping/bookkeepingCategorizationDecisionService.js";
import { compileCanonicalDepositPosting, resolveCanonicalPostingRail } from "../src/services/bookkeeping/canonicalPostingCompiler.js";
import { buildCreditCardCreditPayload } from "../src/services/bookkeeping/creditCardMerchantRefundPayload.js";
import { getVendorRuleForTransaction } from "../src/services/bookkeeping/vendorRuleMatcher.js";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
const { approveBookkeepingTransactions } = await import("../src/services/bookkeeping/bookkeepingApprovalService.js");
const { resolveAuthorizedBusiness } = await import("../src/api/_shared/tenantAuth.js");
const { hashAdminViewToken } = await import("../src/services/adminViewSessionService.js");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const transaction = { id: "refund", business_id: A, date: "2026-10-27", name: "745 LUCKY STRIKE MIAMIAMI", amount: 4.99,
  direction: "INFLOW", pending: false, is_archived: false, plaid_account_id: "card" };
const account = { id: "expense", name: "Entertainment", type: "Expense", active: true };

function fixture({ type = "CreditCard", bank = {}, category = {}, accounts = [account] } = {}) {
  const state = {
    business_profiles: [{ id: A, user_id: "owner", auto_post_to_quickbooks: false, bookkeeping_start_date: "2026-01-01" }],
    user_business_link: [],
    bank_transactions: [{ ...transaction, ...bank }],
    transaction_categorizations: [{ business_id: A, transaction_id: "refund", status: "needs_review", meta: {}, ...category }],
    plaid_qbo_account_mappings: [{ business_id: A, plaid_account_id: "card", qbo_account_type: type }],
    bookkeeping_approval_events: [], vendor_rules: [],
  };
  const calls = [];
  const db = {
    state, calls,
    from(table) {
      assert.ok(table in state, `Unexpected database access: ${table}`);
      const filters = [];
      let patch = null;
      const result = () => state[table].filter(row => filters.every(fn => fn(row)));
      const execute = () => {
        const rows = result();
        if (patch) rows.forEach(row => Object.assign(row, structuredClone(patch)));
        return structuredClone(rows);
      };
      const query = {
        select() { return query; },
        update(value) { patch = value; return query; },
        eq(key, value) { filters.push(row => row[key] === value); return query; },
        in(key, values) { filters.push(row => values.includes(row[key])); return query; },
        not(key, _op, value) { filters.push(row => row[key] !== value); return query; },
        limit() { return query; }, order() { return query; },
        maybeSingle: async () => ({ data: execute()[0] || null, error: null }),
        then(resolve, reject) { return Promise.resolve({ data: execute(), error: null }).then(resolve, reject); },
      };
      return query;
    },
    async rpc(name, args) {
      calls.push(name);
      if (name === "approve_bookkeeping_with_admission") {
        const rows = structuredClone(args.p_approvals);
        for (const row of rows) {
          Object.assign(state.transaction_categorizations.find(cat => cat.transaction_id === row.transaction_id), row);
          state.bookkeeping_approval_events.push({ business_id: A, transaction_id: row.transaction_id, idempotency_key: row.approval_idempotency_key });
        }
        return { data: rows, error: null };
      }
      assert.ok(["admit_handled_auto_post", "refresh_operator_request_summary"].includes(name), name);
      return { data: { scheduled: 0, state: "blocked" }, error: null };
    },
  };
  const options = {
    db, businessId: A, actorId: "owner", actorType: "user", requireNeedsReview: true,
    items: [{ txnId: "refund", resolution: "categorize_new", newAccountId: account.id, newAccountName: account.name,
      expense_refund_confirmed: true }],
    validateSelectedAccountsFn: async () => new Map(accounts.map(a => [a.id, a])),
    evaluateIncomingDepositPostingGuard: async () => ({ allowed: true }),
  };
  return { db, options };
}

for (const accountType of ["Expense", "Cost of Goods Sold"]) {
  for (const sourceType of ["CreditCard", "Bank"]) {
    test(`manual ${sourceType} refund to ${accountType} succeeds with audit, normal lifecycle and no learning`, async () => {
      const { db, options } = fixture({ type: sourceType, accounts: [{ ...account, type: accountType }] });
      const result = await approveBookkeepingTransactions(options);
      assert.equal(result.rows[0].status, "approved");
      const meta = result.rows[0].meta;
      const audit = meta.expense_refund_treatment;
      assert.equal(audit.actor_id, "owner");
      assert.equal(audit.business_id, A);
      assert.equal(audit.transaction_id, "refund");
      assert.equal(audit.selected_qbo_account_id, account.id);
      assert.equal(audit.original_amount, 4.99);
      assert.equal(audit.original_direction, "INFLOW");
      assert.equal(audit.refund_attested, true);
      assert.ok(Date.parse(audit.confirmed_at));
      assert.equal(audit.idempotency_key, db.state.bookkeeping_approval_events[0].idempotency_key);
      assert.equal(meta.final_categorization.source, "customer_manual");
      assert.equal(meta.auto_post_admission.version, 2);
      assert.ok(db.calls.includes("admit_handled_auto_post"));
      assert.equal(result.rows[0].post_after, null); // auto-post remains off
      assert.equal(result.vendor_rule_results[0].reason, "one_time_decision");
      assert.deepEqual(db.state.bank_transactions[0], transaction); // never rewrites amount/direction
      if (sourceType === "CreditCard") {
        assert.equal(meta.credit_card_inflow_resolution.resolution_type, "merchant_refund");
        assert.equal(meta.credit_card_inflow_resolution.standalone_refund_acknowledged, true);
        assert.deepEqual(meta.credit_card_inflow_resolution.expense_refund_treatment, audit);
      }
      assert.equal(resolveCanonicalPostingRail({ bankTransaction: transaction, categorization: result.rows[0], mapping: { qbo_account_type: sourceType } }),
        sourceType === "CreditCard" ? "CreditCardCredit" : "Deposit");
      const repeated = await approveBookkeepingTransactions(options);
      assert.equal(repeated.idempotent, true);
      assert.equal(db.state.bookkeeping_approval_events.length, 1);
      assert.equal(db.calls.filter(name => name === "approve_bookkeeping_with_admission").length, 1);
    });
  }
}

test("verified Admin View actor uses the same refund service and normal audited lifecycle", async () => {
  const { options } = fixture();
  const result = await approveBookkeepingTransactions({ ...options, actorId: "staff", actorType: "admin", source: "admin_customer_app" });
  assert.equal(result.rows[0].meta.final_categorization.source, "admin_manual");
  assert.equal(result.rows[0].meta.expense_refund_treatment.actor_id, "staff");
});

test("unconfirmed positive-to-expense, pending, inactive, unsupported sources, and automated attestation fail closed", async () => {
  const cases = [
    [fixture(), { items: [{ txnId: "refund", newAccountId: "expense" }] }, /expense_refund_confirmation_required/],
    [fixture({ bank: { pending: true } }), {}, /pending_transaction_not_postable/],
    [fixture({ bank: { amount: -4.99, direction: "OUTFLOW" } }), {}, /expense_refund_invalid_transaction_or_account/],
    [fixture({ accounts: [{ ...account, active: false }] }), {}, /expense_refund_active_expense_account_required/],
    [fixture({ accounts: [{ ...account, type: "Income" }] }), {}, /expense_refund_invalid_transaction_or_account/],
    [fixture({ type: "OtherCurrentAsset" }), {}, /expense_refund_source_not_supported/],
    [fixture(), { actorType: "system" }, /expense_refund_manual_actor_required/],
  ];
  for (const [f, overrides, error] of cases) {
    await assert.rejects(() => approveBookkeepingTransactions({ ...f.options, ...overrides }), error);
    assert.equal(f.db.state.bookkeeping_approval_events.length, 0);
  }
});

test("confirmation cannot bypass matching, exclusion, or confirmed card-payment protection", async () => {
  for (const reason of ["match_check_unavailable", "incoming_deposit_match_required"]) {
    const { db, options } = fixture();
    await assert.rejects(() => approveBookkeepingTransactions({ ...options,
      evaluateIncomingDepositPostingGuard: async () => ({ allowed: false, reason }) }), new RegExp(reason));
    assert.equal(db.state.bookkeeping_approval_events.length, 0);
    assert.equal(db.state.transaction_categorizations[0].status, "needs_review");
  }
  for (const [category, code] of [
    [{ status: "excluded" }, /transaction_excluded/],
    [{ meta: { matched_existing_qbo: true } }, /confirmed_match_requires_match_undo/],
    [{ meta: { taxonomy_type: "cc_payment", cc_payment_pair_id: "pair", cc_payment_pair_status: "confirmed" } }, /credit_card_payment_requires_match/],
  ]) {
    const { options } = fixture({ category });
    await assert.rejects(() => approveBookkeepingTransactions(options), code);
  }
});

test("automatic positive-to-expense stays blocked even with a refund-like client evidence flag", () => {
  const decision = decideBookkeepingCategorization({ transaction, account,
    evidence: { source: "approved_business_rule", confidenceTier: "very_high", safeToAutoHandle: true, expense_refund_confirmed: true } });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "qbo_account_type_incompatible");
});

test("ordinary bank income approval is unchanged and is not labeled a refund", async () => {
  const { options } = fixture({ type: "Bank", accounts: [{ ...account, type: "Income" }] });
  options.items[0] = { ...options.items[0], expense_refund_confirmed: false, only_this_transaction: true };
  const result = await approveBookkeepingTransactions(options);
  assert.equal(result.rows[0].status, "approved");
  assert.equal(result.rows[0].meta.expense_refund_treatment, undefined);
});

test("Undo requires fresh attestation and creates a new idempotent refund decision", async () => {
  const { db, options } = fixture();
  const first = await approveBookkeepingTransactions(options);
  const firstKey = first.rows[0].meta.expense_refund_treatment.idempotency_key;
  // State written by the existing Undo endpoint; amount and receipt evidence are untouched.
  const row = db.state.transaction_categorizations[0];
  Object.assign(row, { status: "needs_review", final_qbo_account_id: null, post_after: null });
  row.meta.posting_cancelled_at = "2026-11-21T22:00:00.000Z";
  delete row.meta.user_selected_resolution;
  await assert.rejects(() => approveBookkeepingTransactions({ ...options,
    items: [{ ...options.items[0], expense_refund_confirmed: false }] }), /expense_refund_confirmation_required/);
  const second = await approveBookkeepingTransactions(options);
  assert.notEqual(second.rows[0].meta.expense_refund_treatment.idempotency_key, firstKey);
  assert.equal(second.rows[0].meta.prior_expense_refund_treatment.idempotency_key, firstKey);
  assert.equal(second.rows[0].meta.posting_cancelled_at, undefined);
  assert.equal((await approveBookkeepingTransactions(options)).idempotent, true);
  assert.equal(db.state.bookkeeping_approval_events.length, 2);
});

test("a suggested expense cannot authorize a positive bank transaction without confirmation", async () => {
  const { options } = fixture({ type: "Bank", category: { suggested_qbo_account_id: "expense" } });
  await assert.rejects(() => approveBookkeepingTransactions({ ...options, items: [{ txnId: "refund" }] }),
    /expense_refund_explicit_account_required/);
});

test("reopening a bank refund as income archives the old treatment instead of relabeling it", async () => {
  const { db, options } = fixture({ type: "Bank", accounts: [account, { id: "income", name: "Sales", type: "Income", active: true }] });
  await approveBookkeepingTransactions(options);
  const row = db.state.transaction_categorizations[0];
  const oldKey = row.meta.expense_refund_treatment.idempotency_key;
  row.status = "needs_review";
  row.meta.posting_cancelled_at = "2026-11-21T22:00:00.000Z";
  const result = await approveBookkeepingTransactions({ ...options,
    items: [{ txnId: "refund", resolution: "categorize_new", newAccountId: "income", newAccountName: "Sales", only_this_transaction: true }] });
  assert.equal(result.rows[0].meta.expense_refund_treatment, undefined);
  assert.equal(result.rows[0].meta.prior_expense_refund_treatment.idempotency_key, oldKey);
});

test("existing QBO payloads reduce the selected expense without flipping the bank amount", () => {
  const card = buildCreditCardCreditPayload({ amount: 4.99, txnDate: transaction.date, sourceCreditCardAccountId: "card", categoryAccountId: "expense" });
  assert.equal(card.PaymentType, "CreditCard");
  assert.equal(card.Credit, true);
  assert.equal(card.TotalAmt, 4.99);
  assert.equal(card.Line[0].AccountBasedExpenseLineDetail.AccountRef.value, "expense");
  const bank = compileCanonicalDepositPosting({ bankTransaction: transaction, destinationAccount: { id: "bank" }, approvedLineAccount: account });
  assert.equal(bank.entity_type, "Deposit");
  assert.equal(bank.payload.DepositToAccountRef.value, "bank");
  assert.equal(bank.payload.Line[0].DepositLineDetail.AccountRef.value, "expense");
  assert.equal(bank.payload.Line[0].Amount, 4.99);
  assert.equal(transaction.amount, 4.99);
});

test("an expense merchant rule cannot cross direction or business scope", async () => {
  const { db } = fixture();
  db.state.vendor_rules.push({ id: "rule", business_id: A, match_type: "merchant_entity_id", match_value: "lucky",
    rule_kind: "category_default", default_qbo_account_id: "expense", direction_hint: "OUTFLOW" });
  const bankTransaction = { ...transaction, merchant_entity_id: "lucky" };
  assert.equal(await getVendorRuleForTransaction({ db, businessId: A, bankTransaction }), null);
  assert.equal(await getVendorRuleForTransaction({ db, businessId: B, bankTransaction: { ...bankTransaction, amount: -19.77, direction: "OUTFLOW" } }), null);
  assert.equal((await getVendorRuleForTransaction({ db, businessId: A, bankTransaction: { ...bankTransaction, amount: -19.77, direction: "OUTFLOW" } })).id, "rule");
});

test("missing actors and foreign transaction IDs cannot approve a refund", async () => {
  const { db, options } = fixture();
  await assert.rejects(() => approveBookkeepingTransactions({ ...options, actorId: null }), /missing_approval_actor/);
  await assert.rejects(() => approveBookkeepingTransactions({ ...options, businessId: B }), /transaction_not_found/);
  await assert.rejects(() => resolveAuthorizedBusiness({ req: { auth: { userId: "stranger" }, body: { business_id: A } }, supabase: db }),
    error => error.code === "BUSINESS_ACCESS_DENIED");
  assert.equal(db.state.bookkeeping_approval_events.length, 0);
});

test("a verified Admin View session cannot change its selected business for refund approval", async () => {
  const { db } = fixture();
  db.state.internal_admin_view_sessions = [{ id: "session", business_id: A, staff_user_id: "staff", staff_role: "owner_admin",
    read_only: true, session_token_hash: hashAdminViewToken("session-token"), started_at: "2026-01-01", expires_at: "2099-01-01" }];
  db.state.internal_staff_users = [{ user_id: "staff", active: true, role: "owner_admin" }];
  const req = { headers: { "x-bizzi-admin-view": "session-token" }, body: { business_id: A } };
  assert.equal((await resolveAuthorizedBusiness({ req, supabase: db })).id, A);
  for (const input of [{ body: { business_id: B } }, { query: { business_id: B } }, { headers: { ...req.headers, "x-business-id": B } }]) {
    await assert.rejects(() => resolveAuthorizedBusiness({ req: { ...req, ...input }, supabase: db }),
      error => error.code === "admin_view_business_mismatch");
  }
});
