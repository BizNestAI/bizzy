import test from "node:test";
import assert from "node:assert/strict";
import { buildReconciliationReadinessSignal, buildTaxProfessionalReadinessPackage, buildTaxTransactionsNeedingReviewPackage, classifyPermittedTaxSignal, loadTaxReview } from "../src/services/evidence/taxBookkeepingEvidence.js";

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
  assert.equal(result.metrics.reconciliation.tax_category_total, 3);
  assert.equal(result.metrics.reconciliation.categories_reconciled, true);
  assert.doesNotMatch(JSON.stringify(result), /receipt|document completeness/i);
  assert.match(result.warnings[0], /does not identify missing deductions/i);
});

test("tax review loads and reconciles the complete eligible population across pages", async () => {
  const classifications = Array.from({ length: 67 }, (_, index) => ({
    business_id: "biz-a", tax_year: 2026, transaction_id: `txn-${String(index).padStart(3, "0")}`, transaction_date: `2026-10-${String((index % 20) + 1).padStart(2, "0")}`,
    tax_category: index < 40 ? "business_meals" : "unclassified", classification_status: "needs_review", requires_review: true,
    reason: index < 40 ? "Confirm the business purpose" : "Confirm the tax treatment", confidence_score: index / 100, rule_priority: 32, metadata: index < 40 ? { business_purpose_required: true } : {},
  }));
  classifications.push({ ...classifications[0], business_id: "biz-b", transaction_id: "other-tenant" });
  const transactions = classifications.map((row, index) => ({
    id: row.transaction_id, business_id: row.business_id, date: row.transaction_date, merchant_name: `Merchant ${index}`, signed_amount: -(index + 1),
    iso_currency_code: "USD", pending: false, is_archived: false, archived_at: null,
  }));
  const db = makeReadDb({ transaction_tax_classifications: classifications, bank_transactions: transactions });
  const result = await loadTaxReview({ db, businessId: "biz-a", taxYear: 2026, pageSize: 11 });
  assert.equal(result.count, 67);
  assert.deepEqual(result.by_category, { owner_or_personal: 0, meals_or_travel: 40, capital_asset: 0, other: 27 });
  assert.equal(result.transaction_ids.length, 67);
  assert.equal(result.examples.length, 10);
  assert.ok(db.ranges.filter((entry) => entry.table === "transaction_tax_classifications").length > 1);
  assert.ok(result.examples.every((row) => row.currency === "USD" && row.status === "needs_review" && row.merchant));
  assert.ok(result.transaction_ids.every((id) => id !== "other-tenant"));
});

test("tax review excludes pending, archived, resolved, confirmed, and auto-classified transactions", async () => {
  const base = { business_id: "biz", transaction_date: "2026-10-10", tax_category: "unclassified", tax_year: 2026, requires_review: true, reason: "Review", confidence_score: 0.5, metadata: {} };
  const classifications = [
    { ...base, transaction_id: "eligible", classification_status: "needs_review" },
    { ...base, transaction_id: "pending", classification_status: "needs_review" },
    { ...base, transaction_id: "archived", classification_status: "needs_review" },
    { ...base, transaction_id: "resolved", classification_status: "user_confirmed", requires_review: false },
    { ...base, transaction_id: "automatic", classification_status: "auto_classified", requires_review: false },
  ];
  const transaction = (id, extra = {}) => ({ id, business_id: "biz", date: "2026-10-10", name: id, amount: 10, iso_currency_code: "USD", pending: false, is_archived: false, archived_at: null, ...extra });
  const db = makeReadDb({ transaction_tax_classifications: classifications, bank_transactions: [transaction("eligible"), transaction("pending", { pending: true }), transaction("archived", { is_archived: true }), transaction("resolved"), transaction("automatic")] });
  const result = await loadTaxReview({ db, businessId: "biz", taxYear: 2026, pageSize: 2 });
  assert.equal(result.count, 1);
  assert.deepEqual(result.excluded, { pending: 1, archived: 1, missing_transaction: 0 });
  assert.deepEqual(result.transaction_ids, ["eligible"]);
});

test("duplicate unresolved classification identities fail closed", async () => {
  const duplicate = { business_id: "biz", transaction_id: "txn", transaction_date: "2026-10-10", tax_category: "unclassified", tax_year: 2026, classification_status: "needs_review", requires_review: true, reason: "Review", metadata: {} };
  const db = makeReadDb({ transaction_tax_classifications: [duplicate, { ...duplicate }], bank_transactions: [] });
  await assert.rejects(() => loadTaxReview({ db, businessId: "biz", taxYear: 2026, pageSize: 10 }), (error) => error.code === "duplicate_tax_review_classification");
});

