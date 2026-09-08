import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyNormalizedTransaction, classifyPostedTransaction } from "../src/services/tax/taxClassificationEngine.js";
import { neutralizeTaxClassificationForTransaction } from "../src/services/tax/taxClassification.repository.js";
import { evaluateDeductionRules } from "../src/services/tax/taxDeductionRule.repository.js";
import { repairUnresolvedFallbackClassifications } from "../src/services/tax/taxClassificationFallbackRepair.service.js";
import { buildTaxGlAliasDeductionRules, TAX_GL_ALIAS_RULES } from "../src/services/tax/taxGlAliasRules.js";
import { normalizeQboGlAccountKey } from "../src/services/tax/taxQboGlNormalizer.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const MIGRATION_PATH = "supabase/migrations/20261001_tax_classification_gl_alias_rules_v3.sql";
const PREFLIGHT_PATH = "scripts/tax/gl_alias_v3_preflight.sql";
const V4_MIGRATION_PATH = "supabase/migrations/20261002_tax_classification_gl_alias_rules_v4_reconciliation.sql";
const V4_PREFLIGHT_PATH = "scripts/tax/gl_alias_v4_preflight.sql";
const V4_POST_VERIFY_PATH = "scripts/tax/gl_alias_v4_post_migration_verification.sql";

test("every approved GL alias normalizes and matches its intended v3 rule", () => {
  const rules = buildTaxGlAliasDeductionRules();
  for (const group of TAX_GL_ALIAS_RULES) {
    for (const alias of group.aliases) {
      const evaluation = evaluateDeductionRules({
        rules,
        businessId: BUSINESS_ID,
        transactionContext: {
          qbo_account_name: alias,
          normalized_qbo_account_name: normalizeQboGlAccountKey(alias),
          direction: "OUTFLOW",
          date: "2026-08-15",
        },
      });
      assert.equal(evaluation.selected?.rule_code, group.rule_code, alias);
      assert.equal(evaluation.selected?.tax_category, group.tax_category, alias);
    }
  }
});

test("GL alias matching is exact normalized membership and avoids unsafe substrings", () => {
  const rules = buildTaxGlAliasDeductionRules();
  assertNoMatch(rules, "Insurance Reimbursement");
  assertNoMatch(rules, "Accumulated Depreciation");

  const cardPayment = classifySync("Credit Card Payment", rules);
  assert.equal(cardPayment.taxCategory, "transfer");
  assert.equal(cardPayment.ruleCode, "transfer_credit_card_payment_exclusion_gl_v3");
});

test("canonical GL rules produce expected amounts and review states", async () => {
  const rules = buildTaxGlAliasDeductionRules();
  const software = await classify("Software", -100, rules);
  assert.equal(software.taxCategory, "software_subscriptions");
  assert.equal(software.classificationStatus, "auto_classified");
  assert.equal(software.deductiblePercent, 100);
  assert.equal(software.deductibleAmount, 100);

  const meals = await classify("Meals", -53, rules);
  assert.equal(meals.taxCategory, "business_meals");
  assert.equal(meals.classificationStatus, "needs_review");
  assert.equal(meals.deductiblePercent, 50);
  assert.equal(meals.deductibleAmount, 26.5);

  const fuel = await classify("Gas", -44, rules);
  assert.equal(fuel.taxCategory, "vehicle_expense");
  assert.equal(fuel.classificationStatus, "needs_review");
  assert.equal(fuel.deductibleAmount, 0);

  const ownerDraw = await classify("Owner Draw", -200, rules);
  assert.equal(ownerDraw.taxCategory, "owner_activity");
  assert.equal(ownerDraw.classificationStatus, "excluded");
  assert.equal(ownerDraw.deductibleAmount, 0);

  const asset = await classify("Equipment Purchase", -3000, rules);
  assert.equal(asset.taxCategory, "fixed_asset_capitalizable");
  assert.equal(asset.classificationStatus, "needs_review");
  assert.equal(asset.deductibleAmount, 0);
  assert.equal(asset.capitalizableAmount, 3000);

  const supplies = await classify("Supplies", -18.49, rules);
  assert.equal(supplies.taxCategory, "supplies");
  assert.equal(supplies.classificationStatus, "needs_review");
  assert.equal(supplies.deductiblePercent, 100);
  assert.equal(supplies.deductibleAmount, 18.49);
  assert.match(supplies.reason, /Confirm whether these are office supplies, job supplies, or materials/);

  const loanPayment = await classify("Loan Payment", -500, rules);
  assert.equal(loanPayment.taxCategory, "debt_payment");
  assert.equal(loanPayment.classificationStatus, "needs_review");
  assert.equal(loanPayment.deductiblePercent, 0);
  assert.equal(loanPayment.deductibleAmount, 0);
  assert.match(loanPayment.reason, /Separate principal from potentially deductible interest/);

  const unknown = await classify("Mystery Expense", -25, rules);
  assert.equal(unknown.taxCategory, "unclassified");
});

test("business GL alias override beats global and equal precedence conflicts are review-required", async () => {
  const globalRules = buildTaxGlAliasDeductionRules();
  const businessRule = {
    ...globalRules[0],
    id: "business-software",
    business_id: BUSINESS_ID,
    scope: "business_override",
    rule_code: "business_software_override",
    tax_category: "office_supplies",
  };
  const override = await classify("Software", -100, [globalRules[0], businessRule]);
  assert.equal(override.ruleCode, "business_software_override");
  assert.equal(override.taxCategory, "office_supplies");

  const conflict = await classify("Software", -100, [
    { ...globalRules[0], id: "conflict-a", rule_code: "conflict_a", priority: 5, tax_category: "software_subscriptions" },
    { ...globalRules[0], id: "conflict-b", rule_code: "conflict_b", priority: 5, tax_category: "office_supplies" },
  ]);
  assert.equal(conflict.taxCategory, "rule_conflict");
  assert.equal(conflict.classificationStatus, "needs_review");
});

