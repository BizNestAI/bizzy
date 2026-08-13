import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const serverSource = readFileSync(join(root, "src/server.js"), "utf8");
const gptRoutesSource = readFileSync(join(root, "src/api/gpt/brain/gpt.routes.js"), "utf8");
const calendarRoutesSource = readFileSync(join(root, "src/api/calendar/calendar.routes.js"), "utf8");
const insightsRoutesSource = readFileSync(join(root, "src/api/insights/insights.routes.js"), "utf8");
const qboAuthSource = readFileSync(join(root, "src/api/auth/quickbooksAuth.js"), "utf8");

const businessScopedMounts = [
  "/api/chats",
  "/api/accounting/metrics",
  "/api/accounting/pulse",
  "/api/accounting/moves",
  "/api/accounting/expense-breakdown",
  "/api/accounting/revenue-series",
  "/api/accounting/profit-series",
  "/api/accounting/reports-sync",
  "/api/accounting/pnl",
  "/api/accounting/forecast",
  "/api/accounting/forecast-accuracy",
  "/api/accounting/scenarios",
  "/api/accounting",
  "/api/qbo",
  "/api/qbo/backfill",
  "/api/ar",
  "/api/bookkeeping",
  "/api/marketing",
  "/api/jobs",
  "/api/job-costing",
  "/api/integrations/plaid",
  "/api/reviews",
  "/api/docs",
];

const userScopedMounts = [
  "/api/bizzy",
];

test("major private business-scoped server mounts use canonical auth and tenant middleware", () => {
  for (const mount of businessScopedMounts) {
    const escaped = mount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`app\\.use\\("${escaped}", requireAuth, requireBusinessContext, `);
    assert.match(serverSource, pattern, `${mount} is not mounted with requireAuth + requireBusinessContext`);
  }
  assert.match(
    serverSource,
    /app\.post\("\/api\/accounting\/affordabilityCheck", requireAuth, requireBusinessContext, affordabilityCheckHandler\)/
  );
});

test("private user-scoped server mounts use canonical auth without requiring tenant context", () => {
  for (const mount of userScopedMounts) {
    const escaped = mount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`app\\.use\\("${escaped}", requireAuth, [^\\n]+\\)`);
    assert.match(serverSource, pattern, `${mount} is not mounted with requireAuth`);
    assert.doesNotMatch(
      serverSource,
      new RegExp(`app\\.use\\("${escaped}", requireAuth, requireBusinessContext, `),
      `${mount} should not require business context`
    );
  }
});

test("provider callbacks and health checks remain intentionally public", () => {
  assert.match(serverSource, /app\.post\(\s*"\/api\/billing\/webhook",\s*express\.raw/);
  assert.match(serverSource, /app\.use\("\/api\/qbo\/webhooks", qboJobCostingWebhooksRouter\)/);
  assert.match(serverSource, /app\.get\("\/api\/email\/callback", gmailOAuthCallback\)/);
  assert.match(serverSource, /app\.get\("\/healthz", \(_req, res\) => res\.status\(200\)\.json/);
  assert.match(serverSource, /app\.get\("\/api\/integrations\/plaid\/_ping", \(_req, res\) =>/);
});

test("mixed GPT, calendar, insights, and QuickBooks routes protect browser endpoints internally", () => {
  assert.match(gptRoutesSource, /router\.post\('\/generate',\s+\.\.\.privateBusinessRoute,/);
  assert.match(gptRoutesSource, /router\.post\('\/pipeline', \.\.\.privateBusinessRoute,/);
  assert.match(calendarRoutesSource, /router\.get\('\/health', healthRoute\)/);
  assert.match(calendarRoutesSource, /router\.patch\('\/events\/:id', \.\.\.privateBusinessRoute,/);
  assert.match(insightsRoutesSource, /router\.get\('\/list', \.\.\.privateBusinessRoute,/);
  assert.match(insightsRoutesSource, /router\.post\('\/feedback', \.\.\.privateBusinessRoute,/);
  assert.match(qboAuthSource, /router\.get\("\/quickbooks", \.\.\.requireVerifiedBusiness,/);
  assert.match(qboAuthSource, /router\.get\("\/callback", async \(req, res\) =>/);
});

test("production server refuses startup when investment auth bypass flags are enabled", () => {
  assert.match(serverSource, /NODE_ENV === "production" && PROD_AUTH_BYPASS_FLAGS\.length/);
  assert.match(serverSource, /\["ALLOW_DEV_NO_TOKEN", process\.env\.ALLOW_DEV_NO_TOKEN\]/);
  assert.match(serverSource, /\["MOCK_INVESTMENTS", process\.env\.MOCK_INVESTMENTS\]/);
  assert.match(serverSource, /Auth bypass flags cannot be enabled in production/);
  assert.match(serverSource, /process\.env\.NODE_ENV !== "production" &&/);
});
