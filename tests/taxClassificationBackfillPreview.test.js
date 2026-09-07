import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyTaxBackfillPreviewRow,
  previewTaxClassificationBackfill,
  summarizeTaxClassificationBackfillPreviewRows,
} from "../src/services/tax/taxClassificationBackfillPreview.service.js";

test("classification backfill preview auto-classifies only deterministic mapped categories", () => {
  const rules = [
    rule({ rule_code: "software_gl", tax_category: "software", match_conditions: { qbo_account_name_keys: ["software"] } }),
    rule({ rule_code: "fees_gl", tax_category: "payment_processing_fees", match_conditions: { qbo_account_name_keys: ["payment processing fees"] } }),
  ];
  const software = classifyTaxBackfillPreviewRow({ transactionId: "txn-software", qboAccountName: "Software", absoluteAmount: 120 }, { rules, businessId: "business-1" });
  const fees = classifyTaxBackfillPreviewRow({ transactionId: "txn-fees", qboAccountName: "Payment processing fees", absoluteAmount: 30 }, { rules, businessId: "business-1" });

  assert.equal(software.bucket, "estimatedAutomaticClassifications");
  assert.equal(software.taxCategory, "software");
  assert.equal(software.deductiblePercent, 100);
  assert.equal(fees.taxCategory, "payment_processing_fees");
});

test("classification backfill preview keeps substantiation-sensitive categories in review", () => {
  const rules = [
    rule({ rule_code: "meals_gl_review", tax_category: "meals", deductibility_status: "partially_deductible", default_deductible_percent: 50, requires_review: true, match_conditions: { qbo_account_name_keys: ["meals"] } }),
    rule({ rule_code: "gas_gl_review", tax_category: "vehicle", deductibility_status: "needs_review", default_deductible_percent: 0, requires_review: true, match_conditions: { qbo_account_name_keys: ["gas"] } }),
    rule({ rule_code: "equipment_gl_review", tax_category: "equipment_asset", deductibility_status: "needs_review", default_deductible_percent: 0, requires_review: true, match_conditions: { qbo_account_name_keys: ["equipment"] } }),
  ];
  const meals = classifyTaxBackfillPreviewRow({ transactionId: "txn-meals", qboAccountName: "Meals", absoluteAmount: 75 }, { rules, businessId: "business-1" });
  const gas = classifyTaxBackfillPreviewRow({ transactionId: "txn-gas", qboAccountName: "Gas", absoluteAmount: 55 }, { rules, businessId: "business-1" });
  const equipment = classifyTaxBackfillPreviewRow({ transactionId: "txn-asset", qboAccountName: "Equipment", absoluteAmount: 1400 }, { rules, businessId: "business-1" });

  assert.equal(meals.bucket, "estimatedReviewRequired");
  assert.equal(meals.deductibilityStatus, "partially_deductible");
  assert.equal(meals.deductiblePercent, 50);
  assert.equal(gas.taxCategory, "vehicle");
  assert.equal(gas.deductibilityStatus, "needs_review");
  assert.equal(equipment.taxCategory, "equipment_asset");
});

test("classification backfill preview excludes duplicate and balance-sheet representations", () => {
  const rules = [
    rule({ rule_code: "transfer_exclusion", tax_category: "excluded", deductibility_status: "balance_sheet", default_deductible_percent: 0, match_conditions: { qbo_account_name_keys: ["transfer"] } }),
    rule({ rule_code: "card_payment_exclusion", tax_category: "excluded", deductibility_status: "balance_sheet", default_deductible_percent: 0, match_conditions: { qbo_account_name_keys: ["credit card payment"] } }),
    rule({ rule_code: "owner_draw_exclusion", tax_category: "excluded", deductibility_status: "balance_sheet", default_deductible_percent: 0, match_conditions: { qbo_account_name_keys: ["owner draw"] } }),
  ];
  const transfer = classifyTaxBackfillPreviewRow({ transactionId: "txn-transfer", qboAccountName: "Transfer", absoluteAmount: 500 }, { rules, businessId: "business-1" });
  const cardPayment = classifyTaxBackfillPreviewRow({ transactionId: "txn-card", qboAccountName: "Credit Card Payment", absoluteAmount: 500 }, { rules, businessId: "business-1" });
  const ownerDraw = classifyTaxBackfillPreviewRow({ transactionId: "txn-owner", qboAccountName: "Owner Draw", absoluteAmount: 1000 }, { rules, businessId: "business-1" });

  assert.equal(transfer.bucket, "estimatedExclusions");
  assert.equal(cardPayment.deductibilityStatus, "balance_sheet");
  assert.equal(ownerDraw.taxCategory, "excluded");
});

