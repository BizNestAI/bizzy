import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const root = process.cwd();
const adminRoute = readFileSync(join(root, "src/api/admin/monthlyReview.routes.js"), "utf8");
const monthlyReviewUi = readFileSync(join(root, "src/pages/Admin/MonthlyReviewConsole.jsx"), "utf8");
const serviceSource = readFileSync(join(root, "src/services/bookkeeping/bookkeepingTransactionFeedService.js"), "utf8");
const customerRoute = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.transactions.routes.js"), "utf8");
const migration = readFileSync(join(root, "supabase/migrations/20260909_bookkeeping_bounded_month_end.sql"), "utf8");

const servicePromise = import("../src/services/bookkeeping/bookkeepingTransactionFeedService.js");
const workflowPromise = import("../src/services/bookkeeping/protectedWorkflow.js");

test("shared feed service preserves Books Review status semantics", async () => {
  const { matchesTransactionStatusFilter } = await servicePromise;

  assert.equal(matchesTransactionStatusFilter("needs_review", null), true);
  assert.equal(matchesTransactionStatusFilter("needs_review", { status: "uncategorized" }), true);
  assert.equal(matchesTransactionStatusFilter("needs_review", { status: "approved" }), false);
  assert.equal(matchesTransactionStatusFilter("needs_review", { status: "auto_approved", meta: { is_check: true } }), true);
  assert.equal(matchesTransactionStatusFilter("handled", { status: "approved" }), true);
  assert.equal(matchesTransactionStatusFilter("handled", { status: "auto_approved" }), true);
  assert.equal(matchesTransactionStatusFilter("handled", { status: "failed" }), true);
  assert.equal(matchesTransactionStatusFilter("handled", { status: "posted", qbo_txn_id: "1" }), false);
  assert.equal(matchesTransactionStatusFilter("posted", { status: "approved", qbo_txn_id: "qbo-1" }), true);
});

test("shared service sends exact selected-month end bound before pagination", async () => {
  const { fetchBookkeepingTransactions, countBookkeepingTransactions } = await servicePromise;
  const rpcCalls = [];
  const db = {
    rpc: async (name, params) => {
      rpcCalls.push({ name, params });
      if (name === "count_bookkeeping_transactions_bounded") return { data: 12, error: null };
      return {
        data: [{
          id: "txn-1",
          date: "2026-08-12",
          name: "Uber SF",
          amount: -24.9,
          cat_status: "needs_review",
          total_count: 12,
          operator_request_id: "req-1",
          operator_request_status: "answered",
          operator_prompt_text: "What was this ride for?",
          operator_answer_text: "Client visit",
          operator_answered_at: "2026-08-13T10:00:00Z",
          cat_meta: { taxonomy_type: "cc_payment", cc_payment_pair_id: "pair-1" },
        }],
        error: null,
      };
    },
  };

  const count = await countBookkeepingTransactions({
    businessId: "biz-1",
    statusFilter: "needs_review",
    rangeStart: "2026-08-01",
    rangeEnd: "2026-09-01",
    db,
  });
  const result = await fetchBookkeepingTransactions({
    businessId: "biz-1",
    statusFilter: "needs_review",
    rangeStart: "2026-08-01",
    rangeEnd: "2026-09-01",
    page: 2,
    pageSize: 25,
    db,
  });

  assert.equal(count, 12);
  assert.equal(rpcCalls[0].name, "count_bookkeeping_transactions_bounded");
  assert.equal(rpcCalls[0].params.p_range_start, "2026-08-01");
  assert.equal(rpcCalls[0].params.p_range_end, "2026-09-01");
  assert.equal(rpcCalls[1].name, "get_bookkeeping_transactions_bounded");
  assert.equal(rpcCalls[1].params.p_range_start, "2026-08-01");
  assert.equal(rpcCalls[1].params.p_range_end, "2026-09-01");
  assert.equal(rpcCalls[1].params.p_limit, 25);
  assert.equal(rpcCalls[1].params.p_offset, 25);
  assert.equal(result.totalCount, 12);
  assert.equal(result.rows[0].customer_answered, true);
  assert.equal(result.rows[0].customer_response, "Client visit");
  assert.equal(result.rows[0].cc_payment_pair_id, "pair-1");
});