test("inconsistent unresolved status fails closed instead of silently changing the count", async () => {
  const inconsistent = { business_id: "biz", transaction_id: "txn", transaction_date: "2026-10-10", tax_category: "unclassified", tax_year: 2026, classification_status: "needs_review", requires_review: false, reason: "Review", metadata: {} };
  const db = makeReadDb({ transaction_tax_classifications: [inconsistent], bank_transactions: [] });
  await assert.rejects(() => loadTaxReview({ db, businessId: "biz", taxYear: 2026 }), (error) => error.code === "inconsistent_tax_review_status");
});

test("actionable examples use deterministic signals, confidence, materiality, recency, and stable identity ordering", async () => {
  const classification = (id, confidence, reason, metadata = {}, date = "2026-10-10") => ({ business_id: "biz", transaction_id: id, transaction_date: date, tax_category: "unclassified", tax_year: 2026, classification_status: "needs_review", requires_review: true, reason, confidence_score: confidence, metadata });
  const classifications = [
    classification("ordinary", 0.1, "Review"),
    classification("signaled-high-confidence", 0.9, "Confirm purpose", { business_purpose_required: true }),
    classification("signaled-low-confidence", 0.2, "Confirm purpose", { business_purpose_required: true }),
  ];
  const transactions = [
    { id: "ordinary", business_id: "biz", date: "2026-10-10", name: "Ordinary", signed_amount: -1000, iso_currency_code: "USD", pending: false, is_archived: false },
    { id: "signaled-high-confidence", business_id: "biz", date: "2026-10-10", name: "High confidence", signed_amount: -1000, iso_currency_code: "USD", pending: false, is_archived: false },
    { id: "signaled-low-confidence", business_id: "biz", date: "2026-10-10", name: "Low confidence", signed_amount: -1, iso_currency_code: "USD", pending: false, is_archived: false },
  ];
  const result = await loadTaxReview({ db: makeReadDb({ transaction_tax_classifications: classifications, bank_transactions: transactions }), businessId: "biz", taxYear: 2026 });
  assert.deepEqual(result.examples.map((row) => row.transaction_id), ["signaled-low-confidence", "signaled-high-confidence", "ordinary"]);
});

test("package keeps tax and bookkeeping populations separate and deduplicates the combined total", async () => {
  const result = await buildTaxTransactionsNeedingReviewPackage({ db: {}, businessId: "biz", taxYear: 2026, persist, loaders: {
    bookkeeping: async () => ({ count: 2, transaction_ids: ["shared", "book-only"], references: [{ transaction_id: "shared", signal: "bookkeeping_needs_review" }] }),
    tax: async () => ({ count: 3, transaction_ids: ["shared", "tax-2", "tax-3"], by_category: { owner_or_personal: 0, meals_or_travel: 1, capital_asset: 0, other: 2 }, references: [], examples: [] }),
  } });
  assert.equal(result.metrics.counts.tax_classifications_needing_review, 3);
  assert.equal(result.metrics.counts.needs_review_bookkeeping, 2);
  assert.equal(result.metrics.counts.tax_bookkeeping_overlap, 1);
  assert.equal(result.metrics.counts.combined_distinct_needing_review, 4);
  assert.equal(result.metrics.reconciliation.tax_category_total, 3);
  assert.equal(result.formula_version, "tax-bookkeeping-evidence-v2");
});

test("missing transaction details are not fabricated and are excluded from actionable totals", async () => {
  const row = { business_id: "biz", transaction_id: "missing", transaction_date: "2026-10-10", tax_category: "unclassified", tax_year: 2026, classification_status: "needs_review", requires_review: true, reason: "Review", metadata: {} };
  const result = await loadTaxReview({ db: makeReadDb({ transaction_tax_classifications: [row], bank_transactions: [] }), businessId: "biz", taxYear: 2026 });
  assert.equal(result.count, 0);
  assert.equal(result.excluded.missing_transaction, 1);
  assert.deepEqual(result.examples, []);
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
  assert.equal(blocked.completeness, "complete");
  assert.equal(blocked.metrics.blocker_populations.bookkeeping_review, 2);
  assert.equal("blocker_count" in blocked.metrics, false);
  const unavailable = await buildTaxProfessionalReadinessPackage({ db: {}, businessId: "biz", taxYear: 2026, persist, loaders: { readiness: async () => ({ ...base, reconciliation: { available: false, blocker_count: 0 } }) } });
  assert.equal(unavailable.metrics.status, "readiness_unavailable");
  assert.deepEqual(unavailable.metrics.unavailable_sources, ["reconciliation"]);
  assert.doesNotMatch(JSON.stringify([clear, blocked, unavailable]), /ready to file|tax-law compliant|no deductions are missing/i);
});