test("unresolved fallback repair targets only fallback rows and is idempotent", async () => {
  const supabase = makeSupabase(baseStore());
  supabase.store.bank_transactions.push(bankTxn("txn-review-fallback", "Gas", -44));
  supabase.store.transaction_categorizations.push(categorization("txn-review-fallback", "Gas"));
  supabase.store.qbo_posted_transactions.push(qboPosted("txn-review-fallback"));
  supabase.store.transaction_tax_classifications.push(fallbackClassification("txn-review-fallback", "Gas", -44));
  const first = await repairUnresolvedFallbackClassifications({ supabase, businessId: BUSINESS_ID, taxYear: 2026, limit: 10 });
  assert.equal(first.targetCount, 2);
  assert.equal(first.calculated, 1);
  assert.equal(first.meaningfulNeedsReview, 1);
  assert.equal(first.preserved, 0);
  assert.equal(first.proposedDeductibleAmount, 100);
  const calculated = supabase.store.transaction_tax_classifications.find((row) => row.transaction_id === "txn-fallback");
  const review = supabase.store.transaction_tax_classifications.find((row) => row.transaction_id === "txn-review-fallback");
  assert.equal(calculated.tax_category, "software_subscriptions");
  assert.equal(calculated.classification_status, "auto_classified");
  assert.equal(calculated.source, "rule_engine");
  assert.equal(calculated.user_override, false);
  assert.equal(calculated.cpa_override, false);
  assert.equal(review.tax_category, "vehicle_expense");
  assert.equal(review.classification_status, "needs_review");
  assert.equal(review.requires_review, true);
  assert.equal(review.source, "rule_engine");
  assert.equal(review.user_override, false);
  assert.equal(review.cpa_override, false);
  assert.equal(supabase.store.transaction_tax_classifications.find((row) => row.transaction_id === "txn-confirmed").tax_category, "business_meals");
  assert.equal(supabase.store.tax_classification_overrides.length, 2);
  assert.deepEqual(new Set(supabase.store.tax_classification_overrides.map((row) => row.override_source)), new Set(["system_repair"]));

  const second = await repairUnresolvedFallbackClassifications({ supabase, businessId: BUSINESS_ID, taxYear: 2026, limit: 10 });
  assert.equal(second.targetCount, 0);
  assert.equal(supabase.store.tax_classification_overrides.length, 2);
});

test("repair RPC rejects missing rule identity for meaningful outcomes", () => {
  const store = baseStore();
  const baseParams = repairParams({
    classificationStatus: "auto_classified",
    taxCategory: "software_subscriptions",
    ruleId: "software_subscriptions_gl_v3",
    ruleCode: "software_subscriptions_gl_v3",
    ruleVersion: "bizzi-gl-2026-v3",
  });

  assert.equal(applyRepairRpc(store, { ...baseParams, p_rule_id: null }).error?.message, "invalid_tax_classification_repair_rule_identity");
  assert.equal(applyRepairRpc(store, { ...baseParams, p_rule_code: null }).error?.message, "invalid_tax_classification_repair_rule_identity");
  assert.equal(applyRepairRpc(store, { ...baseParams, p_rule_version: null }).error?.message, "invalid_tax_classification_repair_rule_identity");

  const reviewMissingRule = applyRepairRpc(store, repairParams({
    classificationStatus: "needs_review",
    taxCategory: "vehicle_expense",
    ruleId: null,
    ruleCode: "vehicle_fuel_review_gl_v3",
    ruleVersion: "bizzi-gl-2026-v3",
  }));
  assert.equal(reviewMissingRule.error?.message, "invalid_tax_classification_repair_rule_identity");

  const blankCategory = applyRepairRpc(store, repairParams({
    classificationStatus: "needs_review",
    taxCategory: " ",
    ruleId: "vehicle_fuel_review_gl_v3",
    ruleCode: "vehicle_fuel_review_gl_v3",
    ruleVersion: "bizzi-gl-2026-v3",
  }));
  assert.equal(blankCategory.error?.message, "invalid_tax_classification_repair_tax_category");

  const unclassified = applyRepairRpc(store, repairParams({
    classificationStatus: "needs_review",
    taxCategory: "unclassified",
    ruleId: "vehicle_fuel_review_gl_v3",
    ruleCode: "vehicle_fuel_review_gl_v3",
    ruleVersion: "bizzi-gl-2026-v3",
  }));
  assert.equal(unclassified.error?.message, "invalid_tax_classification_repair_unresolved_fallback");

  const reviewSuccess = applyRepairRpc(store, repairParams({
    classificationStatus: "needs_review",
    taxCategory: "vehicle_expense",
    ruleId: "vehicle_fuel_review_gl_v3",
    ruleCode: "vehicle_fuel_review_gl_v3",
    ruleVersion: "bizzi-gl-2026-v3",
  }));
  assert.equal(reviewSuccess.error, null);
  assert.equal(reviewSuccess.data.tax_category, "vehicle_expense");
  assert.equal(reviewSuccess.data.classification_status, "needs_review");

  const excludedStore = baseStore();
  const excluded = applyRepairRpc(excludedStore, repairParams({
    classificationStatus: "excluded",
    taxCategory: "transfer",
    ruleId: null,
    ruleCode: null,
    ruleVersion: null,
  }));
  assert.equal(excluded.error, null);
  assert.equal(excluded.data.classification_status, "excluded");
});

