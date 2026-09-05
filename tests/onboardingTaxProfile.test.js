import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildOnboardingTaxProfilePatch,
  getAnsweredOnboardingTaxProfileFields,
  getOnboardingTaxProfileFields,
  getOnboardingTaxYear,
  hasOnboardingTaxProfileAnswers,
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

test("Tax estimate setup still defines the six minimum estimate fields", () => {
  assert.deepEqual(getOnboardingTaxProfileFields({ entity_type: "sole_proprietor" }), [
    "entity_type",
    "filing_status",
    "primary_tax_state",
    "accounting_method",
    "safe_harbor_method",
    "self_employment_tax_applies",
  ]);
});

test("onboarding can finish without estimate-only personal tax fields", () => {
  assert.deepEqual(validateOnboardingTaxProfile({
    entity_type: "sole_proprietor",
    filing_status: "",
    primary_tax_state: "",
    accounting_method: "",
    safe_harbor_method: "",
    self_employment_tax_applies: "",
  }), {});

  assert.equal(validateOnboardingTaxProfile({ entity_type: "" }).entity_type, "Choose a business tax structure.");
  assert.equal(validateOnboardingTaxProfile({ entity_type: "unknown" }).entity_type, "Confirm the entity type before relying on an estimate.");
});

test("partial onboarding Tax Profile patch persists only answered canonical fields", () => {
  const patch = buildOnboardingTaxProfilePatch({
    entity_type: "sole_proprietor",
    filing_status: "",
    primary_tax_state: "NC",
    accounting_method: "",
    safe_harbor_method: "",
    self_employment_tax_applies: "",
  });

  assert.deepEqual(patch, {
    source: "onboarding",
    entity_type: "sole_proprietor",
    primary_tax_state: "NC",
  });
  assert.deepEqual(getAnsweredOnboardingTaxProfileFields(patch), ["entity_type", "primary_tax_state"]);
  assert.equal(hasOnboardingTaxProfileAnswers(patch), true);
  assert.equal("businessId" in patch, false);
  assert.equal("business_id" in patch, false);
  assert.equal("year" in patch, false);
  assert.equal("tax_year" in patch, false);
  assert.equal("profile_status" in patch, false);
  assert.equal("federal_withholding_ytd" in patch, false);
  assert.equal("reserve_buffer_percent" in patch, false);
});

test("blank onboarding state never overwrites saved Tax Profile values", () => {
  const patch = buildOnboardingTaxProfilePatch({
    entity_type: "",
    filing_status: "",
    primary_tax_state: "",
    accounting_method: "",
    safe_harbor_method: "",
    self_employment_tax_applies: "",
  });

  assert.deepEqual(patch, { source: "onboarding" });
});

test("complete onboarding Tax Profile patch preserves explicit false separately from blank", () => {
  const patch = buildOnboardingTaxProfilePatch({ ...COMPLETE_SOLE_PROPRIETOR, self_employment_tax_applies: "false" });

  assert.equal(patch.self_employment_tax_applies, false);
  assert.equal(patch.filing_status, "single");
  assert.equal(patch.safe_harbor_method, "current_year_90");
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

test("Tax estimate completeness remains server-derived and separate from onboarding", () => {
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

  assert.match(source, /Tax estimate setup/);
  assert.doesNotMatch(source, /Complete tax setup now/);
  assert.doesNotMatch(source, /Skip for now/);
  assert.match(source, /You can update these answers anytime from the Tax page/);
  assert.match(source, /TaxProfileSelectField/);
  assert.match(source, /getTaxProfile/);
  assert.match(source, /updateTaxProfile/);
  assert.doesNotMatch(source, /profileResultHasMinimumCompleteness/);
  assert.doesNotMatch(source, /These answers are saved to your canonical Tax Profile/);
  assert.doesNotMatch(source, /profile_status\s*:/);
});

test("BusinessWizard no longer requires optional personalization fields to finish", async () => {
  const source = await readFile(new URL("../src/pages/UserAdmin/BusinessWizard.jsx", import.meta.url), "utf8");

  assert.match(source, /formData\.business_name &&\s+formData\.industry &&\s+formData\.state/);
  assert.doesNotMatch(source, /formData\.team_size &&/);
  assert.doesNotMatch(source, /formData\.services_offered &&/);
  assert.doesNotMatch(source, /htmlFor="setup-team-size" required/);
  assert.doesNotMatch(source, /htmlFor="setup-services-offered" required/);
});
