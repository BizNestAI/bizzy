import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyTaxBackfillPreviewRow,
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