test("shared feed service enriches Plaid account ids into human-readable bank labels", async () => {
  const { fetchBookkeepingTransactions } = await servicePromise;
  const rpcCalls = [];
  const fromCalls = [];
  const db = {
    rpc: async (name, params) => {
      rpcCalls.push({ name, params });
      return {
        data: [{
          id: "txn-1",
          plaid_account_id: "raw-plaid-account-id",
          date: "2026-08-12",
          name: "Publix",
          amount: -42.5,
          cat_status: "needs_review",
          total_count: 1,
        }],
        error: null,
      };
    },
    from: (table) => ({
      select: (columns) => ({
        eq: (column, value) => ({
          in: async (inColumn, ids) => {
            fromCalls.push({ table, columns, column, value, inColumn, ids });
            return {
              data: [{
                plaid_account_id: "raw-plaid-account-id",
                name: "Blue Cash Everyday®",
                official_name: "American Express Blue Cash Everyday",
                mask: "1008",
                type: "credit",
                subtype: "credit card",
                institution_name: "American Express",
              }],
              error: null,
            };
          },
        }),
      }),
    }),
  };

  const result = await fetchBookkeepingTransactions({
    businessId: "biz-1",
    statusFilter: "needs_review",
    rangeStart: "2026-08-01",
    rangeEnd: "2026-09-01",
    db,
  });

  assert.equal(rpcCalls.length, 1);
  assert.equal(fromCalls[0].table, "plaid_accounts");
  assert.equal(fromCalls[0].column, "business_id");
  assert.deepEqual(fromCalls[0].ids, ["raw-plaid-account-id"]);
  assert.equal(result.rows[0].currentAccount, "Blue Cash Everyday® ••••1008");
  assert.equal(result.rows[0].bank_account, "Blue Cash Everyday® ••••1008");
  assert.notEqual(result.rows[0].bank_account, "raw-plaid-account-id");
  assert.equal(result.rows[0].account_subtype, "credit card");
});

