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

function summariesFor(rows) {
  return new Map(rows.map((row, index) => [String(row.transaction_id), {
    transactionId: String(row.transaction_id), date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    description: `Authoritative transaction ${index + 1}`, merchantName: `Merchant ${index + 1}`, counterpartyName: null,
    signedAmount: Number(row.book_amount), qboAccountId: row.source_qbo_account_id,
    qboAccountName: row.source_qbo_account_name || "Meals", taxCategory: row.tax_category,
    classificationStatus: row.classification_status, requiresReview: row.requires_review,
  }]));
}

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

test("frontend preview URL exactly matches the mounted canonical backend route", () => {
  const client = readFileSync("src/services/tax/taxApiClient.js", "utf8");
  const route = readFileSync("src/api/tax/taxClassificationReview.routes.js", "utf8");
  const taxRouter = readFileSync("src/api/tax/index.js", "utf8");
  const server = readFileSync("src/server.js", "utf8");
  assert.match(client, /request\(`\/api\/tax\/deduction-decisions\/preview\?/);
  assert.match(client, /method: "POST"/);
  assert.match(route, /router\.post\("\/deduction-decisions\/preview"/);
  assert.match(taxRouter, /router\.use\("\/", taxClassificationReviewRouter\)/);
  assert.match(server, /app\.use\("\/api\/tax"[^\n]*taxRouter\)/);
  assert.ok(server.indexOf('app.use("/api/tax"') < server.indexOf("Not found:"), "Tax router must precede the application 404 handler");
});

test("preview response carries a bounded deployment contract and canonical scope identity", () => {
  const preview = previewTestables.customerPreview({
    id: "preview-1",
    business_id: "business-1",
    tax_year: 2026,
    group_id: "decision:meals",
    decision_type: "business_use_confirmation",
    expires_at: "2026-10-23T12:05:00.000Z",
  }, [{ ...BASE }], summariesFor([BASE]));
  assert.equal(preview.previewVersion, "tax-grouped-decision-preview-v1");
  assert.equal(preview.canonicalBusinessId, "business-1");
  assert.equal(preview.taxYear, 2026);
  assert.equal(preview.groupId, "decision:meals");
  assert.equal(preview.actionableCount, 1);
});

test("question preview serializes real authoritative transaction summaries instead of placeholders", () => {
  const preview = previewTestables.customerPreview({
    id: "preview-phone",
    business_id: "business-1",
    tax_year: 2026,
    group_id: "decision:phone",
    decision_type: "business_use_percent",
    expires_at: "2026-10-23T12:05:00.000Z",
  }, [{ ...BASE, transaction_id: "phone-1", book_amount: 41.17 }], new Map([["phone-1", {
    transactionId: "phone-1",
    date: "2026-07-14",
    description: "Monthly wireless service",
    merchantName: "Real Wireless",
    counterpartyName: null,
    signedAmount: 41.17,
    qboAccountId: "qbo-phone",
    qboAccountName: "Phone Bill",
    taxCategory: "utilities_phone",
    classificationStatus: "needs_review",
    requiresReview: true,
  }]]));
  assert.deepEqual(preview.transactions[0], {
    transactionId: "phone-1",
    date: "2026-07-14",
    description: "Monthly wireless service",
    merchantName: "Real Wireless",
    counterpartyName: null,
    signedAmount: 41.17,
    qboAccountId: "qbo-phone",
    qboAccountName: "Phone Bill",
    taxCategory: "utilities_phone",
    classificationStatus: "needs_review",
    requiresReview: true,
  });
  assert.equal(preview.grossAmountCents, 4117);
});

test("preview identity and population merge equivalent classifier rule versions", () => {
  const v3 = { ...BASE, transaction_id: "txn-v3", rule_version: "bizzi-gl-2026-v3" };
  const v4 = { ...BASE, transaction_id: "txn-v4", rule_version: "bizzi-gl-2026-v4" };
  const groupId = previewTestables.decisionIdentity({ businessId: "business-1", taxYear: 2026, row: v3 });
  assert.equal(groupId, previewTestables.decisionIdentity({ businessId: "business-1", taxYear: 2026, row: v4 }));
  const preview = previewTestables.customerPreview({ id: "preview-merged", business_id: "business-1", tax_year: 2026, group_id: groupId, decision_type: "business_use_confirmation", expires_at: "2026-10-23T12:05:00.000Z" }, [v3, v4], summariesFor([v3, v4]));
  assert.equal(preview.totalGroupCount, 2);
  assert.equal(preview.actionableCount, 2);
  assert.equal(preview.transactions.length, 2);
});

test("incomplete question hydration fails closed rather than emitting placeholder rows", () => {
  assert.throws(() => previewTestables.customerPreview({
    id: "preview-incomplete", business_id: "business-1", tax_year: 2026, group_id: "decision:meals",
    decision_type: "business_use_confirmation", expires_at: "2026-10-23T12:05:00.000Z",
  }, [BASE], new Map()), (error) => error.code === "grouped_decision_preview_hydration_incomplete");
});

for (const [label, decisionType, count] of [
  ["Phone Bill", "business_use_percent", 5],
  ["Electric", "business_use_percent", 4],
  ["Utilities", "business_use_percent", 2],
  ["Gas", "vehicle_method", 61],
  ["Meals", "business_use_confirmation", 171],
  ["Parking", "business_use_confirmation", 61],
  ["Lyft/Uber", "business_use_confirmation", 8],
  ["Transportation", "business_use_confirmation", 3],
]) test(`${label} preview exposes a complete unique signed actionable population`, () => {
  const rows = Array.from({ length: count }, (_, index) => ({
    ...BASE,
    transaction_id: `${label.toLowerCase().replace(/\W+/g, "-")}-${index}`,
    book_amount: index === 0 ? -2.5 : 10 + index / 100,
  }));
  const preview = previewTestables.customerPreview({
    id: `preview-${label}`, business_id: "business-1", tax_year: 2026, group_id: `decision:${label}`,
    decision_type: decisionType, expires_at: "2026-10-23T12:05:00.000Z",
  }, rows, summariesFor(rows));
  assert.equal(preview.transactions.length, count);
  assert.equal(new Set(preview.transactions.map((row) => row.transactionId)).size, count);
  assert.equal(preview.transactions.reduce((sum, row) => sum + Math.round(row.signedAmount * 100), 0), preview.grossAmountCents);
  assert.ok(preview.transactions.every((row) => row.date !== "2026-12-31" && row.merchantName && row.signedAmount !== 0));
});

test("reviewed and protected members stay out of the actionable transaction summaries", () => {
  const actionable = { ...BASE, transaction_id: "actionable" };
  const protectedRow = { ...BASE, transaction_id: "protected", classification_status: "user_confirmed", requires_review: false, user_override: true };
  const preview = previewTestables.customerPreview({
    id: "preview-authority", business_id: "business-1", tax_year: 2026, group_id: "decision:authority",
    decision_type: "business_use_confirmation", expires_at: "2026-10-23T12:05:00.000Z",
  }, [actionable, protectedRow], summariesFor([actionable]));
  assert.equal(preview.totalGroupCount, 2);
  assert.equal(preview.actionableCount, 1);
  assert.deepEqual(preview.transactions.map((row) => row.transactionId), ["actionable"]);
});

test("technical preview failure cannot be converted to resolved zero-population UI", () => {
  const dashboard = readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /setPreviewState\("preview_error"\)/);
  assert.match(dashboard, /previewError\?\.code === "grouped_decision_group_not_found"/);
  assert.match(dashboard, /preview\.actionableCount === 0 \? "preview_resolved" : "preview_ready"/);
  assert.match(dashboard, /previewState === "preview_ready"[^\n]*serverPreview\.actionableCount > 0/);
  assert.match(dashboard, /We couldn’t load this question\. No changes were made\./);
  assert.doesNotMatch(dashboard, /setServerPreview\(\{[^}]*actionableCount:\s*0/);
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
  assert.match(client, /compact\(\{ previewId, answer, vehicleMethod, actualExpenseUse, businessUsePercent, personalExceptionIds \}\)/);
  assert.doesNotMatch(client, /confirmGroupedTaxDeductionDecision[\s\S]{0,500}(targetTransactionIds|scopeFingerprint|grossAmountCents)/);
  assert.match(route, /canonicalMutationBusinessId/);
  assert.match(route, /tenantContext\?\.mode === "admin_view"/);
  assert.match(route, /changedFields: Array\.isArray/);
});
