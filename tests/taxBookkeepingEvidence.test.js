import test from "node:test";
import assert from "node:assert/strict";
import { buildTaxProfessionalReadinessPackage, buildTaxTransactionsNeedingReviewPackage, classifyPermittedTaxSignal } from "../src/services/evidence/taxBookkeepingEvidence.js";

const persist = async ({ packageRow }) => packageRow;

test("tax review package includes only durable bounded categories and no receipt claims", async () => {
  const result = await buildTaxTransactionsNeedingReviewPackage({ db: {}, businessId: "biz", taxYear: 2026, persist, loaders: {
    bookkeeping: async () => ({ count: 2, references: [{ transaction_id: "b1", signal: "bookkeeping_needs_review" }] }),
    tax: async () => ({ count: 3, by_category: { owner_or_personal: 1, meals_or_travel: 1, capital_asset: 1, other: 0 }, references: [
      { transaction_id: "t1", signal: "owner_or_personal" }, { transaction_id: "t2", signal: "meals_or_travel" }, { transaction_id: "t3", signal: "capital_asset" },
    ] }),
  } });
  assert.equal(result.metrics.counts.needs_review_bookkeeping, 2);
  assert.equal(result.metrics.bounded_references.length, 4);
  assert.doesNotMatch(JSON.stringify(result), /receipt|document completeness/i);
  assert.match(result.warnings[0], /does not identify missing deductions/i);
});

test("stored tax flags map only to permitted review categories", () => {
  assert.equal(classifyPermittedTaxSignal({ tax_category: "owner_distribution" }), "owner_or_personal");
  assert.equal(classifyPermittedTaxSignal({ tax_category: "business_meals", requires_review: true }), "meals_or_travel");
  assert.equal(classifyPermittedTaxSignal({ tax_category: "equipment", deductibility_status: "capitalizable" }), "capital_asset");
  assert.equal(classifyPermittedTaxSignal({ tax_category: "unclassified" }), "other");
});

test("readiness has three deterministic states and never makes tax compliance claims", async () => {
  const complete = (blocker = 0) => ({ available: true, blocker_count: blocker });
  const base = Object.fromEntries(["needs_review", "pending", "reconciliation", "connections", "posting", "categorization", "pnl", "tax_review"].map((key) => [key, complete()]));
  const clear = await buildTaxProfessionalReadinessPackage({ db: {}, businessId: "biz", taxYear: 2026, persist, loaders: { readiness: async () => base } });
  assert.equal(clear.metrics.status, "no_known_bookkeeping_blockers");
  const blocked = await buildTaxProfessionalReadinessPackage({ db: {}, businessId: "biz", taxYear: 2026, persist, loaders: { readiness: async () => ({ ...base, needs_review: complete(2) }) } });
  assert.equal(blocked.metrics.status, "bookkeeping_attention_required");
  const unavailable = await buildTaxProfessionalReadinessPackage({ db: {}, businessId: "biz", taxYear: 2026, persist, loaders: { readiness: async () => ({ ...base, reconciliation: { available: false, blocker_count: 0 } }) } });
  assert.equal(unavailable.metrics.status, "readiness_unavailable");
  assert.doesNotMatch(JSON.stringify([clear, blocked, unavailable]), /ready to file|tax-law compliant|no deductions are missing/i);
});