test("future QBO-posted transaction classifies automatically through posted source hydration", async () => {
  const supabase = makeSupabase(baseStore({ classifications: [] }));
  const out = await classifyPostedTransaction({ supabase, businessId: BUSINESS_ID, taxYear: 2026, transactionId: "txn-fallback" });
  assert.equal(out.result.taxCategory, "software_subscriptions");
  assert.equal(out.result.metadata.normalized_qbo_account_name, "software");
});

test("v3 rule inventory has no duplicate aliases and ambiguous aliases resolve deliberately", () => {
  const rules = buildTaxGlAliasDeductionRules();
  assert.equal(rules.length, 41);
  const aliasOwners = new Map();
  for (const rule of rules) {
    assert.equal(rule.version, "bizzi-gl-2026-v3");
    assert.equal(rule.is_active, true);
    assert.ok(rule.verified_at);
    for (const alias of rule.match_conditions.qbo_account_name_keys) {
      aliasOwners.set(alias, [...(aliasOwners.get(alias) || []), rule.rule_code]);
    }
  }
  const duplicates = [...aliasOwners.entries()].filter(([, owners]) => owners.length > 1);
  assert.deepEqual(duplicates, []);

  const expected = new Map([
    ["Tools", "tools_small_equipment_review_gl_v3"],
    ["Small Equipment", "tools_small_equipment_review_gl_v3"],
    ["Supplies", "generic_supplies_review_gl_v3"],
    ["Professional Fees", "professional_services_review_gl_v3"],
    ["Rent", "generic_rent_review_gl_v3"],
    ["Utilities", "mixed_utilities_review_gl_v3"],
    ["Auto Expense", "vehicle_fuel_review_gl_v3"],
    ["Machinery", "fixed_asset_capitalizable_gl_v3"],
    ["Transportation", "parking_tolls_transportation_review_gl_v3"],
    ["Payroll", "payroll_wages_gl_v3"],
    ["Loan Payment", "generic_loan_payment_review_gl_v3"],
    ["Business Loan Payment", "generic_loan_payment_review_gl_v3"],
    ["Debt Payment", "generic_loan_payment_review_gl_v3"],
    ["Credit Card Fees", "payment_processing_fees_gl_v3"],
    ["Service Charges", "bank_service_fees_gl_v3"],
  ]);
  for (const [alias, ruleCode] of expected) {
    const evaluation = evaluateAlias(rules, alias);
    assert.equal(evaluation.conflict, null, alias);
    assert.equal(evaluation.selected?.rule_code || null, ruleCode, alias);
  }
});

test("production-shaped 207-row GL fixture classifies with shared v3 rules", async () => {
  const rules = buildTaxGlAliasDeductionRules();
  const fixture = [
    ["meals", 106, 2432.57],
    ["gas", 30, 497.90],
    ["parking", 25, 81.13],
    ["equipment rental", 17, 834.38],
    ["lyft uber", 10, 99.29],
    ["insurance", 5, 1119.11],
    ["software", 5, 225.08],
    ["electric", 4, 292.04],
    ["phone bill", 3, 165.56],
    ["supplies", 1, 18.49],
    ["transportation", 1, 3.64],
  ];
  const summary = emptyFixtureSummary();
  const groups = new Map();
  for (const [accountName, count, gross] of fixture) {
    const amounts = splitAmounts(gross, count);
    for (let i = 0; i < amounts.length; i += 1) {
      const result = await classify(accountName, -amounts[i], rules);
      addFixtureResult(summary, groups, accountName, amounts[i], result);
    }
  }
  assert.equal(summary.totalCount, 207);
  assert.equal(summary.calculated.count, 27);
  assert.equal(summary.calculated.gross, 2178.57);
  assert.equal(summary.calculated.deductible, 2178.57);
  assert.equal(summary.meaningfulNeedsReview.count, 180);
  assert.equal(summary.meaningfulNeedsReview.gross, 3590.62);
  assert.equal(summary.meaningfulNeedsReview.proposedDeductible, 1235.24);
  assert.equal(summary.unresolved.count, 0);
  assert.equal(summary.unresolved.gross, 0);
  assert.equal(summary.excluded.count, 0);
  assert.equal(summary.conflicts, 0);
  assert.equal(summary.failures, 0);

  assertGroup(groups, "meals", "business_meals_review_gl_v3", "business_meals", "needs_review", 106);
  assertGroup(groups, "gas", "vehicle_fuel_review_gl_v3", "vehicle_expense", "needs_review", 30);
  assertGroup(groups, "parking", "parking_tolls_transportation_review_gl_v3", "travel_transportation", "needs_review", 25);
  assertGroup(groups, "equipment rental", "equipment_rental_gl_v3", "equipment_rental", "auto_classified", 17);
  assertGroup(groups, "lyft uber", "parking_tolls_transportation_review_gl_v3", "travel_transportation", "needs_review", 10);
  assertGroup(groups, "insurance", "business_insurance_gl_v3", "business_insurance", "auto_classified", 5);
  assertGroup(groups, "software", "software_subscriptions_gl_v3", "software_subscriptions", "auto_classified", 5);
  assertGroup(groups, "electric", "mixed_utilities_review_gl_v3", "utilities", "needs_review", 4);
  assertGroup(groups, "phone bill", "mixed_utilities_review_gl_v3", "utilities", "needs_review", 3);
  assertGroup(groups, "supplies", "generic_supplies_review_gl_v3", "supplies", "needs_review", 1);
  assertGroup(groups, "transportation", "parking_tolls_transportation_review_gl_v3", "travel_transportation", "needs_review", 1);
});

