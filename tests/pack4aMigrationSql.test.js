import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SQL = readFileSync(new URL("../supabase/migrations/20260716_pack4a_priority_states.sql", import.meta.url), "utf8");

test("Pack 4A scopes CA S-Corp tax away from general/null entity rows", () => {
  assert.match(SQL, /\(2026,\s*'CA',\s*'s_corp_minimum_tax',\s*'s_corp'/);
  assert.match(SQL, /\(2026,\s*'CA',\s*'s_corp_minimum_tax',\s*'single_member_llc'/);
  assert.doesNotMatch(SQL, /\(2026,\s*'CA',\s*'s_corp_minimum_tax',\s*null/);
  assert.match(SQL, /"appliesOnlyToEntityPaths":\["s_corporation"\]/);
  assert.match(SQL, /"requiresTaxElection":"s_corp"/);
});

test("Pack 4A distinguishes CA estimated methodology from final return support", () => {
  assert.match(SQL, /"estimatedTaxCalculationSupport":"verified_2026_form_540_es_uses_2025_tax_table"/);
  assert.match(SQL, /"finalReturnCalculationSupport":"unavailable"/);
  assert.match(SQL, /"calculationPurpose":"2026_estimated_tax_worksheet"/);
  assert.match(SQL, /"finalReturnDeductionSupport":"unavailable_until_2026_final_instructions"/);
});

test("Pack 4A does not seed Florida corporate rate as a live general entity calculation", () => {
  assert.doesNotMatch(SQL, /\(2026,\s*'FL',\s*'franchise_tax',\s*null/);
  assert.match(SQL, /\(2026,\s*'FL',\s*'entity_tax_caveat',\s*'s_corp'/);
  assert.match(SQL, /\(2026,\s*'FL',\s*'entity_tax_caveat',\s*'single_member_llc'/);
  assert.match(SQL, /"verifiedCorporateIncomeFranchiseTaxRate":0\.055/);
  assert.match(SQL, /"corporateExemptionAmount":50000/);
  assert.match(SQL, /"apportionmentRequired":true/);
  assert.match(SQL, /"corporateEntityPathSupport":"unsupported_in_current_entity_engine"/);
  assert.match(SQL, /"doesNotAutomaticallyApplyTo":\["sole_proprietor","single_member_llc_disregarded","ordinary_federal_s_corporation"\]/);
});

test("Pack 4A Texas franchise config separates report year from Bizzi activity year", () => {
  assert.match(SQL, /"reportYears":\[2026,2027\]/);
  assert.match(SQL, /"taxYearRepresents":"bizzi_projection_activity_year"/);
  assert.match(SQL, /"incomePeriodBasis":"texas_franchise_report_year_accounting_period_not_calendar_tax_year"/);
  assert.match(SQL, /"annualReportDueMonthDay":"05-15"/);
  assert.match(SQL, /"doesNotCreateCalendarYear2026DeadlineFor2026Activity":true/);
  assert.doesNotMatch(SQL, /"annualReportDueDate":"2026-05-15"/);
});

test("Pack 4A NC verified values cite the 2026 NC-40 form reference", () => {
  assert.match(SQL, /"rate":0\.0399/);
  assert.match(SQL, /"single":12750/);
  assert.match(SQL, /"expectedTaxDueThreshold":1000/);
  assert.match(SQL, /"sourceDocument":"2026 NC-40 Individual Estimated Income Tax\.pdf, PDF published by NCDOR January 21, 2026"/);
});

test("Pack 4A caveats are not null-entity state-wide rules", () => {
  assert.doesNotMatch(SQL, /\(2026,\s*'CA',\s*'entity_tax_caveat',\s*null/);
  assert.doesNotMatch(SQL, /\(2026,\s*'NY',\s*'entity_tax_caveat',\s*null/);
  assert.doesNotMatch(SQL, /\(2026,\s*'NC',\s*'entity_tax_caveat',\s*null/);
  assert.match(SQL, /"localTaxCaveatsNotAppliedWithoutLocation":\["nyc_personal_income_tax","yonkers_tax","mctmt"\]/);
});

test("Pack 4A seeded entity_type values belong to the canonical tax profile enum", () => {
  const allowed = new Set(["sole_proprietor", "single_member_llc", "s_corp", "unknown"]);
  const entityTypes = Array.from(SQL.matchAll(/\(2026,\s*'[A-Z]{2}',\s*'[^']+',\s*(null|'([^']+)')/g))
    .map((match) => match[2])
    .filter(Boolean);
  assert.ok(entityTypes.length > 0);
  assert.deepEqual(entityTypes.filter((value) => !allowed.has(value)), []);
  assert.ok(!entityTypes.includes("single_member_llc_disregarded"));
  assert.ok(!entityTypes.includes("single_member_llc_s_corp"));
  assert.ok(!entityTypes.includes("s_corporation"));
});

test("Pack 4A deactivation is limited to known Pack 4A rows", () => {
  assert.match(SQL, /existing\.version in \('pack4a-2026-v1', 'pack4a-2026-draft'\)/);
  assert.doesNotMatch(SQL, /existing\.version <> seed\.version/);
  assert.match(SQL, /superseded_pack_rows/);
});
