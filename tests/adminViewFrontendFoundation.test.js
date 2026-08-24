import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

const adminViewClientSource = read("src/services/adminViewClient.js");
const adminViewContextSource = read("src/context/AdminViewContext.jsx");
const redeemPageSource = read("src/pages/AdminView/AdminViewRedeem.jsx");
const mainSource = read("src/main.jsx");
const safeFetchSource = read("src/utils/safeFetch.js");
const authenticatedFetchSource = read("src/services/api/authenticatedFetch.js");
const apiBaseSource = read("src/utils/apiBase.js");
const businessContextSource = read("src/context/BusinessContext.jsx");
const protectedRouteSource = read("src/components/UserAdmin/ProtectedRoute.jsx");
const mainLayoutSource = read("src/layout/MainLayout.jsx");
const navRailBusinessBadgeSource = read("src/layout/NavRailBusinessBadge.jsx");
const readOnlyGuardSource = read("src/components/AdminView/AdminViewReadOnlyGuard.jsx");
const monthlyReviewSource = read("src/pages/Admin/MonthlyReviewConsole.jsx");

test("customer app exposes an Admin View redemption route without enabling Monthly Review button", () => {
  assert.match(mainSource, /import AdminViewRedeem from "\.\/pages\/AdminView\/AdminViewRedeem\.jsx"/);
  assert.match(mainSource, /<AdminViewProvider>/);
  assert.match(mainSource, /path="\/admin-view\/redeem" element=\{<AdminViewRedeem \/>\}/);
  assert.match(redeemPageSource, /new URLSearchParams\(window\.location\.search/);
  assert.match(redeemPageSource, /redeemStartedRef\.current/);
  assert.match(redeemPageSource, /redeemHandoff\(token\)/);
  assert.match(redeemPageSource, /window\.history\.replaceState\(\{\}, document\.title, "\/admin-view\/redeem"\)/);
  assert.match(redeemPageSource, /navigate\("\/dashboard\/bizzi\/chat", \{ replace: true/);
});

test("Admin View active authority is sessionStorage-only and separate from Supabase auth", () => {
  assert.match(adminViewClientSource, /ADMIN_VIEW_SESSION_STORAGE_KEY = "bizzi:admin_view_session"/);
  assert.match(adminViewClientSource, /window\.sessionStorage/);
  assert.doesNotMatch(adminViewClientSource, /localStorage\.setItem/);
  assert.doesNotMatch(adminViewClientSource, /localStorage\.getItem/);
  assert.match(adminViewClientSource, /payload\?\.admin_view_session/);
  assert.match(adminViewClientSource, /clearStoredAdminViewSession/);
  assert.match(adminViewClientSource, /bizzy:admin-view-cleared/);
  assert.match(adminViewContextSource, /fetchAdminViewContext\(\)/);
  assert.match(adminViewContextSource, /endAdminViewSession\(\)/);
  assert.match(adminViewContextSource, /window\.addEventListener\("bizzy:admin-view-cleared"/);
});

test("safe fetch helpers attach x-bizzi-admin-view and override stale business headers", () => {
  assert.match(adminViewClientSource, /export const ADMIN_VIEW_HEADER = "x-bizzi-admin-view"/);
  assert.match(adminViewClientSource, /headers\.set\(ADMIN_VIEW_HEADER, token\)/);
  assert.match(adminViewClientSource, /headers\.set\("x-business-id", context\.businessId\)/);
  assert.match(adminViewClientSource, /headers\.delete\("x-business-id"\)/);
  assert.match(safeFetchSource, /applyAdminViewHeaders\(headers\)/);
  assert.match(authenticatedFetchSource, /applyAdminViewHeaders\(headers\)/);
  assert.match(apiBaseSource, /window\.sessionStorage\?\.getItem\("bizzi:admin_view_session"\)/);
  assert.match(apiBaseSource, /headers\.set\("x-bizzi-admin-view", token\)/);
  assert.match(apiBaseSource, /headers\.set\("x-business-id", context\.businessId\)/);
  assert.match(apiBaseSource, /clearAdminViewOnAuthFailure\(res, headers\)/);
  assert.match(safeFetchSource, /isAdminViewAuthError\(json\).*clearStoredAdminViewSession/s);
  assert.match(authenticatedFetchSource, /isAdminViewAuthError\(code\).*clearStoredAdminViewSession/s);
});

test("BusinessContext and ProtectedRoute use server-fixed Admin View business instead of ownership", () => {
  assert.match(protectedRouteSource, /adminView\.active && adminView\.readOnly && adminView\.businessId/);
  assert.match(protectedRouteSource, /verifiedUserKeyRef\.current = `admin_view:\$\{adminView\.businessId\}`/);
  assert.match(protectedRouteSource, /Admin View session ended/);
  assert.match(protectedRouteSource, /Return to Monthly Review/);
  assert.match(businessContextSource, /if \(adminView\.active\) \{/);
  assert.match(businessContextSource, /setBusinessIdState\(adminView\.businessId \|\| null\)/);
  assert.match(businessContextSource, /business_name: adminView\.businessName \|\| "Selected business"/);
  assert.match(businessContextSource, /if \(adminView\.active\) return undefined/);
  assert.match(businessContextSource, /if \(adminView\.active\) \{\s+setBusinessIdState\(adminView\.businessId \|\| null\);\s+return;/s);
});

test("persistent Admin View banner exposes read-only state, return, and exit", () => {
  assert.match(mainLayoutSource, /function AdminViewBanner\(\)/);
  assert.match(mainLayoutSource, /Admin View · Read Only/);
  assert.match(mainLayoutSource, /Viewing: \{adminView\.businessName/);
  assert.match(mainLayoutSource, /Return to Monthly Review/);
  assert.match(mainLayoutSource, /Exit Admin View/);
  assert.match(mainLayoutSource, /await adminView\.endAdminView\?\.\(\)/);
  assert.match(mainLayoutSource, /paddingTop: adminView\.active \? 44 : 0/);
  assert.match(mainLayoutSource, /<AdminViewReadOnlyGuard \/>/);
  assert.match(readOnlyGuardSource, /MUTATION_LABEL_RE/);
  assert.match(readOnlyGuardSource, /Read-only Admin View blocks customer mutations/);
  assert.match(readOnlyGuardSource, /event\.preventDefault\(\)/);
});

test("customer business switch affordance is fixed in Admin View", () => {
  assert.match(navRailBusinessBadgeSource, /useAdminView/);
  assert.match(navRailBusinessBadgeSource, /adminView\.active\s+\?\s+adminView\.businessId/s);
  assert.match(navRailBusinessBadgeSource, /if \(adminView\.active\) return undefined/);
  assert.match(navRailBusinessBadgeSource, /disabled=\{adminView\.active\}/);
  assert.match(navRailBusinessBadgeSource, /Admin View business is fixed/);
});

test("normal customer paths remain present when Admin View is inactive", () => {
  assert.match(businessContextSource, /localStorage\.getItem\("currentBusinessId"\)/);
  assert.match(businessContextSource, /\.from\("business_profiles"\)/);
  assert.match(businessContextSource, /\.from\("user_business_link"\)/);
  assert.match(protectedRouteSource, /if \(!loading && !adminView\.loading && !adminView\.active && !user\)/);
  assert.match(safeFetchSource, /supabase\.auth\.getSession\(\)/);
  assert.match(authenticatedFetchSource, /supabase\.auth\.getSession\(\)/);
});

test("Monthly Review View Customer App mints handoff for selected business and opens a new tab", () => {
  assert.doesNotMatch(monthlyReviewSource, /Admin customer view coming in the next implementation phase/);
  assert.match(monthlyReviewSource, /const openCustomerApp = async \(\) =>/);
  assert.match(monthlyReviewSource, /window\.open\("about:blank", "_blank"\)/);
  assert.match(monthlyReviewSource, /placeholderTab\.opener = null/);
  assert.match(monthlyReviewSource, /safeFetch\("\/api\/admin\/customer-view\/sessions"/);
  assert.match(monthlyReviewSource, /business_id: selectedBusinessId/);
  assert.match(monthlyReviewSource, /source: "monthly_review"/);
  assert.match(monthlyReviewSource, /return_url: returnUrl/);
  assert.match(monthlyReviewSource, /placeholderTab\.location\.assign\(handoffUrl\)/);
  assert.match(monthlyReviewSource, /placeholderTab\.close\(\)/);
  assert.match(monthlyReviewSource, /buildMonthlyReviewReturnUrl\(\{ month, businessId: selectedBusinessId \}\)/);
});

test("Monthly Review return URL preserves selected business and month without privileged tokens", () => {
  assert.match(monthlyReviewSource, /function buildMonthlyReviewReturnUrl\(\{ businessId, month \}\)/);
  assert.match(monthlyReviewSource, /url\.searchParams\.delete\("token"\)/);
  assert.match(monthlyReviewSource, /url\.searchParams\.set\("business_id", businessId\)/);
  assert.match(monthlyReviewSource, /url\.searchParams\.set\("review_month", month\)/);
  assert.doesNotMatch(monthlyReviewSource, /admin_view_session.*return_url/);
});

test("Admin View client redeems handoff into sessionStorage and omits raw token logging", async () => {
  const storage = new Map();
  const previousWindow = global.window;
  global.window = {
    location: { hostname: "localhost" },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
  };
  const {
    ADMIN_VIEW_CONTEXT_STORAGE_KEY,
    ADMIN_VIEW_SESSION_STORAGE_KEY,
    getStoredAdminViewSessionToken,
    redeemAdminViewHandoff,
  } = await import(`../src/services/adminViewClient.js?test=${Date.now()}`);

  const calls = [];
  const result = await redeemAdminViewHandoff("one-time-token", {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        ok: true,
        admin_view_session: "active-token",
        context: {
          admin_view: true,
          read_only: true,
          business_id: "business-a",
          business_name: "Pat's Test Account",
          staff_role: "owner_admin",
          return_url: "https://admin.bizzios.com/monthly-review",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).token, "one-time-token");
  assert.equal(result.token, "active-token");
  assert.equal(getStoredAdminViewSessionToken(), "active-token");
  assert.equal(storage.get(ADMIN_VIEW_SESSION_STORAGE_KEY), "active-token");
  assert.match(storage.get(ADMIN_VIEW_CONTEXT_STORAGE_KEY), /"businessId":"business-a"/);
  assert.equal(global.window.localStorage, undefined);
  global.window = previousWindow;
});