test("amount signs, refunds, and neutralized reversals do not create artificial deductions", async () => {
  const rules = buildTaxGlAliasDeductionRules();
  const positiveExpense = await classify("Software", 100, rules);
  assert.equal(positiveExpense.deductibleAmount, 0);

  const negativeMeals = await classify("Meals", -53, rules);
  assert.equal(negativeMeals.deductibleAmount, 26.5);

  const positiveMealsRefund = await classify("Meals", 53, rules);
  assert.equal(positiveMealsRefund.deductibleAmount, 0);

  const zero = await classify("Software", 0, rules);
  assert.equal(zero.deductibleAmount, 0);

  const repairStore = baseStore({
    classifications: [
      {
        ...fallbackClassification("txn-fallback", "Software", -100),
        tax_category: "software_subscriptions",
        deductibility_status: "fully_deductible",
        deductible_percent: 100,
        deductible_amount: 100,
        classification_status: "auto_classified",
        rule_code: "software_subscriptions_gl_v3",
        rule_id: "software_subscriptions_gl_v3",
        metadata: { fallback: false, source_qbo_account_name: "Software", normalized_qbo_account_name: "software" },
      },
    ],
  });
  const supabase = makeSupabase(repairStore);
  const neutralized = await neutralizeTaxClassificationForTransaction({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    transactionId: "txn-fallback",
    reason: "qbo_transaction_reversed",
    now: new Date("2026-08-16T00:00:00Z"),
  });
  assert.equal(neutralized.changed, true);
  assert.equal(repairStore.transaction_tax_classifications[0].deductible_amount, 0);
  assert.equal(repairStore.tax_classification_overrides.length, 1);
  assert.equal(repairStore.tax_classification_overrides[0].override_source, "system_neutralize");
  assert.equal(repairStore.tax_classification_overrides[0].previous_values.deductible_amount, 100);
  assert.equal(repairStore.tax_classification_overrides[0].new_values.deductible_amount, 0);
});

test("v3 migration is typed, idempotent, and service-role-only for repair RPC", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  assert.match(sql, /'2026-09-08T00:00:00Z'::timestamptz/);
  assert.doesNotMatch(sql, /'2026-10-01T00:00:00Z'::timestamptz/);
  assert.doesNotMatch(sql, /create\s+temporary\s+table/i);
  assert.doesNotMatch(sql, /\bon\s+conflict\b/i);
  assert.match(sql, /verified_at::timestamptz/);
  assert.match(sql, /treatment::jsonb/);
  assert.match(sql, /default_deductible_percent::numeric/);
  assert.match(sql, /business_id::uuid/);
  assert.match(sql, /tax_year::integer/);
  assert.match(sql, /requires_review::boolean/);
  assert.match(sql, /effective_from::date/);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /set search_path = public/i);
  assert.match(sql, /p_classification_status in \('auto_classified', 'needs_review'\)[\s\S]*p_rule_id is null or p_rule_code is null or p_rule_version is null/);
  assert.match(sql, /grant execute on function public\.apply_tax_classification_repair[\s\S]*\) to service_role;/);
  assert.match(sql, /revoke all on function public\.apply_tax_classification_repair[\s\S]*\) from public;/);
  assert.match(sql, /revoke all on function public\.apply_tax_classification_repair[\s\S]*\) from anon;/);
  assert.match(sql, /revoke all on function public\.apply_tax_classification_repair[\s\S]*\) from authenticated;/);
  assert.doesNotMatch(sql, /grant execute on function public\.apply_tax_classification_repair[\s\S]*\) to authenticated/);
  assert.doesNotMatch(sql, /grant execute on function public\.apply_tax_classification_repair[\s\S]*\) to anon/);
  assert.match(sql, /grant execute on function public\.apply_tax_classification_neutralization[\s\S]*\) to service_role;/);
  assert.match(sql, /revoke all on function public\.apply_tax_classification_neutralization[\s\S]*\) from public;/);
  assert.match(sql, /revoke all on function public\.apply_tax_classification_neutralization[\s\S]*\) from anon;/);
  assert.match(sql, /revoke all on function public\.apply_tax_classification_neutralization[\s\S]*\) from authenticated;/);
  assert.doesNotMatch(sql, /grant execute on function public\.apply_tax_classification_neutralization[\s\S]*\) to authenticated/);
  assert.doesNotMatch(sql, /grant execute on function public\.apply_tax_classification_neutralization[\s\S]*\) to anon/);
});

