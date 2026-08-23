import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

function sliceRoute(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} should exist`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  return source.slice(start, end >= 0 ? end : source.length);
}

test("customer canonical COA routes are read-only for setup state", () => {
  const route = read("src/api/bookkeeping/routes/bookkeeping.canonicalCoa.routes.js");

  assert.match(route, /router\.get\("\/qbo\/canonical-coa", requireAuth/);
  assert.match(route, /fetchCanonicalAccountMappingsForBusiness/);
  assert.doesNotMatch(route, /import\s+\{[^}]*approveExistingQboAccountForCanonical/s);
  assert.doesNotMatch(route, /import\s+\{[^}]*createPreferredQboAccountForCanonical/s);
});

test("customer canonical COA mutation endpoints fail closed before mapping or provider services", () => {
  const route = read("src/api/bookkeeping/routes/bookkeeping.canonicalCoa.routes.js");
  const legacyCreateRoute = read("src/api/bookkeeping/routes/bookkeeping.qboCoaCreate.routes.js");
  const useExistingRoute = sliceRoute(
    route,
    'router.post("/qbo/canonical-coa/:canonicalKey/use-existing"',
    'router.post("/qbo/canonical-coa/:canonicalKey/create-preferred"'
  );
  const createPreferredRoute = sliceRoute(
    route,
    'router.post("/qbo/canonical-coa/:canonicalKey/create-preferred"',
    "\nexport default router"
  );

  for (const body of [useExistingRoute, createPreferredRoute]) {
    assert.match(body, /res\.status\(403\)\.json/);
    assert.match(body, /canonical_coa_internal_approval_required/);
    assert.doesNotMatch(body, /approveExistingQboAccountForCanonical/);
    assert.doesNotMatch(body, /createPreferredQboAccountForCanonical/);
    assert.doesNotMatch(body, /resolveCanonicalQboAccount/);
    assert.doesNotMatch(body, /business_canonical_qbo_account_mappings/);
    assert.doesNotMatch(body, /createQboAccountFromCanonical|claim_qbo_account_creation_intent/);
  }

  const legacyPost = sliceRoute(legacyCreateRoute, 'router.post("/qbo/coa-create"', "\nexport default router");
  assert.match(legacyPost, /res\.status\(403\)\.json/);
  assert.match(legacyPost, /canonical_coa_internal_approval_required/);
  assert.doesNotMatch(legacyCreateRoute, /createQboCoaAccountIfNeeded/);
  assert.doesNotMatch(legacyPost, /resolveCanonicalQboAccount/);
  assert.doesNotMatch(legacyPost, /createQboAccountFromCanonical|claim_qbo_account_creation_intent/);
});

test("customer Rules UI no longer exposes canonical COA authority controls", () => {
  const ui = read("src/pages/accounting/Rules.jsx");

  assert.match(ui, /getCanonicalQboCoa/);
  assert.match(ui, /Account setup needed/);
  assert.match(ui, /Bizzi will review this during your monthly close/);
  assert.doesNotMatch(ui, /approveExistingCanonicalQboAccount/);
  assert.doesNotMatch(ui, /createPreferredCanonicalQboAccount/);
  assert.doesNotMatch(ui, /createQboCoaAccount/);
  assert.doesNotMatch(ui, /Use Existing Account/);
  assert.doesNotMatch(ui, /Create Bizzi Preferred Account/);
  assert.doesNotMatch(ui, /Create test account/);
});

test("internal Monthly Review remains the only canonical COA map/create authority", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const resolver = read("src/services/bookkeeping/canonicalQboAccountResolver.js");

  assert.match(route, /router\.use\(requireAuth\)/);
  assert.match(route, /router\.use\(requireInternalRole\(MONTHLY_REVIEW_STAFF_ROLES\)\)/);
  assert.match(route, /canonical-coa\/:canonicalKey\/use-existing/);
  assert.match(route, /approveExistingQboAccountForCanonical\(\{/);
  assert.match(route, /canonical-coa\/:canonicalKey\/create-preferred/);
  assert.match(route, /createPreferredQboAccountForCanonical\(\{/);
  assert.match(route, /source:\s*"monthly_review"/);
  assert.match(resolver, /fetchLiveQboAccounts/);
  assert.match(resolver, /qboAccountCompatibleForApproval/);
  assert.match(resolver, /acct\.active !== false/);
  assert.match(resolver, /creationAuthorizedByInternalAccountant/);
  assert.match(resolver, /\["monthly_review", "internal_monthly_review", "internal_admin"\]/);
});

test("background and customer answer paths still cannot create canonical QBO accounts", () => {
  const suggestRoute = read("src/api/bookkeeping/routes/bookkeeping.suggest.routes.js");
  const clarification = read("src/services/bookkeeping/clarificationService.js");
  const reconsideration = read("src/services/bookkeeping/routineExpenseReconsiderationService.js");
  const resolver = read("src/services/bookkeeping/canonicalQboAccountResolver.js");

  assert.match(suggestRoute, /source:\s*"suggest"/);
  assert.match(suggestRoute, /allowCreate:\s*allowQboAccountCreate/);
  assert.match(clarification, /allowProviderWrites = false/);
  assert.match(clarification, /allowCreate:\s*allowQboAccountCreate === true && allowProviderWrites === true/);
  assert.match(reconsideration, /allowCreate:\s*false/);
  assert.match(resolver, /creationAuthorizedByInternalAccountant !== true/);
  assert.match(resolver, /canonical_mapping_requires_internal_approval/);
  assert.match(resolver, /internalMappingAuthority !== true/);
});
