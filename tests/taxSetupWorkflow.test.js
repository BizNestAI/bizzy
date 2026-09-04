/* global process */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  buildMemoryPayloads,
  buildTaxProfilePatch,
  validateTaxSetup,
} from "../src/components/Tax/Setup/taxSetupValidation.js";
import { getStepFields } from "../src/components/Tax/Setup/taxSetupSteps.js";
import { resolveTaxSetupAction } from "../src/components/Tax/Setup/taxSetupRouting.js";
import { saveTaxSetupData } from "../src/components/Tax/Setup/taxSetupSave.js";
import { TRI_STATE_OPTIONS } from "../src/components/Tax/Setup/taxProfileFields.js";

describe("tax setup workflow rules", () => {
  it("blocks unknown single-member LLC election for calculation readiness", () => {
    const errors = validateTaxSetup({
      entity_type: "single_member_llc",
      tax_election: "unknown",
      filing_status: "single",
      primary_tax_state: "NY",
      accounting_method: "cash",
      safe_harbor_method: "current_year_90",
    });
    assert.equal(errors.tax_election, "Confirm how the single-member LLC is taxed.");
  });

  it("shows sole proprietor fields without S-Corp salary fields", () => {
    const fields = getStepFields("entity_details", { entity_type: "sole_proprietor", tax_election: "sole_proprietor" });
    assert.ok(fields.includes("self_employment_tax_applies"));
    assert.ok(!fields.includes("owner_reasonable_salary"));
  });

  it("shows SMLLC S-Corp fields without self-employment applicability", () => {
    const fields = getStepFields("entity_details", { entity_type: "single_member_llc", tax_election: "s_corp" });
    assert.ok(fields.includes("owner_reasonable_salary"));
    assert.ok(fields.includes("owner_w2_wages_ytd"));
    assert.ok(!fields.includes("self_employment_tax_applies"));
  });

  it("requires prior-year AGI for the 110% safe-harbor method", () => {
    const errors = validateTaxSetup({
      entity_type: "sole_proprietor",
      tax_election: "sole_proprietor",
      filing_status: "head_of_household",
      primary_tax_state: "CA",
      accounting_method: "cash",
      self_employment_tax_applies: true,
      safe_harbor_method: "prior_year_110",
      prior_year_total_tax: 12000,
    });
    assert.equal(errors.prior_year_agi, "Add prior-year AGI for the 110% method.");
  });

  it("keeps suggested state out of profile patch until confirmed", () => {
    const patch = buildTaxProfilePatch(
      { entity_type: "sole_proprietor", primary_tax_state: "CA", filing_status: "single" },
      { confirmedFields: new Set(["entity_type", "filing_status"]) }
    );
    assert.equal(patch.entity_type, "sole_proprietor");
    assert.equal(patch.filing_status, "single");
    assert.equal("primary_tax_state" in patch, false);
  });

  it("normalizes confirmed reserve percent without turning nulls into zero", () => {
    const patch = buildTaxProfilePatch(
      { reserve_buffer_percent: "15", federal_withholding_ytd: null },
      { confirmedFields: new Set(["reserve_buffer_percent", "federal_withholding_ytd"]) }
    );
    assert.equal(patch.reserve_buffer_percent, 0.15);
    assert.equal(patch.federal_withholding_ytd, null);
  });

  it("does not let the setup patch set profile status or review metadata", () => {
    const patch = buildTaxProfilePatch(
      {
        entity_type: "sole_proprietor",
        filing_status: "single",
        primary_tax_state: "NC",
        accounting_method: "cash",
        safe_harbor_method: "current_year_90",
        self_employment_tax_applies: "",
      },
      {
        confirmedFields: new Set([
          "entity_type",
          "filing_status",
          "primary_tax_state",
          "accounting_method",
          "safe_harbor_method",
          "self_employment_tax_applies",
        ]),
      }
    );

    assert.equal("profile_status" in patch, false);
    assert.equal("last_reviewed_at" in patch, false);
    assert.equal("metadata" in patch, false);
    assert.equal("self_employment_tax_applies" in patch, false);
  });

  it("preserves true, false, and unanswered self-employment states", () => {
    const confirmedFields = new Set(["entity_type", "self_employment_tax_applies"]);
    assert.equal(buildTaxProfilePatch(
      { entity_type: "sole_proprietor", self_employment_tax_applies: "true" },
      { confirmedFields }
    ).self_employment_tax_applies, true);
    assert.equal(buildTaxProfilePatch(
      { entity_type: "sole_proprietor", self_employment_tax_applies: "false" },
      { confirmedFields }
    ).self_employment_tax_applies, false);
    assert.equal("self_employment_tax_applies" in buildTaxProfilePatch(
      { entity_type: "sole_proprietor", self_employment_tax_applies: "" },
      { confirmedFields }
    ), false);
  });

  it("supports QBI unsure as an explicit option", () => {
    assert.ok(TRI_STATE_OPTIONS.some((option) => option.value === null && option.label === "I'm not sure"));
  });

  it("builds effective-dated memory API payloads for changed keys only", () => {
    const payloads = buildMemoryPayloads(
      { vehicle_deduction_method: "standard_mileage", home_office_method: "simplified" },
      new Set(["home_office_method"])
    );
    assert.deepEqual(payloads, [{
      memoryKey: "home_office_method",
      value: "simplified",
      source: "user",
      confidenceScore: 1,
      metadata: { surface: "tax_setup_workflow" },
    }]);
  });

  it("routes setup blockers to the correct workflow or product area", () => {
    assert.deepEqual(resolveTaxSetupAction({ code: "entity_unknown" }), { type: "workflow", initialStepId: "business_structure" });
    assert.equal(resolveTaxSetupAction({ code: "state_rules_missing" }).type, "support_limitation");
    assert.deepEqual(resolveTaxSetupAction({ code: "classifications_missing" }), { type: "route", route: "/dashboard/tax" });
  });

  it("saves profile and memory before requesting calculation refresh", async () => {
    const order = [];
    await saveTaxSetupData({
      ensureProfile: async () => order.push("ensure"),
      saveProfile: async () => order.push("profile"),
      saveMemories: async () => order.push("memory"),
      refreshCalculation: async () => order.push("calculate"),
      profilePatch: { entity_type: "s_corp" },
      memoryPayloads: [{ memoryKey: "vehicle_deduction_method", value: "undecided" }],
      mode: "save_and_calculate",
    });
    assert.deepEqual(order, ["ensure", "profile", "memory", "calculate"]);
  });

  it("does not introduce direct client Supabase writes in tax setup components", () => {
    const root = path.join(process.cwd(), "src/components/Tax");
    const files = walk(root).filter((file) => file.endsWith(".jsx") || file.endsWith(".js"));
    const activeTaxSource = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
    assert.doesNotMatch(activeTaxSource, /\.from\(["']tax_profiles["']\)\.(insert|update|upsert|delete)/);
    assert.doesNotMatch(activeTaxSource, /\.from\(["']tax_profile_memory["']\)\.(insert|update|upsert|delete)/);
  });
});

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