test("missing reconciliation run is available blocker evidence rather than an outage", () => {
  const signal = buildReconciliationReadinessSignal({ status: "fulfilled", value: null });
  assert.deepEqual(signal, {
    available: true,
    blocker_count: 1,
    status: "not_completed",
    unavailable_reason: null,
    latest: null,
    verified_scope: null,
  });
});

test("failed, OK, and non-OK reconciliation queries remain distinct", () => {
  const failed = buildReconciliationReadinessSignal({ status: "rejected", reason: new Error("database unavailable") });
  assert.equal(failed.available, false);
  assert.equal(failed.blocker_count, 0);
  assert.equal(failed.unavailable_reason, "reconciliation_query_failed");

  const ok = buildReconciliationReadinessSignal({ status: "fulfilled", value: { status: "ok", period_start: "2026-09-01", period_end: "2026-09-30" } });
  assert.equal(ok.available, true);
  assert.equal(ok.blocker_count, 0);
  assert.equal(ok.status, "verified_for_recorded_scope");
  assert.deepEqual(ok.verified_scope, { period_start: "2026-09-01", period_end: "2026-09-30", accounts: "limited_to_reconciliation_run_scope" });

  const issue = buildReconciliationReadinessSignal({ status: "fulfilled", value: { status: "attention_required", period_start: "2026-09-01", period_end: "2026-09-30" } });
  assert.equal(issue.available, true);
  assert.equal(issue.blocker_count, 1);
  assert.equal(issue.status, "issue_present");
});

test("Cash evidence plus missing reconciliation produces a complete blocked readiness package", async () => {
  const complete = (blocker = 0) => ({ available: true, blocker_count: blocker });
  const signals = Object.fromEntries(["needs_review", "pending", "connections", "posting", "categorization", "pnl", "tax_review"].map((key) => [key, complete()]));
  signals.pnl = { available: true, blocker_count: 0, evidence_id: "cash-pnl" };
  signals.reconciliation = buildReconciliationReadinessSignal({ status: "fulfilled", value: null });
  const result = await buildTaxProfessionalReadinessPackage({ db: {}, businessId: "biz", taxYear: 2026, persist, loaders: { readiness: async () => signals } });
  assert.equal(result.completeness, "complete");
  assert.equal(result.metrics.status, "bookkeeping_attention_required");
  assert.equal(result.metrics.readiness_dimensions.reconciliation, "not_completed");
  assert.equal(result.metrics.readiness_dimensions.financial_evidence_available, true);
  assert.deepEqual(result.metrics.unavailable_sources, []);
});

test("readiness keeps overlapping blocker populations separate instead of summing them", async () => {
  const complete = (blocker = 0) => ({ available: true, blocker_count: blocker });
  const signals = {
    needs_review: complete(4), pending: complete(4), reconciliation: { ...complete(1), status: "not_completed" },
    connections: complete(0), posting: complete(2), categorization: complete(6), pnl: complete(0), tax_review: complete(12),
  };
  const result = await buildTaxProfessionalReadinessPackage({ db: {}, businessId: "biz", taxYear: 2026, persist, loaders: { readiness: async () => signals } });
  assert.deepEqual(result.metrics.blocker_populations, {
    tax_classification_review: 12,
    bookkeeping_review: 4,
    pending_or_accounting_review: 4,
    posting_errors: 2,
    bookkeeping_feed_review_or_pending: 6,
  });
  assert.equal("blocker_count" in result.metrics, false);
});

function makeReadDb(store) {
  const ranges = [];
  return {
    ranges,
    from(table) {
      const state = { table, filters: [], ids: null, from: 0, to: Number.MAX_SAFE_INTEGER, count: null };
      const query = {
        select(_columns, options = {}) { state.count = options.count || null; return query; },
        eq(column, value) { state.filters.push([column, value]); return query; },
        in(column, values) { state.ids = [column, new Set(values)]; return query; },
        order() { return query; },
        range(from, to) { state.from = from; state.to = to; ranges.push({ table, from, to }); return query; },
        then(resolve, reject) {
          try {
            let rows = [...(store[table] || [])].filter((row) => state.filters.every(([column, value]) => row[column] === value));
            if (state.ids) rows = rows.filter((row) => state.ids[1].has(row[state.ids[0]]));
            rows.sort((left, right) => String(left.transaction_id || left.id).localeCompare(String(right.transaction_id || right.id)));
            const count = rows.length;
            resolve({ data: rows.slice(state.from, state.to + 1), error: null, count: state.count ? count : null });
          } catch (error) { reject(error); }
        },
      };
      return query;
    },
  };
}
