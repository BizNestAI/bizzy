import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", "build", "coverage"].includes(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (/\.(js|jsx|ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

const frontendRoots = [
  "src/components",
  "src/pages",
  "src/hooks",
  "src/auth",
];

const browserFiles = frontendRoots.flatMap((dir) => walk(join(root, dir)));
const browserSource = browserFiles
  .map((file) => `\n// ${relative(root, file)}\n${readFileSync(file, "utf8")}`)
  .join("\n");

const onboardingSource = read("src/hooks/useOnboardingStatus.js");
const integrationManagerSource = read("src/hooks/useIntegrationManager.js");
const businessServiceSource = read("src/services/businessService.js");
const plaidRoutesSource = read("src/api/integrations/plaid.routes.js");
const qboAuthSource = read("src/api/auth/quickbooksAuth.js");
const serverSource = read("src/server.js");

test("frontend no longer directly reads server-only integration credential tables", () => {
  const credentialTables = [
    "quickbooks_tokens",
    "plaid_items",
    "linked_financial_items",
    "oauth_connection_states",
    "email_accounts",
    "email_account_secrets",
  ];

  for (const table of credentialTables) {
    const directQuery = new RegExp(`\\.from\\(\\s*['"\`]${table}['"\`]\\s*\\)`);
    assert.doesNotMatch(browserSource, directQuery, `browser source still queries ${table}`);
  }
});

test("onboarding status uses backend integration status APIs instead of credential-table fallbacks", () => {
  assert.match(onboardingSource, /\/auth\/status\?business_id=/);
  assert.match(onboardingSource, /\/api\/integrations\/plaid\/status\?business_id=/);
  assert.doesNotMatch(onboardingSource, /\.from\(\s*["']quickbooks_tokens["']\s*\)/);
  assert.doesNotMatch(onboardingSource, /\.from\(\s*["']plaid_items["']\s*\)/);
});

test("integration status consumers do not depend on raw QBO realm IDs", () => {
  assert.match(qboAuthSource, /realm_id_present: Boolean\(data\?\.realm_id\)/);
  assert.doesNotMatch(qboAuthSource, /realm_id:\s*data\?\.realm_id/);
  assert.doesNotMatch(qboAuthSource, /scope:\s*data\?\.scope/);
  assert.match(integrationManagerSource, /realmIdPresent: Boolean\(res\?\.realm_id_present\)/);
  assert.doesNotMatch(integrationManagerSource, /res\?\.realm_id(?!_present)/);
});

test("QBO and Plaid status APIs are protected by canonical auth and tenant context", () => {
  assert.match(qboAuthSource, /const requireVerifiedBusiness = \[requireAuth, requireBusinessAccess\(\)\]/);
  assert.match(qboAuthSource, /router\.get\("\/status", \.\.\.requireVerifiedBusiness/);
  assert.match(qboAuthSource, /const business_id = req\.business\?\.id \|\| req\.auth\?\.businessId \|\| null/);

  assert.match(serverSource, /app\.use\("\/api\/integrations\/plaid", requireAuth, requireBusinessContext, plaidIntegrationsRouter\)/);
  assert.match(plaidRoutesSource, /req\.business\?\.id/);
  assert.doesNotMatch(plaidRoutesSource, /b\.business_id|q\.business_id|h\["x-business-id"\]/);
});

test("status responses do not expose provider credential fields", () => {
  const responseLeakPatterns = [
    /res\.json\([^)]*access_token/i,
    /res\.json\([^)]*refresh_token/i,
    /encrypted_access_token/i,
    /client_secret:\s*[^,\n}]+/,
  ];

  for (const pattern of responseLeakPatterns) {
    assert.doesNotMatch(qboAuthSource, pattern);
    assert.doesNotMatch(plaidRoutesSource, pattern);
  }
});

test("browser import roots do not import the service-role Supabase admin module", () => {
  assert.doesNotMatch(
    browserSource,
    /from\s+["'][^"']*supabaseAdmin(?:\.js)?["']/,
    "frontend root imports supabaseAdmin"
  );
});

test("current onboarding foundation writes have moved behind backend authority", () => {
  assert.match(businessServiceSource, /\.from\('user_profiles'\)[\s\S]*?\.upsert/);
  assert.match(businessServiceSource, /role:\s*'owner'/);
  assert.doesNotMatch(businessServiceSource, /\.from\('business_profiles'\)[\s\S]*?\.insert/);
  assert.match(businessServiceSource, /\/api\/onboarding\/business/);
  assert.match(businessServiceSource, /\.from\('business_profiles'\)[\s\S]*?\.update/);
  assert.doesNotMatch(read("src/pages/UserAdmin/BusinessWizard.jsx"), /\.from\('user_business_link'\)[\s\S]*?\.insert/);
});