test("SQL RPC overload filters by range end before pagination and remains service-role only", () => {
  assert.match(migration, /p_range_end date default null/);
  assert.match(migration, /and \(p_range_end is null or bt\.date < p_range_end\)/);
  assert.match(migration, /order by scoped\.date desc nulls last, scoped\.id desc[\s\S]*limit greatest/);
  assert.match(migration, /revoke all on function public\.get_bookkeeping_transactions_bounded\(uuid, text, text, date, date, integer, integer\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.count_bookkeeping_transactions_bounded\(uuid, text, text, date, date\) to service_role/);
});

test("customer Books Review route delegates bounded retrieval to the shared service", () => {
  assert.match(customerRoute, /from "..\/..\/..\/services\/bookkeeping\/bookkeepingTransactionFeedService\.js"/);
  assert.match(customerRoute, /fetchBookkeepingTransactions/);
  assert.match(customerRoute, /countBookkeepingTransactions/);
  assert.doesNotMatch(customerRoute, /function normalizeBookkeepingTransactionRow/);
  assert.doesNotMatch(customerRoute, /function normalizeBookkeepingRpcRow/);
});

test("admin Monthly Review exposes internal-only bounded mirror endpoints", () => {
  assert.match(adminRoute, /router\.use\(requireAuth\)/);
  assert.match(adminRoute, /router\.use\(requireInternalRole\(MONTHLY_REVIEW_STAFF_ROLES\)\)/);
  assert.match(adminRoute, /\/businesses\/:businessId\/bookkeeping\/transactions\/counts/);
  assert.match(adminRoute, /\/businesses\/:businessId\/bookkeeping\/transactions"/);
  assert.match(adminRoute, /\/businesses\/:businessId\/bookkeeping\/transactions\/reconsider/);
  assert.match(adminRoute, /reconsiderNeedsReviewTransactions/);
  assert.match(adminRoute, /reviewed_this_month:\s*totals\.processed/);
  assert.match(adminRoute, /moved_to_handled_this_month:\s*totals\.promoted/);
  assert.match(adminRoute, /remaining_needs_review_this_month/);
  assert.match(adminRoute, /remaining_needs_review_all_months/);
  assert.match(adminRoute, /const inclusiveRangeEnd = previousDate\(rangeEnd\)/);
  assert.match(adminRoute, /dateTo:\s*inclusiveRangeEnd/);
  assert.match(adminRoute, /selected_month_bounds:\s*"server-side \[range_start, range_end\)"/);
  assert.match(adminRoute, /qbo_provider_writes:\s*false/);
  assert.match(adminRoute, /qbo_transaction_writes:\s*false/);
  assert.match(adminRoute, /MONTHLY_REVIEW_BOOKKEEPING_FEED_STATUSES = new Set\(\["needs_review", "handled"\]\)/);
  assert.match(adminRoute, /const \[rangeStart, rangeEnd\] = monthBounds\(month\)/);
  assert.match(adminRoute, /statusFilter:\s*"needs_review"[\s\S]*rangeStart[\s\S]*rangeEnd/);
  assert.match(adminRoute, /statusFilter:\s*"handled"[\s\S]*rangeStart[\s\S]*rangeEnd/);
  assert.match(adminRoute, /page_size:\s*pageSize/);
  assert.match(adminRoute, /provider_calls:\s*false/);
  assert.doesNotMatch(adminRoute, /getPlaid|runQboSync\([^)]*bookkeeping\/transactions/);
});

test("Monthly Review renders collapsible Needs Review and Handled mirrors with bounded load-more paging", () => {
  assert.match(monthlyReviewUi, /BOOKKEEPING_FEED_PAGE_SIZE = 25/);
  assert.match(monthlyReviewUi, /needs_review:\s*\{[\s\S]*label:\s*"Needs Review"/);
  assert.match(monthlyReviewUi, /handled:\s*\{[\s\S]*label:\s*"Handled in Books Review"/);
  assert.match(monthlyReviewUi, /BookkeepingFeedMirrorPanels/);
  assert.match(monthlyReviewUi, /Re-evaluate Needs Review/);
  assert.match(monthlyReviewUi, /bookkeeping\/transactions\/reconsider/);
  assert.match(monthlyReviewUi, /reviewed_this_month/);
  assert.match(monthlyReviewUi, /still need review for \$\{formatMonthShort\(month\)\}/);
  assert.match(monthlyReviewUi, /Needs Review across all imported months/);
  assert.match(monthlyReviewUi, /patchBookkeepingFeedsAfterReconsiderationState/);
  assert.match(monthlyReviewUi, /aria-expanded=\{expanded\}/);
  assert.match(monthlyReviewUi, /\/bookkeeping\/transactions\/counts\?month=/);
  assert.match(monthlyReviewUi, /\/bookkeeping\/transactions\?month=.*status=.*page=.*page_size=\$\{BOOKKEEPING_FEED_PAGE_SIZE\}/s);
  assert.match(monthlyReviewUi, /rows:\s*reset \? rows : \[\.\.\.\(current\[status\]\?\.rows \|\| \[\]\), \.\.\.rows\]/);
  assert.match(monthlyReviewUi, /setBookkeepingFeeds\(buildInitialBookkeepingFeeds\(\)\)/);
});

test("mirror row presenter preserves customer-answer, QBO, and special-workflow state without mutations", () => {
  const tableSource = readFileSync(join(root, "src/components/Accounting/BookkeepingTransactionMirrorTable.jsx"), "utf8");
  const workflowSource = readFileSync(join(root, "src/services/bookkeeping/protectedWorkflow.js"), "utf8");
  assert.match(tableSource, /Bank Account/);
  assert.match(tableSource, /GL Account/);
  assert.match(tableSource, /QBO Status/);
  assert.match(tableSource, /Action/);
  assert.doesNotMatch(tableSource, /<span>State<\/span>/);
  assert.doesNotMatch(tableSource, /<span className="text-right">Amount<\/span>/);
  assert.match(tableSource, /Customer answered/);
  assert.match(tableSource, /deriveQboPostingLifecycle/);
  assert.match(tableSource, /const qboLabel = qboStatus\.label/);
  assert.match(tableSource, /Credit-card payment/);
  assert.match(tableSource, /Possible card payment/);
  assert.match(tableSource, /Duplicate risk/);
  assert.match(tableSource, /formatPlaidAccountDisplayLabel/);
  assert.match(tableSource, /formatBankAccountLabel/);
  assert.match(tableSource, /getProtectedWorkflowReason/);
  assert.match(workflowSource, /Pending bank transaction/);
  assert.match(workflowSource, /Owner movement/);
  assert.match(workflowSource, /Tax payment/);
  assert.doesNotMatch(tableSource, />\s*Special workflow\s*</);
  assert.doesNotMatch(tableSource, /formatAccountType/);
  assert.doesNotMatch(tableSource, /safeFetch/);
  assert.doesNotMatch(tableSource, /fetch\(|createQbo|runBooksPostOnce|postSingleBookkeepingTransactionNow/);
  assert.match(tableSource, /onApprove/);
  assert.match(tableSource, /onPost/);
  assert.match(tableSource, /onRetry/);
});

test("ordinary credit-card merchant purchases are editable and true card payments stay protected", async () => {
  const { getProtectedWorkflowReason, isProtectedCreditCardPaymentWorkflow } = await workflowPromise;

  for (const merchant of ["Apple", "Spotify", "Publix", "Railway", "Instantly", "Atlassian"]) {
    const row = {
      id: `txn-${merchant}`,
      payee: merchant,
      account_type: "credit",
      account_subtype: "credit card",
      pending: false,
      cc_payment_rejected: false,
      taxonomy_type: null,
      meta: {},
    };
    assert.equal(isProtectedCreditCardPaymentWorkflow(row), false);
    assert.equal(getProtectedWorkflowReason(row), null);
  }

  const truePayment = {
    taxonomy_type: "cc_payment",
    cc_payment_pair_id: "pair-1",
    cc_payment_pair_status: "confirmed",
    cc_payment_pair_confidence: "high",
    cc_payment_bank_qbo_account_id: "bank-qbo",
    cc_payment_cc_qbo_account_id: "cc-qbo",
  };
  assert.equal(isProtectedCreditCardPaymentWorkflow(truePayment), true);
  assert.equal(getProtectedWorkflowReason(truePayment).label, "Credit card payment");
});

test("pending Plaid rows are protected specifically as pending bank transactions", async () => {
  const { getProtectedWorkflowReason } = await workflowPromise;
  const reason = getProtectedWorkflowReason({
    pending: true,
    payee: "Apple",
    account_type: "credit",
    account_subtype: "credit card",
    cc_payment_rejected: false,
  });
  assert.equal(reason.label, "Pending bank transaction");
});
