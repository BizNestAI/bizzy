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
  assert.match(cron, /vendor_provider_unknown/);
  assert.match(cron, /vendor_create_pending/);
  assert.match(cron, /vendor_mapping_invalid/);
  assert.match(cron, /function markVendorPostingBlocked/);
  assert.match(cron, /status: outcome\.review \? "needs_review" : item\.status/);
  assert.match(cron, /vendor_review_canonical_vendor_id/);
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
