import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { test } from "node:test";
import {
  TAX_DEDUCTION_DECISION_RULE_VERSION,
  __testables,
  buildTaxDeductionDecisionRule,
  toTaxDeductionDecisionRule,
} from "../src/services/tax/taxDeductionDecisionRule.service.js";

test("explicit deduction decision rules are GL-scoped, company-specific, and engine-compatible", () => {
  const rule = buildTaxDeductionDecisionRule({
    businessId: "business-1",
    taxYear: 2026,
    accountName: "Meals",
    classification: {
      tax_category: "meals",
      deductibility_status: "partially_deductible",
      deductible_percent: 50,
      tax_treatment: { type: "business_meals_business_purpose_confirmed" },
    },
    input: { decisionType: "confirm_business_purpose" },
    actor: { userId: "user-1" },
  });

  assert.equal(rule.scope, "business_override");
  assert.equal(rule.version, TAX_DEDUCTION_DECISION_RULE_VERSION);
  assert.deepEqual(rule.match_conditions, { qbo_account_name_keys: ["meals"] });
  assert.equal(rule.default_deductible_percent, 50);
  assert.equal(rule.requires_review, false);
  assert.match(rule.source_reference, /^user_tax_deduction_decision:user-1:/);
});

test("rule cards only represent persisted user decisions, never an inferred classification status", () => {
  assert.equal(__testables.isExplicitTaxDeductionDecisionRule({
    scope: "business_override",
    version: TAX_DEDUCTION_DECISION_RULE_VERSION,
  }), true);
  assert.equal(__testables.isExplicitTaxDeductionDecisionRule({
    scope: "business_override",
    source_reference: "user-confirmed override by user-1",
  }), true);
  assert.equal(__testables.isExplicitTaxDeductionDecisionRule({
    scope: "business_override",
    source_reference: "system classification repair",
    classification_status: "user_confirmed",
  }), false);
});

test("decision-rule DTO preserves its forward-looking tax treatment", () => {
  const dto = toTaxDeductionDecisionRule({
    id: "rule-1",
    bookkeeping_category: "Gas",
    tax_category: "vehicle",
    deductibility_status: "nondeductible",
    default_deductible_percent: 0,
    treatment: { type: "vehicle_standard_mileage_no_separate_gas" },
  });
  assert.equal(dto.accountName, "Gas");
  assert.equal(dto.taxTreatment, "vehicle_standard_mileage_no_separate_gas");
  assert.equal(dto.deductiblePercent, 0);
});

test("Tax backend route modules import with inert local configuration", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", [
    'await import("./src/services/tax/taxDeductionsApi.service.js");',
    'await import("./src/api/tax/taxClassificationReview.routes.js");',
  ].join(" ")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
