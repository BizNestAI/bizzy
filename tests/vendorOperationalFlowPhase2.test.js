import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

test("posting gates vendor-required Purchases and CreditCardCharges before QBO transaction create", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const handleBody = cron.slice(cron.indexOf("export async function handleItem"), cron.indexOf("function taxYearFromDate"));
  const gateIndex = handleBody.indexOf("ensureRequiredVendorBeforePosting");
  const createIndex = handleBody.indexOf("postToQbo(item, bank, qbo, mapping, requestId)");

  assert.ok(gateIndex > 0);
  assert.ok(createIndex > gateIndex);
  assert.match(handleBody, /const vendorGate = await ensureRequiredVendorBeforePosting/);
  assert.match(handleBody, /if \(!vendorGate\.ok\) return/);
  assert.doesNotMatch(handleBody, /vendor ensure failed[\s\S]*postToQbo/);
});

test("Purchase and CreditCardCharge payloads attach vendor refs from canonical assignment cache", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  assert.match(cron, /function getQboEntityRef\(bankTxn = \{\}, desiredType = "vendor"\)/);
  assert.match(cron, /postBankOutflowPurchase[\s\S]*const vendorRef = getQboEntityRef\(bankTxn, "vendor"\)/);
  assert.match(cron, /postBankOutflowPurchase[\s\S]*EntityRef: \{ value: vendorRef\.value, type: "Vendor" \}/);
  assert.match(cron, /postCreditCardOutflowCharge[\s\S]*const vendorRef = getQboEntityRef\(bankTxn, "vendor"\)/);
  assert.match(cron, /postCreditCardOutflowCharge[\s\S]*EntityRef: \{ value: vendorRef\.value, type: "Vendor" \}/);
  assert.match(cron, /postCreditCardOutflowCharge[\s\S]*PayeeEntityRef: \{ value: vendorRef\.value, type: "Vendor" \}/);
});

test("vendor-required failures are classified into retryable or review states without transaction create", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  assert.match(cron, /function classifyVendorEnsureOutcome/);
  assert.match(cron, /vendor_qbo_auth_required/);
  assert.match(cron, /vendor_qbo_lookup_failed/);
  assert.match(cron, /vendor_qbo_timeout/);
  assert.match(cron, /vendor_qbo_create_unknown/);
  assert.match(cron, /vendor_create_pending/);
  assert.match(cron, /vendor_mapping_invalid/);
  assert.match(cron, /function markVendorPostingBlocked/);
  assert.match(cron, /status: outcome\.review \? "needs_review" : item\.status/);
  assert.match(cron, /vendor_review_canonical_vendor_id/);
  assert.match(cron, /vendor_failure_stage/);
  assert.match(cron, /vendor_failure_provider_code/);
  assert.match(cron, /reconnect_required/);
  const service = read("src/services/bookkeeping/canonicalVendorService.js");
  assert.match(service, /qbo_vendor_mapping_revalidation/);
  assert.match(service, /qbo_vendor_create_recovery/);
  assert.match(service, /qbo_customer_lookup/);
  assert.match(service, /qbo_employee_lookup/);
});

test("manual posting UI maps safe Vendor diagnostics to human-readable messages", () => {
  const ui = read("src/pages/accounting/BookkeepingCleanup.jsx");
  assert.match(ui, /vendor_qbo_auth_required[\s\S]*Reconnect QuickBooks/);
  assert.match(ui, /vendor_qbo_lookup_failed[\s\S]*QuickBooks Vendor check failed/);
  assert.match(ui, /vendor_qbo_name_conflict[\s\S]*Review Vendor mapping/);
  assert.match(ui, /vendor_qbo_create_unknown[\s\S]*QuickBooks Vendor status unknown/);
});

test("canonical vendor service validates active mappings before using stale local qbo entity fields", () => {
  const service = read("src/services/bookkeeping/canonicalVendorService.js");
  const mappingBranch = service.slice(service.indexOf("if (existingMapping?.qbo_vendor_id)"), service.indexOf("const desiredDisplayName"));
  assert.match(mappingBranch, /refreshQboVendorNameList/);
  assert.match(mappingBranch, /findUsableCachedVendor/);
  assert.match(mappingBranch, /markMappingNeedsReview/);
  assert.match(mappingBranch, /reason: "vendor_mapping_invalid"/);
  assert.doesNotMatch(mappingBranch, /bankTxn\.qbo_entity_id/);
});

test("canonical vendor alias lookup disambiguates the tenant-scoped Vendor relationship", () => {
  const service = read("src/services/bookkeeping/canonicalVendorService.js");
  assert.match(
    service,
    /\.from\("vendor_aliases"\)[\s\S]*\.select\("canonical_vendor_id,bizzi_vendors!vendor_aliases_business_vendor_fk\(\*\)"\)/
  );
  assert.doesNotMatch(service, /bizzi_vendors\(\*\)/);
  const migration = read("supabase/migrations/20260828_canonical_vendor_identity.sql");
  assert.match(migration, /canonical_vendor_id uuid not null references public\.bizzi_vendors\(id\)/);
  assert.match(migration, /vendor_aliases_business_vendor_fk[\s\S]*foreign key \(business_id, canonical_vendor_id\)[\s\S]*references public\.bizzi_vendors \(business_id, id\)/);
});

