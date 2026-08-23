import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function extractRouteBody(source, route, method = "get") {
  const start = source.indexOf(`router.${method}("${route}"`);
  assert.notEqual(start, -1, `${route} route should exist`);
  const nextRoute = source.indexOf("\nrouter.", start + 1);
  return nextRoute === -1 ? source.slice(start) : source.slice(start, nextRoute);
}

test("Monthly Review connected accounts normalize only active accounts tied to active Plaid items", async () => {
  const { normalizeConnectedFinancialAccountsStatus } = await import("../src/services/plaid/plaidIntegrationService.js");

  const result = normalizeConnectedFinancialAccountsStatus({
    institutions: [
      {
        plaid_item_id: "item-active",
        institution_name: "Bank of Test",
        institution_id: "ins_test",
        status: "connected",
        last_sync_at: "2026-08-22T12:00:00.000Z",
        accounts: [
          {
            plaid_account_id: "acct-checking",
            plaid_item_id: "item-active",
            name: "Business Checking",
            official_name: "Business Checking 8626",
            mask: "8626",
            type: "depository",
            subtype: "checking",
            is_active: true,
            mapped_to_qbo: true,
            plaid_access_token: "secret-token",
          },
          {
            plaid_account_id: "acct-card",
            plaid_item_id: "item-active",
            name: "Blue Cash Everyday",
            mask: "1234",
            type: "credit",
            subtype: "credit card",
            is_active: true,
          },
          {
            plaid_account_id: "acct-disconnected",
            plaid_item_id: "item-active",
            name: "Closed Checking",
            mask: "9999",
            type: "depository",
            subtype: "checking",
            is_active: false,
          },
        ],
      },
      {
        plaid_item_id: "unknown",
        institution_name: "Unknown institution",
        status: "connected",
        accounts: [
          {
            plaid_account_id: "acct-orphan",
            name: "Orphan account",
            type: "depository",
            subtype: "savings",
            is_active: true,
          },
        ],
      },
    ],
  });

  assert.equal(result.current_state_based, true);
  assert.equal(result.accounts_count, 2);
  assert.deepEqual(result.accounts.map((account) => account.plaid_account_id), ["acct-checking", "acct-card"]);
  assert.equal(result.accounts[0].institution_name, "Bank of Test");
  assert.equal(result.accounts[0].mask, "8626");
  assert.equal(result.accounts[0].mapped_to_qbo, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result.accounts[0], "plaid_access_token"), false);
  assert.equal(result.institutions_count, 1);
  assert.match(result.source_contract.active_state, /active Plaid items and active Plaid accounts/);
  assert.equal(result.source_contract.provider_calls, false);
});

test("Monthly Review exposes an admin-only connected accounts endpoint backed by Plaid status service", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const body = extractRouteBody(route, "/businesses/:businessId/connected-accounts", "get");

  assert.match(route, /import \{ getConnectedFinancialAccountsForBusiness \} from "\.\.\/\.\.\/services\/plaid\/plaidIntegrationService\.js"/);
  assert.match(route, /router\.use\(requireAuth\)/);
  assert.match(route, /router\.use\(requireInternalRole\(MONTHLY_REVIEW_STAFF_ROLES\)\)/);
  assert.match(body, /UUID_RE\.test\(String\(businessId\)\)/);
  assert.match(body, /\.from\("business_profiles"\)/);
  assert.match(body, /getConnectedFinancialAccountsForBusiness\(\{ businessId \}\)/);
  assert.match(body, /business_id: businessId/);
  assert.doesNotMatch(body, /getPlaidClient|runPlaidSyncForBusiness|runQboSync|runBooksPostOnce|createLinkToken|exchangePublicToken/);
  assert.doesNotMatch(body, /plaid_access_token|access_token|refresh_token/);
});

test("Monthly Review connected accounts UI loads current accounts independent of selected month", () => {
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const loadStart = ui.indexOf("const loadConnectedAccounts = useCallback");
  assert.notEqual(loadStart, -1, "loadConnectedAccounts should exist");
  const loadEnd = ui.indexOf("const loadBookkeepingFeedCounts", loadStart);
  assert.notEqual(loadEnd, -1, "loadBookkeepingFeedCounts should follow connected accounts loader");
  const loadBody = ui.slice(loadStart, loadEnd);

  assert.match(ui, /ConnectedAccountsPanel/);
  assert.match(loadBody, /\/api\/admin\/monthly-review\/businesses\/\$\{encodeURIComponent\(selectedBusinessId\)\}\/connected-accounts/);
  assert.doesNotMatch(loadBody, /month=/);
  assert.match(ui, /Historical month selection does not change this list/);
  assert.match(ui, /setConnectedAccounts\(null\)/);
  assert.match(ui, /setConnectedAccountsError\(""\)/);
  assert.match(ui, /No currently connected bank or credit-card accounts were found/);
  assert.match(ui, /Could not load connected accounts/);
});

test("Changing business clears stale connected accounts, while changing month does not reload historical account state", () => {
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const businessStart = ui.indexOf("const selectBusiness = useCallback");
  const monthStart = ui.indexOf("const selectMonth = useCallback");
  assert.notEqual(businessStart, -1);
  assert.notEqual(monthStart, -1);
  const businessBody = ui.slice(businessStart, monthStart);
  const monthBody = ui.slice(monthStart, ui.indexOf("const requestFinalizeReview", monthStart));

  assert.match(businessBody, /setConnectedAccounts\(null\)/);
  assert.match(businessBody, /setConnectedAccountsError\(""\)/);
  assert.doesNotMatch(monthBody, /setConnectedAccounts\(null\)/);
  assert.doesNotMatch(monthBody, /connected-accounts/);
});