test("classification backfill preview summarizes warnings without creating authority", () => {
  const preview = summarizeTaxClassificationBackfillPreviewRows([
    { transactionId: "txn-1", qboAccountName: "Software", absoluteAmount: 100 },
    { transactionId: "txn-2", qboAccountName: "Meals", absoluteAmount: 50 },
    { transactionId: "txn-3", qboAccountName: "Credit Card Payment", absoluteAmount: 25 },
  ], {
    businessId: "business-1",
    taxYear: 2026,
    rules: [
      rule({ rule_code: "software_gl", tax_category: "software", match_conditions: { qbo_account_name_keys: ["software"] } }),
      rule({ rule_code: "meals_gl_review", tax_category: "meals", deductibility_status: "partially_deductible", default_deductible_percent: 50, requires_review: true, match_conditions: { qbo_account_name_keys: ["meals"] } }),
      rule({ rule_code: "card_payment_exclusion", tax_category: "excluded", deductibility_status: "balance_sheet", default_deductible_percent: 0, match_conditions: { qbo_account_name_keys: ["credit card payment"] } }),
    ],
  });

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
    tax_deduction_rules: [
      rule({ rule_code: "software_gl", tax_category: "software", match_conditions: { qbo_account_name_keys: ["software"] } }),
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

test("classification backfill preview keeps unmatched rows unresolved when approved rules are unavailable", () => {
  const preview = summarizeTaxClassificationBackfillPreviewRows([
    { transactionId: "txn-1", qboAccountName: "Software", absoluteAmount: 100 },
  ], { businessId: "business-1", taxYear: 2026, rules: [] });

  assert.equal(preview.counts.estimatedAutomaticClassifications, 0);
  assert.equal(preview.counts.estimatedReviewRequired, 0);
  assert.equal(preview.counts.unresolved, 1);
  assert.equal(preview.warnings[0].code, "unmapped_requires_approved_rules");
});

function rule(overrides = {}) {
  return {
    id: overrides.id || overrides.rule_code || "rule",
    business_id: overrides.business_id ?? null,
    scope: overrides.scope || "global",
    rule_code: overrides.rule_code || "rule",
    tax_year: overrides.tax_year || 2026,
    jurisdiction: overrides.jurisdiction || "federal",
    entity_type: overrides.entity_type ?? null,
    bookkeeping_category: overrides.bookkeeping_category ?? null,
    qbo_account_type: overrides.qbo_account_type ?? null,
    qbo_account_subtype: overrides.qbo_account_subtype ?? null,
    match_conditions: overrides.match_conditions || {},
    tax_category: overrides.tax_category || "software",
    deductibility_status: overrides.deductibility_status || "fully_deductible",
    default_deductible_percent: overrides.default_deductible_percent ?? 100,
    treatment: overrides.treatment || { type: "ordinary_expense" },
    requires_review: overrides.requires_review === true,
    priority: overrides.priority ?? 10,
    explanation: overrides.explanation || "Test rule.",
    source_reference: overrides.source_reference || "Accountant approved test source",
    source_url: overrides.source_url || "https://www.irs.gov/publications/p334",
    verified_at: overrides.verified_at || "2026-01-01T00:00:00.000Z",
    effective_from: overrides.effective_from || "2026-01-01",
    effective_to: overrides.effective_to || "2026-12-31",
    is_active: overrides.is_active ?? true,
    version: overrides.version || "test-v1",
  };
}

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