test("v3 preflight is read-only, parse-portable, and verifies restored v2 content", () => {
  const sql = readFileSync(PREFLIGHT_PATH, "utf8");
  assert.doesNotMatch(sql, /^\s*(insert|update|delete|merge|create|alter|drop|grant|revoke|call|do)\b/im);
  assert.doesNotMatch(sql, /\bfrom\s+supabase_migrations\.schema_migrations\b/i);
  assert.doesNotMatch(sql, /\bjoin\s+supabase_migrations\.schema_migrations\b/i);
  assert.doesNotMatch(sql, /metadata\s*->>\s*'fallback'\s*\)::boolean/i);
  assert.match(sql, /cffc2183-e77c-4148-a206-d5192e090925/);
  assert.match(sql, /v2_compatibility_summary/);
  assert.match(sql, /v2_missing_expected_rows/);
  assert.match(sql, /v2_unexpected_additional_rows/);
  assert.match(sql, /v2_same_key_content_mismatches/);
  assert.match(sql, /v2_rows_differing_only_in_is_active/);
  assert.match(sql, /v2_rows_differing_only_in_timestamps/);
  assert.match(sql, /v2_materially_different_rule_rows/);
  assert.match(sql, /v2_dependency_rows_for_v3/);
  assert.match(sql, /v3_preexisting_rule_codes/);
  assert.match(sql, /target_business_classification_counts/);
  assert.match(sql, /target_business_eligible_posted_transactions/);
  assert.match(sql, /global_classification_counts/);
  assert.match(sql, /jsonb_build_object\('qbo_account_name_keys'/);
  assert.match(sql, /'2026-09-30T00:00:00Z'::timestamptz/);
  assert.match(sql, /lower\(btrim\(coalesce\(c\.metadata->>'fallback', ''\)\)\) in \('true', 't', '1', 'yes', 'y'\)/);
});

test("v4 reconciliation migration is forward-only and hardens repair RPC security", () => {
  const sql = readFileSync(V4_MIGRATION_PATH, "utf8");
  assert.match(sql, /tax_gl_alias_v4_v3_baseline_mismatch/);
  assert.match(sql, /v_expected_count <> 41/);
  assert.match(sql, /v_actual_count <> 41 or v_active_verified_count <> 41/);
  assert.match(sql, /expected_immutable_json is distinct from actual_immutable_json/);
  assert.doesNotMatch(sql, /\bmd5\s*\(/i);
  assert.doesNotMatch(sql, /aggregate_fingerprint/i);
  assert.match(sql, /update public\.tax_deduction_rules r[\s\S]*version = 'bizzi-gl-2026-v2'[\s\S]*exists \(/);
  assert.doesNotMatch(sql, /insert\s+into\s+public\.tax_deduction_rules/i);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.tax_deduction_rules/i);
  assert.doesNotMatch(sql, /insert\s+into\s+public\.transaction_tax_classifications/i);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.transaction_tax_classifications/i);
  assert.doesNotMatch(sql, /tax_recalc_queue|tax_classification_jobs|qbo_posted_transactions|plaid_/i);
  assert.match(sql, /create or replace function public\.apply_tax_classification_repair/);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /set search_path = public/i);
  assert.match(sql, /lower\(btrim\(coalesce\(v_current\.metadata->>'fallback', ''\)\)\) in \('true', 't', '1', 'yes', 'y'\)/);
  assert.match(sql, /revoke all on function public\.apply_tax_classification_repair[\s\S]*\) from public;/);
  assert.match(sql, /revoke all on function public\.apply_tax_classification_repair[\s\S]*\) from anon;/);
  assert.match(sql, /revoke all on function public\.apply_tax_classification_repair[\s\S]*\) from authenticated;/);
  assert.match(sql, /grant execute on function public\.apply_tax_classification_repair[\s\S]*\) to service_role;/);
});

