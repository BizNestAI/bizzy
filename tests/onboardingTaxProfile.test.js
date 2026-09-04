import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildOnboardingTaxProfilePatch,
  getOnboardingTaxProfileFields,
  getOnboardingTaxYear,
  profileResultHasMinimumCompleteness,
  profileToTaxProfileValues,
  validateOnboardingTaxProfile,
} from "../src/components/Tax/Setup/taxProfileFormModel.js";

const COMPLETE_SOLE_PROPRIETOR = {
  entity_type: "sole_proprietor",
  filing_status: "single",
  primary_tax_state: "NC",
  accounting_method: "cash",
  safe_harbor_method: "current_year_90",
  self_employment_tax_applies: "true",
};

test("sole-proprietor onboarding requires the six minimum Tax Profile fields", () => {
  assert.deepEqual(getOnboardingTaxProfileFields({ entity_type: "sole_proprietor" }), [
    "entity_type",
    "filing_status",
    "primary_tax_state",
    "accounting_method",
    "safe_harbor_method",
    "self_employment_tax_applies",
  ]);

  const errors = validateOnboardingTaxProfile({ ...COMPLETE_SOLE_PROPRIETOR, self_employment_tax_applies: "" });
  assert.equal(errors.self_employment_tax_applies, "Confirm whether this business income is subject to self-employment tax.");
  assert.deepEqual(validateOnboardingTaxProfile(COMPLETE_SOLE_PROPRIETOR), {});
});

test("onboarding Tax Profile patch uses canonical fields and excludes protected identity/status", () => {
  const patch = buildOnboardingTaxProfilePatch(COMPLETE_SOLE_PROPRIETOR);

  assert.deepEqual(patch, {
    source: "onboarding",
    entity_type: "sole_proprietor",
    filing_status: "single",
    primary_tax_state: "NC",
    accounting_method: "cash",
    self_employment_tax_applies: true,
    safe_harbor_method: "current_year_90",
  });
  assert.equal("businessId" in patch, false);
  assert.equal("business_id" in patch, false);
  assert.equal("year" in patch, false);
  assert.equal("tax_year" in patch, false);
  assert.equal("profile_status" in patch, false);
  assert.equal("federal_withholding_ytd" in patch, false);
  assert.equal("reserve_buffer_percent" in patch, false);
});

test("Tax modal and onboarding share canonical profile value mapping", () => {
  const values = profileToTaxProfileValues({
    entity_type: "sole_proprietor",
    filing_status: "single",
    primary_tax_state: "NC",
    accounting_method: "cash",
    safe_harbor_method: "current_year_90",
    self_employment_tax_applies: true,
    federal_withholding_ytd: null,
  });

  assert.equal(values.entity_type, "sole_proprietor");
  assert.equal(values.filing_status, "single");
  assert.equal(values.primary_tax_state, "NC");
  assert.equal(values.accounting_method, "cash");
  assert.equal(values.safe_harbor_method, "current_year_90");
  assert.equal(values.self_employment_tax_applies, "true");
  assert.equal(values.federal_withholding_ytd, "");
});

test("onboarding tax year is explicit and based on the supplied as-of date", () => {
  assert.equal(getOnboardingTaxYear(new Date("2026-09-04T12:00:00Z")), 2026);
});

test("onboarding completion relies on server-derived Tax Profile completeness", () => {
  assert.equal(profileResultHasMinimumCompleteness({
    profile: { id: "profile-1" },
    readiness: { profile_status: "calculation_ready", missing_fields: [] },
    completeness: { isCompleteForEstimate: true, missingRequired: [] },
  }), true);
  assert.equal(profileResultHasMinimumCompleteness({
    profile: { id: "profile-1" },
    readiness: { profile_status: "draft", missing_fields: ["self_employment_tax_applies"] },
    completeness: { isCompleteForEstimate: false, missingRequired: ["self_employment_tax_applies"] },
  }), false);
});

test("BusinessWizard contains canonical Tax setup and saves through the Tax Profile API", async () => {
  const source = await readFile(new URL("../src/pages/UserAdmin/BusinessWizard.jsx", import.meta.url), "utf8");

  assert.match(source, /Tax setup/);
  assert.match(source, /Tax setup for/);
  assert.match(source, /TaxProfileSelectField/);
  assert.match(source, /getTaxProfile/);
  assert.match(source, /updateTaxProfile/);
  assert.match(source, /profileResultHasMinimumCompleteness/);
  assert.doesNotMatch(source, /profile_status\s*:/);
});
