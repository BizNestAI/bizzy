import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file) => readFileSync(join(root, file), "utf8");

test("Admin View subscription and QuickBooks status use verified business context", () => {
  const billingRoutes = read("src/api/billing/billing.routes.js");
  const qboAuth = read("src/api/auth/quickbooksAuth.js");
  const billingGate = read("src/components/Billing/BillingGate.jsx");

  assert.match(billingRoutes, /requireVerifiedBillingBusinessOrAdminView = \[requireAuthOrAdminView, requireBusinessAccess\(\)\]/);
  assert.match(billingRoutes, /const adminView = isAdminViewRequest\(req\)/);
  assert.match(billingRoutes, /if \(!adminView\) \{[\s\S]*assertBusinessOwnership/);
  assert.match(billingRoutes, /if \(!adminView\) \{[\s\S]*resolveStripeCustomerForBusiness/);
  assert.match(billingRoutes, /if \(!adminView && payload\.stripe_subscription_id\)/);

  assert.match(qboAuth, /requireVerifiedBusinessOrAdminView = \[requireAuthOrAdminView, requireBusinessAccess\(\)\]/);
  assert.match(qboAuth, /router\.get\("\/status", \.\.\.requireVerifiedBusinessOrAdminView/);

  assert.match(billingGate, /useAdminView/);
  assert.match(billingGate, /if \(adminView\.active\) return/);
  assert.match(billingGate, /disabled=\{adminView\.active\}/);
});

test("Books Review Admin View shows persisted GL category instead of source account fallback", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  const cleanup = read("src/pages/accounting/BookkeepingCleanup.jsx");

  assert.match(feed, /const selectedAccountValue =[\s\S]*\(readOnly \? "" : txn\.accountId\)/);
  const labelBlock = feed.slice(feed.indexOf("const readOnlyGlLabel ="), feed.indexOf("const canRejectCcPayment"));
  assert.match(labelBlock, /txn\.glAccountName[\s\S]*txn\.final_qbo_account_name[\s\S]*txn\.suggested_qbo_account_name[\s\S]*"Uncategorized"/);
  assert.doesNotMatch(labelBlock, /txn\.currentAccount/);
  assert.match(feed, /\{readOnlyGlLabel\}/);

  assert.match(cleanup, /const userId = adminView\.active \? "admin_view" : localStorage\.getItem\("user_id"\)/);
  assert.match(cleanup, /const canRunAI = adminView\.active \? false/);
  assert.match(cleanup, /readOnly=\{adminView\.active \|\| !canRunAI\}/);
});

test("Admin View chat is disabled before subscription or GPT requests while history reads stay business scoped", () => {
  const chatContext = read("src/context/BizzyChatContext.jsx");
  const chatThreads = read("src/hooks/useChatThreads.js");
  const chatsRoutes = read("src/api/chats/chats.routes.js");
  const promptChips = read("src/components/Bizzy/AskBizzyQuickPrompts.jsx");
  const chatBar = read("src/components/Bizzy/BizzyChatBar.jsx");
  const canvasBar = read("src/components/Bizzy/ChatCanvasBar.jsx");

  assert.match(chatContext, /if \(adminView\.active\) \{[\s\S]*return \{ allowed: false, error: 'admin_view_read_only'/);
  assert.match(chatContext, /if \(adminView\.active\) \{[\s\S]*Chat disabled in Admin View[\s\S]*return;/);
  assert.match(chatContext, /chatReadOnly: adminView\.active && adminView\.readOnly/);

  assert.match(promptChips, /disabled = false/);
  assert.match(promptChips, /if \(disabled\) return/);
  assert.match(promptChips, /data-admin-view-chat-disabled/);
  assert.match(chatBar, /if \(chatReadOnly\) return/);
  assert.match(chatBar, /!\s*chatReadOnly \? \(/);
  assert.match(chatBar, /disabled=\{chatReadOnly\}/);
  assert.match(canvasBar, /if \(chatReadOnly\) return/);
  assert.match(canvasBar, /!\s*chatReadOnly \? \(/);
  assert.match(canvasBar, /disabled=\{chatReadOnly\}/);

  assert.match(chatsRoutes, /req\.tenantContext\?\.businessId/);
  assert.match(chatsRoutes, /if \(req\.tenantContext\?\.mode === 'admin_view'\)/);
  assert.match(chatThreads, /if \(readOnly\) return/);
});

test("Forecasts, Financials, Jobs, Tax, Docs, and Settings expose persisted reads but disable customer mutations", () => {
  const accounting = read("src/pages/accounting/AccountingDashboard.jsx");
  const forecasts = read("src/pages/accounting/Forecasts.jsx");
  const forecastEditor = read("src/components/Accounting/ForecastEditorChart.jsx");
  const jobs = read("src/pages/LeadsJobs/JobsDashboard.jsx");
  const tax = read("src/pages/Tax/TaxDashboard.jsx");
  const docs = read("src/pages/Docs/DocsLibraryPage.jsx");
  const settings = read("src/pages/Settings/SettingsHome.jsx");
  const billingCard = read("src/pages/Settings/BillingCard.jsx");
  const taxUtils = read("src/api/tax/taxRouteUtils.js");
  const docsRoutes = read("src/api/docs/docs.routes.js");

  assert.match(accounting, /if \(adminView\.active\) \{[\s\S]*Live refresh is unavailable in read-only Admin View/);
  assert.match(accounting, /disabled=\{refreshing \|\| adminView\.active\}/);

  assert.match(forecasts, /const userId = adminView\.active \? "admin_view"/);
  assert.match(forecasts, /readOnly=\{adminView\.active && adminView\.readOnly\}/);
  assert.match(forecasts, /qbStatusLoading/);
  assert.match(forecastEditor, /if \(readOnly \|\| !hasEdits/);
  assert.match(forecastEditor, /disabled=\{readOnly \|\| !hasEdits/);

  assert.match(jobs, /const businessId = adminView\.active \? adminView\.businessId/);
  assert.match(jobs, /qbStatusLoading/);
  assert.match(jobs, /Live QuickBooks refresh is unavailable in read-only Admin View/);
  assert.match(jobs, /if \(!readOnly && !usingDemo && qbStatus === "connected"/);
  assert.match(jobs, /<JobCostingPage businessId=\{businessId\} usingDemo=\{usingDemo\} readOnly=\{readOnly\}/);

  assert.match(taxUtils, /req\?\.tenantContext\?\.mode === "admin_view"/);
  assert.match(tax, /const businessId = adminView\.active \? adminView\.businessId/);
  assert.match(tax, /Tax setup changes are unavailable in read-only Admin View/);
  assert.match(tax, /disabled=\{readOnly \|\| savingChanges\}/);

  assert.match(docsRoutes, /const adminView = req\.tenantContext\?\.mode === 'admin_view'/);
  assert.match(docsRoutes, /if \(!adminView && !isUuid\(userIdRaw\)\)/);
  assert.match(docs, /const effectiveBusinessId = adminView\.active \? adminView\.businessId/);
  assert.match(docs, /No persisted business documents are available for this Admin View session/);

  assert.match(settings, /const userId = adminView\.active \? "admin_view"/);
  assert.match(settings, /const businessId = adminView\.active \? adminView\.businessId/);
  assert.match(settings, /disabled=\{readOnly \|\| savingBusiness\}/);
  assert.match(settings, /<PlaidIntegrationCard businessId=\{businessId\} readOnly=\{readOnly\}/);
  assert.match(settings, /if \(!businessId \|\| readOnly\) return/);
  assert.match(settings, /disabled=\{readOnly \|\| mappingLoading \|\| saving\}/);
  assert.match(billingCard, /Billing changes are unavailable in read-only Admin View/);
  assert.match(billingCard, /disabled: readOnly \|\| busyAction !== null/);
});