test("v4 validation scripts are read-only and expose canonical v3 reconciliation checks", () => {
  for (const path of [V4_PREFLIGHT_PATH, V4_POST_VERIFY_PATH]) {
    const sql = readFileSync(path, "utf8");
    assert.doesNotMatch(sql, /^\s*(insert|update|delete|merge|create|alter|drop|grant|revoke|call|do)\b/im, path);
    assert.match(sql, /v3_canonical_comparison_summary/, path);
    assert.match(sql, /v3_rule_inventory/, path);
    assert.match(sql, /duplicate_active_aliases_with_deterministic_winner/, path);
    assert.match(sql, /equal_rank_alias_conflicts/, path);
    assert.match(sql, /repair_function_security/, path);
    assert.match(sql, /repair_function_grants/, path);
    assert.match(sql, /target_business_classification_counts/, path);
    assert.match(sql, /expected_immutable_json is distinct from actual_immutable_json/, path);
    assert.doesNotMatch(sql, /aggregate_fingerprint/i, path);
    assert.doesNotMatch(sql, /\bmd5\s*\(/i, path);
  }

  const preflightSql = readFileSync(V4_PREFLIGHT_PATH, "utf8");
  assert.doesNotMatch(
    preflightSql,
    /actual_v3_fingerprints\s+as\s*\(\s*select\s+rule_code\s*,\s*jsonb_build_object/i,
    "actual_v3_fingerprints must not project rule_code separately before a.*",
  );

  const postVerifySql = readFileSync(V4_POST_VERIFY_PATH, "utf8");
  assert.doesNotMatch(
    postVerifySql,
    /actual_v3_fingerprints\s+as\s*\(\s*select\s+rule_code\s*,\s*jsonb_build_object/i,
    "post-migration actual_v3_fingerprints must not project rule_code separately before a.*",
  );
});

test("v4 baseline validation does not use text fingerprints that can disagree on numeric scale", () => {
  const migrationSql = readFileSync(V4_MIGRATION_PATH, "utf8");
  const preflightSql = readFileSync(V4_PREFLIGHT_PATH, "utf8");
  const postVerifySql = readFileSync(V4_POST_VERIFY_PATH, "utf8");

  for (const sql of [migrationSql, preflightSql, postVerifySql]) {
    assert.match(sql, /default_deductible_percent\s+numeric/i);
    assert.match(sql, /expected_immutable_json is distinct from actual_immutable_json/);
    assert.doesNotMatch(sql, /jsonb_agg\(immutable_json[\s\S]*::text/i);
    assert.doesNotMatch(sql, /\bmd5\s*\(/i);
  }
});

function assertNoMatch(rules, accountName) {
  const evaluation = evaluateAlias(rules, accountName);
  assert.equal(evaluation.selected, null, accountName);
}

function evaluateAlias(rules, accountName) {
  return evaluateDeductionRules({
    rules,
    businessId: BUSINESS_ID,
    transactionContext: {
      qbo_account_name: accountName,
      normalized_qbo_account_name: normalizeQboGlAccountKey(accountName),
      direction: "OUTFLOW",
      date: "2026-08-15",
    },
  });
}

function classifySync(accountName, rules) {
  const evaluation = evaluateAlias(rules, accountName);
  const rule = evaluation.selected;
  return { ruleCode: rule?.rule_code || null, taxCategory: rule?.tax_category || "unclassified" };
}

function emptyFixtureSummary() {
  return {
    totalCount: 0,
    calculated: { count: 0, gross: 0, deductible: 0 },
    meaningfulNeedsReview: { count: 0, gross: 0, proposedDeductible: 0 },
    excluded: { count: 0, gross: 0 },
    unresolved: { count: 0, gross: 0 },
    conflicts: 0,
    failures: 0,
  };
}

function addFixtureResult(summary, groups, accountName, gross, result) {
  summary.totalCount += 1;
  const key = normalizeQboGlAccountKey(accountName);
  const group = groups.get(key) || {
    count: 0,
    gross: 0,
    ruleCode: result.ruleCode,
    taxCategory: result.taxCategory,
    classificationStatus: result.classificationStatus,
  };
  group.count += 1;
  group.gross = round2(group.gross + gross);
  group.ruleCode = result.ruleCode;
  group.taxCategory = result.taxCategory;
  group.classificationStatus = result.classificationStatus;
  groups.set(key, group);

  if (result.taxCategory === "rule_conflict") {
    summary.conflicts += 1;
  } else if (result.taxCategory === "unclassified") {
    summary.unresolved.count += 1;
    summary.unresolved.gross = round2(summary.unresolved.gross + gross);
  } else if (result.classificationStatus === "excluded") {
    summary.excluded.count += 1;
    summary.excluded.gross = round2(summary.excluded.gross + gross);
  } else if (result.classificationStatus === "needs_review") {
    summary.meaningfulNeedsReview.count += 1;
    summary.meaningfulNeedsReview.gross = round2(summary.meaningfulNeedsReview.gross + gross);
    summary.meaningfulNeedsReview.proposedDeductible = round2(summary.meaningfulNeedsReview.proposedDeductible + Number(result.deductibleAmount || 0));
  } else if (result.classificationStatus === "auto_classified") {
    summary.calculated.count += 1;
    summary.calculated.gross = round2(summary.calculated.gross + gross);
    summary.calculated.deductible = round2(summary.calculated.deductible + Number(result.deductibleAmount || 0));
  } else {
    summary.failures += 1;
  }
}

function assertGroup(groups, accountName, ruleCode, taxCategory, classificationStatus, count) {
  const group = groups.get(normalizeQboGlAccountKey(accountName));
  assert.equal(group?.ruleCode || null, ruleCode, accountName);
  assert.equal(group?.taxCategory || null, taxCategory, accountName);
  assert.equal(group?.classificationStatus || null, classificationStatus, accountName);
  assert.equal(group?.count || 0, count, accountName);
}

function splitAmounts(total, count) {
  const totalCents = Math.round(Number(total) * 100);
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => (base + (i < remainder ? 1 : 0)) / 100);
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function classify(accountName, signedAmount, rules) {
  return classifyNormalizedTransaction({
    supabase: makeSupabase(baseStore({ classifications: [] })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    transaction: transaction(accountName, signedAmount),
    profile: profile(),
    memories: [],
    rules,
  });
}

function transaction(accountName, signedAmount) {
  return {
    transactionId: "txn-1",
    businessId: BUSINESS_ID,
    transactionDate: "2026-08-15",
    description: `${accountName} vendor`,
    merchantName: `${accountName} vendor`,
    counterpartyName: `${accountName} vendor`,
    signedAmount,
    absoluteAmount: Math.abs(signedAmount),
    direction: signedAmount < 0 ? "OUTFLOW" : "INFLOW",
    qboAccountId: "acct-1",
    qboAccountName: accountName,
    normalizedQboAccountName: normalizeQboGlAccountKey(accountName),
    qboTxnId: "qbo-1",
    qboTxnType: "Purchase",
    sourceWarnings: [],
    sourceTruth: { bankTransaction: true, categorizationPosted: true, qboPostedRecord: true },
    rawRefs: { bankTransactionId: "txn-1" },
    metadata: { normalized_qbo_account_name: normalizeQboGlAccountKey(accountName) },
  };
}

function baseStore({ classifications } = {}) {
  return {
    business_profiles: [{ id: BUSINESS_ID, bookkeeping_start_date: null }],
    bank_transactions: [
      bankTxn("txn-fallback", "Software", -100),
      bankTxn("txn-confirmed", "Meals", -53),
      bankTxn("txn-other", "Software", -100, OTHER_BUSINESS_ID),
    ],
    transaction_categorizations: [
      categorization("txn-fallback", "Software"),
      categorization("txn-confirmed", "Meals"),
      categorization("txn-other", "Software", OTHER_BUSINESS_ID),
    ],
    qbo_posted_transactions: [
      qboPosted("txn-fallback"),
      qboPosted("txn-confirmed"),
      qboPosted("txn-other", OTHER_BUSINESS_ID),
    ],
    qbo_accounts_cache: [],
    transaction_tax_classifications: classifications ?? [
      fallbackClassification("txn-fallback", "Software", -100),
      {
        ...fallbackClassification("txn-confirmed", "Meals", -53),
        classification_status: "user_confirmed",
        tax_category: "business_meals",
        rule_code: "manual",
        user_override: true,
        metadata: { fallback: false, source_qbo_account_name: "Meals", normalized_qbo_account_name: "meals" },
      },
    ],
    tax_classification_overrides: [],
    tax_profiles: [profile()],
    tax_profile_memories: [],
    tax_deduction_rules: buildTaxGlAliasDeductionRules(),
  };
}

function bankTxn(id, accountName, signedAmount, businessId = BUSINESS_ID) {
  return {
    id,
    business_id: businessId,
    pending: false,
    date: "2026-08-15",
    name: `${accountName} vendor`,
    merchant_name: `${accountName} vendor`,
    counterparty_name: `${accountName} vendor`,
    amount: Math.abs(signedAmount),
    signed_amount: signedAmount,
    direction: signedAmount < 0 ? "OUTFLOW" : "INFLOW",
    is_archived: false,
    created_at: "2026-08-15T00:00:00Z",
  };
}

function categorization(transactionId, accountName, businessId = BUSINESS_ID) {
  return {
    id: `cat-${transactionId}`,
    business_id: businessId,
    transaction_id: transactionId,
    status: "posted",
    final_qbo_account_id: `acct-${transactionId}`,
    final_qbo_account_name: accountName,
    qbo_txn_id: `qbo-${transactionId}`,
    qbo_txn_type: "Purchase",
    posted_at: "2026-08-15T12:00:00Z",
    meta: { taxonomy_type: "ordinary_expense" },
    is_archived: false,
  };
}

function qboPosted(transactionId, businessId = BUSINESS_ID) {
  return {
    id: `qbo-row-${transactionId}`,
    business_id: businessId,
    transaction_id: transactionId,
    qbo_txn_type: "Purchase",
    qbo_txn_id: `qbo-${transactionId}`,
    status: "posted",
    posted_at: "2026-08-15T12:00:00Z",
  };
}

function fallbackClassification(transactionId, accountName, bookAmount) {
  return {
    id: `classification-${transactionId}`,
    business_id: BUSINESS_ID,
    transaction_id: transactionId,
    tax_year: 2026,
    transaction_date: "2026-08-15",
    tax_category: "unclassified",
    deductibility_status: "needs_review",
    deductible_percent: 0,
    book_amount: bookAmount,
    deductible_amount: 0,
    nondeductible_amount: 0,
    capitalizable_amount: 0,
    tax_treatment: { type: "unclassified" },
    classification_status: "needs_review",
    confidence_score: 20,
    confidence_level: "low",
    rule_id: null,
    rule_code: null,
    source: "rule_engine",
    requires_review: true,
    user_override: false,
    cpa_override: false,
    reason: "No reliable tax deduction rule matched this posted transaction.",
    metadata: { fallback: true, source_qbo_account_name: accountName, normalized_qbo_account_name: normalizeQboGlAccountKey(accountName) },
    created_at: "2026-08-15T12:00:00Z",
    updated_at: "2026-08-15T12:00:00Z",
  };
}

function profile() {
  return {
    id: "profile-1",
    business_id: BUSINESS_ID,
    tax_year: 2026,
    entity_type: "sole_proprietor",
    filing_status: "single",
    primary_tax_state: "NC",
    accounting_method: "cash",
    safe_harbor_method: "current_year_90",
    self_employment_tax_applies: true,
    profile_status: "active",
  };
}

function makeSupabase(store) {
  return {
    store,
    from(table) {
      store[table] ||= [];
      return new Query(table, store);
    },
    rpc(name, params) {
      if (name !== "apply_tax_classification_repair") return Promise.resolve({ data: null, error: { code: "rpc_not_found", message: "Unknown RPC" } });
      return Promise.resolve(applyRepairRpc(store, params));
    },
  };
}

function repairParams({
  classificationStatus,
  taxCategory,
  ruleId,
  ruleCode,
  ruleVersion,
}) {
  return {
    p_business_id: BUSINESS_ID,
    p_tax_year: 2026,
    p_transaction_id: "txn-fallback",
    p_actor_user_id: null,
    p_repair_reason: "test",
    p_expected_updated_at: null,
    p_rule_id: ruleId,
    p_rule_code: ruleCode,
    p_rule_version: ruleVersion,
    p_rule_priority: 10,
    p_tax_category: taxCategory,
    p_deductibility_status: classificationStatus === "excluded" ? "balance_sheet" : "fully_deductible",
    p_deductible_percent: classificationStatus === "excluded" ? 0 : 100,
    p_tax_treatment: {},
    p_classification_status: classificationStatus,
    p_metadata: { repaired: true },
    p_book_amount: -100,
    p_deductible_amount: classificationStatus === "excluded" ? 0 : 100,
    p_nondeductible_amount: 0,
    p_capitalizable_amount: 0,
    p_confidence_score: 1,
    p_confidence_level: "high",
    p_source: "rule_engine",
    p_requires_review: classificationStatus === "needs_review",
    p_reason: "test repair",
  };
}

function applyRepairRpc(store, params) {
  const rows = store.transaction_tax_classifications;
  const idx = rows.findIndex((row) =>
    row.business_id === params.p_business_id &&
    row.transaction_id === params.p_transaction_id &&
    row.tax_year === params.p_tax_year
  );
  if (idx < 0) return { data: null, error: { code: "P0002", message: "classification_not_found" } };
  if (!["auto_classified", "needs_review", "excluded"].includes(params.p_classification_status)) {
    return { data: null, error: { code: "P0001", message: "invalid_tax_classification_repair_status" } };
  }
  if (params.p_source !== "rule_engine") {
    return { data: null, error: { code: "P0001", message: "invalid_tax_classification_repair_source" } };
  }
  if (["auto_classified", "needs_review"].includes(params.p_classification_status) && String(params.p_tax_category || "").trim() === "") {
    return { data: null, error: { code: "P0001", message: "invalid_tax_classification_repair_tax_category" } };
  }
  if (params.p_classification_status === "needs_review" && String(params.p_tax_category || "").trim().toLowerCase() === "unclassified") {
    return { data: null, error: { code: "P0001", message: "invalid_tax_classification_repair_unresolved_fallback" } };
  }
  if (
    ["auto_classified", "needs_review"].includes(params.p_classification_status) &&
    (!params.p_rule_id || !params.p_rule_code || !params.p_rule_version)
  ) {
    return { data: null, error: { code: "P0001", message: "invalid_tax_classification_repair_rule_identity" } };
  }
  const current = rows[idx];
  const previous = snapshot(current);
  const updated = {
    ...current,
    tax_category: params.p_tax_category,
    deductibility_status: params.p_deductibility_status,
    deductible_percent: params.p_deductible_percent,
    book_amount: params.p_book_amount,
    deductible_amount: params.p_deductible_amount,
    nondeductible_amount: params.p_nondeductible_amount,
    capitalizable_amount: params.p_capitalizable_amount,
    tax_treatment: params.p_tax_treatment,
    classification_status: params.p_classification_status,
    confidence_score: params.p_confidence_score,
    confidence_level: params.p_confidence_level,
    rule_id: params.p_rule_id,
    rule_code: params.p_rule_code,
    rule_version: params.p_rule_version,
    rule_priority: params.p_rule_priority,
    source: params.p_source,
    requires_review: params.p_requires_review,
    reason: params.p_reason,
    user_override: false,
    cpa_override: false,
    metadata: { ...(current.metadata || {}), ...(params.p_metadata || {}) },
    updated_at: new Date().toISOString(),
  };
  rows[idx] = updated;
  store.tax_classification_overrides.push({
    id: `repair-${store.tax_classification_overrides.length + 1}`,
    business_id: params.p_business_id,
    tax_year: params.p_tax_year,
    transaction_id: params.p_transaction_id,
    classification_id: current.id,
    previous_values: previous,
    new_values: snapshot(updated),
    override_source: "system_repair",
    override_reason: params.p_repair_reason,
    overridden_by: params.p_actor_user_id,
    created_at: new Date().toISOString(),
  });
  return { data: updated, error: null };
}

function snapshot(row) {
  return {
    tax_category: row.tax_category,
    deductibility_status: row.deductibility_status,
    deductible_percent: row.deductible_percent,
    deductible_amount: row.deductible_amount,
    classification_status: row.classification_status,
    rule_code: row.rule_code,
    requires_review: row.requires_review,
  };
}

class Query {
  constructor(table, store) {
    this.table = table;
    this.store = store;
    this.rows = [...(store[table] || [])];
    this.patch = null;
  }
  select() { return this; }
  eq(field, value) {
    this.rows = this.rows.filter((row) => String(row[field]) === String(value));
    return this;
  }
  gte(field, value) {
    this.rows = this.rows.filter((row) => String(row[field] || "") >= String(value));
    return this;
  }
  lte(field, value) {
    this.rows = this.rows.filter((row) => String(row[field] || "") <= String(value));
    return this;
  }
  in(field, values) {
    const set = new Set((values || []).map(String));
    this.rows = this.rows.filter((row) => set.has(String(row[field])));
    return this;
  }
  is(field, value) {
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }
  order(field, options = {}) {
    const dir = options.ascending === false ? -1 : 1;
    this.rows = [...this.rows].sort((a, b) => String(a[field] || "").localeCompare(String(b[field] || "")) * dir);
    return this;
  }
  range(start, end) {
    this.rows = this.rows.slice(start, end + 1);
    return this;
  }
  limit(n) {
    this.rows = this.rows.slice(0, n);
    return this;
  }
  update(patch) {
    this.patch = patch;
    return this;
  }
  upsert(row) {
    const idx = this.store[this.table].findIndex((existing) =>
      String(existing.business_id) === String(row.business_id) &&
      String(existing.transaction_id) === String(row.transaction_id) &&
      String(existing.tax_year) === String(row.tax_year)
    );
    if (idx >= 0) this.store[this.table][idx] = { ...this.store[this.table][idx], ...row };
    else this.store[this.table].push(row);
    this.rows = [idx >= 0 ? this.store[this.table][idx] : row];
    return this;
  }
  maybeSingle() {
    this.applyPatch();
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  single() {
    this.applyPatch();
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  then(resolve) {
    this.applyPatch();
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
  applyPatch() {
    if (!this.patch) return;
    const ids = new Set(this.rows.map((row) => row.id));
    this.store[this.table] = this.store[this.table].map((row) => ids.has(row.id) ? { ...row, ...this.patch } : row);
    this.rows = this.store[this.table].filter((row) => ids.has(row.id));
    this.patch = null;
  }
}
