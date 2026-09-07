import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyTaxBackfillPreviewRow,
  previewTaxClassificationBackfill,
  summarizeTaxClassificationBackfillPreviewRows,
} from "../src/services/tax/taxClassificationBackfillPreview.service.js";

test("classification backfill preview auto-classifies only deterministic mapped categories", () => {
  const software = classifyTaxBackfillPreviewRow({ transactionId: "txn-software", qboAccountName: "Software", absoluteAmount: 120 });
  const fees = classifyTaxBackfillPreviewRow({ transactionId: "txn-fees", qboAccountName: "Payment processing fees", absoluteAmount: 30 });

  assert.equal(software.bucket, "estimatedAutomaticClassifications");
  assert.equal(software.taxCategory, "software");
  assert.equal(software.deductiblePercent, 100);
  assert.equal(fees.taxCategory, "payment_processing_fees");
});

test("classification backfill preview keeps substantiation-sensitive categories in review", () => {
  const meals = classifyTaxBackfillPreviewRow({ transactionId: "txn-meals", qboAccountName: "Meals", absoluteAmount: 75 });
  const gas = classifyTaxBackfillPreviewRow({ transactionId: "txn-gas", qboAccountName: "Gas", absoluteAmount: 55 });
  const equipment = classifyTaxBackfillPreviewRow({ transactionId: "txn-asset", qboAccountName: "Equipment", absoluteAmount: 1400 });

  assert.equal(meals.bucket, "estimatedReviewRequired");
  assert.equal(meals.deductibilityStatus, "needs_review");
  assert.equal(gas.taxCategory, "vehicle");
  assert.equal(equipment.taxCategory, "equipment_asset");
});

test("classification backfill preview excludes duplicate and balance-sheet representations", () => {
  const transfer = classifyTaxBackfillPreviewRow({ transactionId: "txn-transfer", qboAccountName: "Transfer", absoluteAmount: 500 });
  const cardPayment = classifyTaxBackfillPreviewRow({ transactionId: "txn-card", qboAccountName: "Credit Card Payment", absoluteAmount: 500 });
  const ownerDraw = classifyTaxBackfillPreviewRow({ transactionId: "txn-owner", qboAccountName: "Owner Draw", absoluteAmount: 1000 });

  assert.equal(transfer.bucket, "estimatedExclusions");
  assert.equal(cardPayment.deductibilityStatus, "excluded");
  assert.equal(ownerDraw.taxCategory, "excluded");
});

test("classification backfill preview summarizes warnings without creating authority", () => {
  const preview = summarizeTaxClassificationBackfillPreviewRows([
    { transactionId: "txn-1", qboAccountName: "Software", absoluteAmount: 100 },
    { transactionId: "txn-2", qboAccountName: "Meals", absoluteAmount: 50 },
    { transactionId: "txn-3", qboAccountName: "Credit Card Payment", absoluteAmount: 25 },
  ], { businessId: "business-1", taxYear: 2026 });

  assert.equal(preview.meta.readOnly, true);
  assert.equal(preview.counts.eligible, 3);
  assert.equal(preview.counts.estimatedAutomaticClassifications, 1);
  assert.equal(preview.counts.estimatedReviewRequired, 1);
  assert.equal(preview.counts.estimatedExclusions, 1);
  assert.ok(preview.warnings.some((warning) => warning.code === "meals_require_review"));
});

test("classification backfill preview targets unresolved fallback rows before missing evaluations", async () => {
  const supabase = memorySupabase({
    transaction_tax_classifications: [
      {
        id: "classification-fallback",
        business_id: "business-1",
        transaction_id: "txn-fallback",
        tax_year: 2026,
        transaction_date: "2026-03-01",
        classification_status: "needs_review",
        tax_category: "unclassified",
        deductibility_status: "needs_review",
        deductible_percent: 0,
        book_amount: -120,
        deductible_amount: 0,
        nondeductible_amount: 120,
        capitalizable_amount: 0,
        tax_treatment: { type: "unclassified" },
        metadata: { fallback: true, source_qbo_account_name: "Software" },
      },
      {
        id: "classification-reviewed",
        business_id: "business-1",
        transaction_id: "txn-reviewed",
        tax_year: 2026,
        transaction_date: "2026-03-02",
        classification_status: "user_confirmed",
        tax_category: "software",
        deductibility_status: "fully_deductible",
        deductible_percent: 100,
        book_amount: -80,
        deductible_amount: 80,
        nondeductible_amount: 0,
        capitalizable_amount: 0,
        tax_treatment: { type: "ordinary_business_expense" },
        metadata: { source_qbo_account_name: "Software" },
      },
    ],
    bank_transactions: [
      {
        id: "txn-never-evaluated",
        business_id: "business-1",
        date: "2026-03-03",
        amount: -50,
        source_type: "qbo",
        is_posted: true,
      },
    ],
  });

  const preview = await previewTaxClassificationBackfill({
    supabase,
    businessId: "business-1",
    taxYear: 2026,
  });

  assert.equal(preview.meta.readOnly, true);
  assert.equal(preview.meta.target, "unresolved_fallback_rows");
  assert.equal(preview.counts.previewed, 1);
  assert.equal(preview.counts.estimatedAutomaticClassifications, 1);
  assert.equal(preview.totalsByGlAccount[0].key, "Software");
});

function memorySupabase(tables = {}) {
  return {
    from(table) {
      let rows = [...(tables[table] || [])];
      const api = {
        select() { return api; },
        eq(column, value) {
          rows = rows.filter((row) => row[column] === value);
          return api;
        },
        order() { return api; },
        range(from, to) {
          rows = rows.slice(from, to + 1);
          return api;
        },
        then(resolve) {
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return api;
    },
  };
}
