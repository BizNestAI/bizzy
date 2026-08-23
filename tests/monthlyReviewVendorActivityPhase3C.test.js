import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("Monthly Review Vendor Activity is split into exception and audit queues", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");

  assert.match(route, /needs_attention: needsAttention/);
  assert.match(route, /created_this_month: createdThisMonth/);
  assert.match(route, /mapped_existing: mappedExisting/);
  assert.match(ui, /Needs Attention/);
  assert.match(ui, /Created This Month/);
  assert.match(ui, /Mapped to Existing/);
  assert.match(ui, /No vendor exceptions need accountant attention/);
});

test("Vendor Activity treats routine created and mapped vendors as audit-only", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const closeGuard = read("src/api/admin/monthlyReviewCloseGuard.js");

  assert.match(route, /routine created\/mapped vendors are audit-only/);
  assert.match(route, /only needs_review vendor rows represent accountant attention/);
  assert.doesNotMatch(closeGuard, /canonical_vendors|vendor/i);
});

test("Vendor Activity uses selected-month timestamps where available", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const service = read("src/services/bookkeeping/canonicalVendorService.js");

  assert.match(route, /buildCanonicalVendorEvidence\(businessId, month\)/);
  assert.match(route, /isMonthTimestamp\(row\.activity_at \|\| row\.created_at \|\| row\.mapped_at \|\| row\.updated_at, month\)/);
  assert.match(route, /isMonthTimestamp\(row\.activity_at \|\| row\.mapped_at \|\| row\.updated_at, month\)/);
  assert.match(service, /activity_at:/);
  assert.match(service, /created_at:/);
  assert.match(service, /mapped_at:/);
});

test("Vendor aliases and evidence are visible without exposing raw ids as labels", () => {
  const service = read("src/services/bookkeeping/canonicalVendorService.js");
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");

  assert.match(service, /alias_value,normalized_alias_value/);
  assert.match(service, /aliases: vendorAliases/);
  assert.match(ui, /Aliases:/);
  assert.match(ui, /row\.aliases\.join\(", "\)/);
  assert.match(ui, /row\.display_name/);
  assert.match(ui, /row\.qbo_display_name/);
});

test("Vendor exception states remain narrow and actionable", () => {
  const service = read("src/services/bookkeeping/canonicalVendorService.js");
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");

  assert.match(service, /conflict_detected/);
  assert.match(service, /creation_unknown/);
  assert.match(service, /creation_failed/);
  assert.match(service, /status === "needs_review"/);
  assert.match(ui, /row\.review_reason \|\| row\.exception_type/);
});

test("Vendor duplicate safety and tenant isolation remain in the service layer", () => {
  const service = read("src/services/bookkeeping/canonicalVendorService.js");
  const vendorTest = read("tests/vendorOperationalFlowPhase2.test.js");
  const identityTest = read("tests/canonicalVendorIdentity.test.js");

  assert.match(service, /findActiveMapping/);
  assert.match(service, /refreshQboVendorNameList/);
  assert.match(service, /classifyQboNameMatch/);
  assert.match(service, /claim_qbo_vendor_creation_intent/);
  assert.match(service, /upsert_active_qbo_vendor_mapping/);
  assert.match(service, /\.eq\("business_id", businessId\)/);
  assert.match(vendorTest, /business-scoped foreign keys/);
  assert.match(identityTest, /create one canonical vendor/);
});

test("Phase 3C leaves Operator Responses COA and P&L phase behavior intact", () => {
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const route = read("src/api/admin/monthlyReview.routes.js");

  assert.match(ui, /Operator Responses/);
  assert.match(ui, /CanonicalCoaReviewPanel/);
  assert.match(ui, /SourceLedgerPanel/);
  assert.match(ui, /expandedAccountKeys/);
  assert.match(route, /approveBookkeepingTransactions/);
  assert.match(route, /approveExistingQboAccountForCanonical/);
  assert.match(route, /createPreferredQboAccountForCanonical/);
});
