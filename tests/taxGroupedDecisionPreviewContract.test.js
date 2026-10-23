import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildGroupedDecisionManifest, compareGroupedDecisionManifests, fingerprintGroupedDecisionManifest } from "../src/services/tax/taxGroupedDecisionManifest.js";
import { confirmGroupedDecisionPreview, createGroupedDecisionPreview, __testables as previewTestables } from "../src/services/tax/taxGroupedDecisionPreview.service.js";

const BASE = {
  transaction_id: "txn-1", business_id: "business-1", tax_year: 2026, book_amount: -41.17,
  source_qbo_account_id: "qbo-meals", tax_category: "business_meals",
  tax_treatment: { type: "business_meals_needs_confirmation" }, deductibility_status: "partially_deductible",
  deductible_percent: 50, classification_status: "needs_review", requires_review: true,
  user_override: false, cpa_override: false, source: "rule_engine", rule_version: "meals-v1",
  metadata: { customer_facts: { business_purpose: null }, classified_at: "old", classification_run_id: "run-1" },
};

test("server semantic manifest is deterministic and ignores operational ordering/timestamps", () => {
  const first = buildGroupedDecisionManifest({ businessId: "business-1", taxYear: 2026, rows: [BASE, { ...BASE, transaction_id: "txn-2" }] });
  const second = buildGroupedDecisionManifest({ businessId: "business-1", taxYear: 2026, rows: [{ ...BASE, transaction_id: "txn-2", metadata: { ...BASE.metadata, classified_at: "new", classification_run_id: "run-2" } }, BASE] });
  assert.equal(fingerprintGroupedDecisionManifest(first), fingerprintGroupedDecisionManifest(second));
  assert.equal(compareGroupedDecisionManifests(first, second), null);
});

for (const [name, patch, code] of [
  ["amount", { book_amount: -42 }, "scope_amount_changed"],
  ["account", { source_qbo_account_id: "qbo-other" }, "scope_account_changed"],
  ["treatment", { deductible_percent: 25 }, "scope_treatment_changed"],
  ["authority", { user_override: true, classification_status: "user_confirmed", requires_review: false }, "protected_authority_changed"],
  ["customer facts", { metadata: { ...BASE.metadata, customer_facts: { business_purpose: "changed" } } }, "customer_facts_changed"],
  ["rule version", { rule_version: "meals-v2" }, "rule_version_changed"],
]) test(`semantic manifest reports ${name} conflicts`, () => {
  const previous = buildGroupedDecisionManifest({ businessId: "business-1", taxYear: 2026, rows: [BASE] });
  const current = buildGroupedDecisionManifest({ businessId: "business-1", taxYear: 2026, rows: [{ ...BASE, ...patch }] });
  assert.equal(compareGroupedDecisionManifests(previous, current)?.code, code);
});

test("membership changes have their own bounded code", () => {
  const previous = buildGroupedDecisionManifest({ businessId: "business-1", taxYear: 2026, rows: [BASE] });
  const current = buildGroupedDecisionManifest({ businessId: "business-1", taxYear: 2026, rows: [BASE, { ...BASE, transaction_id: "txn-2" }] });
  assert.deepEqual(compareGroupedDecisionManifests(previous, current), { code: "scope_membership_changed", changedFields: ["transactionId"], addedCount: 1, removedCount: 0 });
});

test("browser uses opaque server preview and no longer constructs an authoritative fingerprint", () => {
  const dashboard = readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.doesNotMatch(dashboard, /buildGroupedDeductionDecisionFingerprint/);
  assert.match(dashboard, /previewGroupedDeductionDecision/);
  assert.match(dashboard, /previewId: serverPreview\.previewId/);
  assert.doesNotMatch(dashboard, /scopeFingerprint:/);
});

test("preview persistence is service-role-only, short-lived, and atomic confirmation locks semantics", () => {
  const sql = readFileSync("supabase/migrations/20261103130000_grouped_tax_decision_previews.sql", "utf8");
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /force row level security/i);
  assert.match(sql, /revoke all on table[\s\S]*public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update, delete[\s\S]*service_role/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /apply_grouped_tax_deduction_decision\(/i);
  assert.match(sql, /preview_expired/);
  assert.match(sql, /scope_amount_changed/);
  assert.doesNotMatch(sql, /(quickbooks|plaid|openai)/i);
});

test("preview confirmation payload identity is deterministic and changes with the answer", () => {
  const first = previewTestables.fingerprintConfirmation({ answer: "some_personal", personalExceptionIds: ["b", "a"] });
  const reordered = previewTestables.fingerprintConfirmation({ answer: "some_personal", personalExceptionIds: ["a", "b", "a"] });
  const changed = previewTestables.fingerprintConfirmation({ answer: "all_business", personalExceptionIds: [] });
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});

test("customer ownership and expiry are rejected before classifications or writes", async () => {
  const basePreview = {
    id: "00000000-0000-4000-8000-000000000001",
    business_id: "00000000-0000-4000-8000-000000000010",
    tax_year: 2026,
    actor_user_id: "00000000-0000-4000-8000-000000000020",
    expires_at: "2026-10-23T12:00:00.000Z",
  };
  const supabaseFor = (preview) => ({
    from(table) {
      assert.equal(table, "tax_grouped_deduction_decision_previews");
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: preview, error: null }) };
      return chain;
    },
  });
  await assert.rejects(
    () => confirmGroupedDecisionPreview({ supabase: supabaseFor(basePreview), businessId: basePreview.business_id, taxYear: 2026, input: { previewId: basePreview.id }, actor: { userId: "00000000-0000-4000-8000-000000000099", source: "user" } }),
    (error) => error.code === "business_access_denied",
  );
  await assert.rejects(
    () => confirmGroupedDecisionPreview({ supabase: supabaseFor(basePreview), businessId: basePreview.business_id, taxYear: 2026, input: { previewId: basePreview.id }, actor: { userId: basePreview.actor_user_id, source: "user" }, now: new Date("2026-10-23T12:00:01.000Z") }),
    (error) => error.code === "preview_expired",
  );
  await assert.rejects(
    () => createGroupedDecisionPreview({ supabase: {}, businessId: basePreview.business_id, taxYear: 2026, groupId: "group", actor: { userId: basePreview.actor_user_id, source: "admin", tenantMode: "admin_view" } }),
    (error) => error.code === "business_access_denied",
  );
});

test("browser confirmation cannot submit authoritative IDs, counts, amounts, authority, or treatment", () => {
  const client = readFileSync("src/services/tax/taxApiClient.js", "utf8");
  const route = readFileSync("src/api/tax/taxClassificationReview.routes.js", "utf8");
  assert.match(client, /compact\(\{ previewId, answer, businessUsePercent, personalExceptionIds \}\)/);
  assert.doesNotMatch(client, /confirmGroupedTaxDeductionDecision[\s\S]{0,500}(targetTransactionIds|scopeFingerprint|grossAmountCents)/);
  assert.match(route, /canonicalMutationBusinessId/);
  assert.match(route, /tenantContext\?\.mode === "admin_view"/);
  assert.match(route, /changedFields: Array\.isArray/);
});