test("active QBO Vendor mapping persistence uses partial-index-aware RPC instead of PostgREST upsert", () => {
  const service = read("src/services/bookkeeping/canonicalVendorService.js");
  const upsertMappingBody = service.slice(service.indexOf("async function upsertMapping"), service.indexOf("async function hydrateCanonicalVendor"));
  assert.match(upsertMappingBody, /db\.rpc\("upsert_active_qbo_vendor_mapping"/);
  assert.doesNotMatch(upsertMappingBody, /\.from\("business_qbo_vendor_mappings"\)\.upsert/);
  assert.doesNotMatch(upsertMappingBody, /onConflict: "business_id,qbo_env,realm_id,canonical_vendor_id"/);

  const migration = read("supabase/migrations/20260901_upsert_active_qbo_vendor_mapping_rpc.sql");
  assert.match(migration, /create or replace function public\.upsert_active_qbo_vendor_mapping/);
  assert.match(migration, /perform 1[\s\S]*from public\.bizzi_vendors v[\s\S]*v\.business_id = p_business_id[\s\S]*v\.id = p_canonical_vendor_id/);
  assert.match(migration, /on conflict \(business_id, qbo_env, realm_id, canonical_vendor_id\)\s+where status = 'active'\s+do update set/i);
  assert.match(migration, /grant execute on function public\.upsert_active_qbo_vendor_mapping\(uuid, text, text, uuid, text, text, text, text, text, uuid, jsonb, timestamptz\) to service_role/);

  const vendorMigration = read("supabase/migrations/20260828_canonical_vendor_identity.sql");
  assert.match(vendorMigration, /business_qbo_vendor_mapping_vendor_active_uq[\s\S]*\(business_id, qbo_env, realm_id, canonical_vendor_id\)[\s\S]*where status = 'active'/);
  assert.match(vendorMigration, /business_qbo_vendor_mappings_business_vendor_fk[\s\S]*foreign key \(business_id, canonical_vendor_id\)[\s\S]*references public\.bizzi_vendors \(business_id, id\)/);
});

test("weak evidence and non-vendor transaction classes do not enter required vendor posting", () => {
  const service = read("src/services/bookkeeping/canonicalVendorService.js");
  assert.match(service, /export function getVendorPostingRequirement/);
  assert.match(service, /!\["Purchase", "CreditCardCharge"\]\.includes\(qboTxnType\)/);
  assert.match(service, /getVendorAutoCreateBlockReason/);
  assert.match(service, /merchant_entity_id \|\| bankTxn\.merchant_name \|\| bankTxn\.counterparty_name/);
});

test("minimal canonical vendor review APIs are tenant scoped and verify QBO Vendor decisions", () => {
  const route = read("src/api/bookkeeping/routes/bookkeeping.qboVendors.routes.js");
  const service = read("src/services/bookkeeping/canonicalVendorService.js");
  assert.match(route, /router\.get\("\/qbo\/canonical-vendors", requireAuth/);
  assert.match(route, /ensureBusinessId/);
  assert.match(route, /useExistingQboVendorForCanonical/);
  assert.match(route, /createQboVendorForCanonicalReview/);
  assert.match(service, /requireCanonicalVendorForBusiness/);
  assert.match(service, /\.eq\("business_id", businessId\)[\s\S]*\.eq\("id", canonicalVendorId\)/);
  assert.match(service, /selected\.type !== "vendor" \|\| selected\.active === false/);
  assert.match(service, /manual_existing_vendor_selected/);
  assert.match(service, /reconsiderVendorBlockedTransactions/);
});

test("canonical vendor migration has DB-backed business-scoped foreign keys", () => {
  const migration = read("supabase/migrations/20260828_canonical_vendor_identity.sql");
  assert.match(migration, /bizzi_vendors_business_id_id_uq unique \(business_id, id\)/);
  assert.match(migration, /cross_business_qbo_vendor_mappings_detected/);
  assert.match(migration, /business_qbo_vendor_mappings_business_vendor_fk[\s\S]*foreign key \(business_id, canonical_vendor_id\)[\s\S]*references public\.bizzi_vendors \(business_id, id\)/);
  assert.match(migration, /vendor_aliases_business_vendor_fk[\s\S]*foreign key \(business_id, canonical_vendor_id\)[\s\S]*references public\.bizzi_vendors \(business_id, id\)/);
  assert.match(migration, /qbo_vendor_creation_intents_business_vendor_fk[\s\S]*foreign key \(business_id, canonical_vendor_id\)[\s\S]*references public\.bizzi_vendors \(business_id, id\)/);
  assert.match(migration, /vendor_mapping_events_business_vendor_fk[\s\S]*foreign key \(business_id, canonical_vendor_id\)[\s\S]*references public\.bizzi_vendors \(business_id, id\)/);
  assert.match(migration, /bank_transactions_business_canonical_vendor_fk[\s\S]*foreign key \(business_id, canonical_vendor_id\)[\s\S]*references public\.bizzi_vendors \(business_id, id\)/);
});

test("Rules and Monthly Review show canonical Vendor Activity rather than only legacy receipts", () => {
  const rules = read("src/pages/accounting/Rules.jsx");
  const monthlyRoute = read("src/api/admin/monthlyReview.routes.js");
  const monthlyUi = read("src/pages/Admin/MonthlyReviewConsole.jsx");

  assert.match(rules, /getCanonicalQboVendors/);
  assert.match(rules, /Vendor Activity/);
  assert.match(rules, /useExistingCanonicalQboVendor/);
  assert.doesNotMatch(rules, /getQboVendorCreations\(businessId/);

  assert.match(monthlyRoute, /router\.use\(requireInternalAdmin\)/);
  assert.match(monthlyRoute, /canonical_vendors: canonicalVendors/);
  assert.match(monthlyRoute, /canonical-vendors\/:canonicalVendorId\/use-existing/);
  assert.match(monthlyUi, /CanonicalVendorReviewPanel/);
  assert.match(monthlyUi, /Vendor Activity/);
});
