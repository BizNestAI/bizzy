import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTaxCalculationGraph,
  reproduceTaxCalculationGraph,
} from "../src/services/tax/workpaper/taxCalculationGraph.js";

test("S-Corp entity graph traces owner wages, employer payroll tax, pass-through income, distributions, and state entity tax", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: sCorpResult(), workpaper: sCorpWorkpaper() });

  assert.equal(node(graph, "entity_treatment:owner_wages").reconciliationStatus, "reconciled");
  assert.equal(node(graph, "entity_treatment:owner_wages_source").sourceRefs[0].sourceType, "tax_profile_snapshot");
  assert.equal(node(graph, "entity_treatment:employer_social_security_tax").formulaExpression, "72000 * 0.062");
  assert.equal(node(graph, "entity_treatment:employer_medicare_tax").formulaExpression, "72000 * 0.0145");
  assert.equal(node(graph, "entity_treatment:employer_payroll_taxes").reconciliationStatus, "reconciled");
  assert.equal(node(graph, "entity_treatment:pass_through_income").formulaExpression, "197508 - 72000 - 5508 + 0");
  assert.equal(node(graph, "entity_treatment:pass_through_income").reconciliationStatus, "reconciled");
  assert.equal(node(graph, "entity_treatment:distributions_excluded:snapshot").status, "excluded");
  assert.equal(node(graph, "entity_treatment:state_minimum_entity_tax").amount, 200);
  assert.equal(node(graph, "entity_treatment:ptet:snapshot").amount, 5400);
  assert.equal(node(graph, "entity_treatment:total_entity_payroll_tax_effect").amount, 11108);

  const reproduced = reproduceTaxCalculationGraph({ nodes: graph.nodes });
  assert.equal(reproduced.values["entity_treatment:pass_through_income"], 120000);
  assert.equal(reproduced.values["entity_treatment:employer_payroll_taxes"], 5508);
});

test("S-Corp-elected LLC uses the S-Corp path and preserves election profile facts", () => {
  const result = sCorpResult({
    profile: {
      entity_type: "single_member_llc",
      tax_election: "s_corp",
      s_corp_election_effective_date: "2025-01-01",
    },
  });
  const graph = buildTaxCalculationGraph({ canonicalResult: result, workpaper: sCorpWorkpaper() });

  assert.equal(graph.inputSnapshot.profileFacts.entityPath, "s_corporation");
  assert.equal(graph.inputSnapshot.profileFacts.sElection, true);
  assert.equal(graph.inputSnapshot.profileFacts.electionEffectiveDate, "2025-01-01");
  assert.equal(node(graph, "entity_treatment:pass_through_income").reconciliationStatus, "reconciled");
});

test("sole proprietor entity graph reproduces self-employment earnings, wage-base cap, and SE tax", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: seResult("sole_proprietor"), workpaper: seWorkpaper() });

  assert.equal(node(graph, "entity_treatment:net_earnings_from_self_employment").formulaExpression, "100000 * 0.9235");
  assert.equal(node(graph, "entity_treatment:self_employment_taxable_base").formulaExpression, "min(92350, 86850)");
  assert.equal(node(graph, "entity_treatment:self_employment_social_security_tax").formulaExpression, "86850 * 0.124");
  assert.equal(node(graph, "entity_treatment:self_employment_medicare_tax").formulaExpression, "92350 * 0.029");
  assert.equal(node(graph, "entity_treatment:self_employment_tax_total").reconciliationStatus, "reconciled");

  const reproduced = reproduceTaxCalculationGraph({ nodes: graph.nodes });
  assert.equal(reproduced.values["entity_treatment:net_earnings_from_self_employment"], 92350);
  assert.equal(reproduced.values["entity_treatment:self_employment_tax_total"], 13447.55);
});

test("disregarded single-member LLC uses the self-employment path", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: seResult("single_member_llc_disregarded"), workpaper: seWorkpaper() });

  assert.equal(graph.inputSnapshot.profileFacts.entityPath, "single_member_llc_disregarded");
  assert.ok(node(graph, "entity_treatment:self_employment_tax_total").ruleRefs.length > 0);
  assert.equal(graph.nodes.some((item) => item.nodeCode === "entity_treatment:owner_wages_source"), false);
});

test("missing S-Corp payroll data creates unavailable lineage instead of fake owner wages", () => {
  const result = sCorpResult({ ownerWages: null, payrollTax: null, passThroughIncome: null });
  const graph = buildTaxCalculationGraph({ canonicalResult: result, workpaper: sCorpWorkpaper({ ownerWages: null, payrollTax: null, passThroughIncome: null }) });

  assert.equal(node(graph, "entity_treatment:owner_wages_source_unavailable").status, "unavailable");
  assert.equal(node(graph, "entity_treatment:owner_wages").amount, null);
  assert.equal(graph.nodes.some((item) => item.nodeCode === "entity_treatment:owner_wages_source" && item.amount === 0), false);
});

test("historical entity graph is unchanged after later profile mutation", () => {
  const result = sCorpResult();
  const graph = buildTaxCalculationGraph({ canonicalResult: result, workpaper: sCorpWorkpaper() });
  const profileSource = node(graph, "entity_treatment:entity_profile_snapshot").sourceRefs[0];
  const wageSource = node(graph, "entity_treatment:owner_wages_source").sourceRefs[0];

  result.profile.profile.entity_type = "sole_proprietor";
  result.profile.profile.owner_w2_wages_ytd = 999999;
  result.profile.profile.metadata.projected_owner_w2_wages = 999999;

  assert.equal(graph.inputSnapshot.profileFacts.entityType, "s_corporation");
  assert.equal(profileSource.snapshotValue.entityType, "s_corporation");
  assert.equal(wageSource.snapshotValue.projectedOwnerWages, 72000);
  assert.equal(node(graph, "entity_treatment:owner_wages_source").amount, 72000);
});

function node(graph, code) {
  const found = graph.nodes.find((item) => item.nodeCode === code);
  assert.ok(found, `Expected graph node ${code}`);
  return found;
}

function baseResult({ profile = {}, entityPath = "s_corporation" } = {}) {
  return {
    meta: {
      businessId: "business-entity-1",
      taxYear: 2026,
      asOfDate: "2026-07-21",
      engineVersions: {
        entity: "entity-v1",
        sCorporation: "s-corp-v1",
        selfEmployment: "se-v1",
        state: "state-v1",
        orchestrator: "orchestrator-v1",
      },
    },
    profile: {
      profile: {
        id: "profile-1",
        version: "profile-v1",
        updated_at: "2026-07-21T12:00:00Z",
        entity_type: "s_corporation",
        tax_election: "s_corp",
        filing_status: "single",
        primary_tax_state: "NC",
        accounting_method: "cash",
        owner_count: 1,
        ownership_percentages: [{ ownerId: "owner-1", percentage: 100 }],
        owner_w2_wages_ytd: 60000,
        metadata: {
          projected_owner_w2_wages: 72000,
          employer_social_security_rate: 0.062,
          employer_medicare_rate: 0.0145,
          social_security_wage_base: 176100,
          ptet_election: true,
        },
        ...profile,
      },
      entityContext: {
        entity: {
          entityPath,
          entityType: profile.entity_type || "s_corporation",
          taxElection: profile.tax_election || "s_corp",
          ptetElection: true,
          stateNexus: { NC: true },
        },
        meta: { engineVersion: "entity-v1" },
      },
      memoryFactVersion: "memory-v1",
      memories: [{ memory_key: "payroll_source", value_json: { source: "tax_profile" } }],
    },
    entity: { entityPath },
    projection: {
      projectedAnnual: {
        revenue: 312000,
        taxableBusinessIncome: 197508,
      },
    },
    actuals: {
      taxableIncome: {
        businessTaxableIncome: { finalBusinessTaxableIncome: 197508 },
      },
    },
  };
}

function sCorpResult({ profile = {}, ownerWages = 72000, payrollTax = 5508, passThroughIncome = 120000 } = {}) {
  const profileOverride = ownerWages == null
    ? {
      ...profile,
      owner_w2_wages_ytd: null,
      metadata: {
        ...(profile.metadata || {}),
        projected_owner_w2_wages: null,
        employer_social_security_rate: 0.062,
        employer_medicare_rate: 0.0145,
        social_security_wage_base: 176100,
        ptet_election: true,
      },
    }
    : profile;
  const result = baseResult({ profile: profileOverride, entityPath: "s_corporation" });
  result.sCorp = {
    meta: { engineVersion: "s-corp-v1", ruleVersions: { sCorpPassThrough: "s-corp-rules-v1" } },
    sourceBreakdown: { ownerWages: "tax_profile", payrollTax: "tax_profile_metadata", distributions: "transaction_tax_classifications" },
    income: {
      businessIncomeBeforeOwnerCompensation: 197508,
      officerCompensation: ownerWages,
      employerPayrollTax: payrollTax,
      passThroughIncome,
      distributions: 30000,
      entityAdjustments: 0,
    },
    wages: {
      ownerW2WagesYtd: ownerWages == null ? null : 60000,
      projectedOwnerW2Wages: ownerWages,
    },
    payroll: {
      payrollTaxKnown: payrollTax != null,
      payrollTaxStatus: payrollTax == null ? "unknown" : "available",
      payrollTaxAmount: payrollTax,
      socialSecurityRate: 0.062,
      medicareRate: 0.0145,
      socialSecurityWageBase: 176100,
    },
  };
  result.federal = {
    incomeTax: {
      income: {
        annualBusinessTaxableIncome: passThroughIncome,
        otherIncome: { amount: ownerWages },
      },
    },
    payrollTaxContext: result.sCorp.payroll,
  };
  result.state = {
    stateCode: "NC",
    incomeTax: {
      meta: {
        engineVersion: "state-v1",
        ruleVersions: {
          sCorpEntityTax: "nc-s-corp-entity-v1",
          sCorpMinimumTax: "nc-minimum-v1",
          ptet: "nc-ptet-v1",
        },
      },
      tax: { passThroughEntityTax: 5400 },
      entityTax: {
        knownAmount: 200,
        sCorpEntityTax: { amount: 0, taxBase: 120000, rate: 0, ruleVersion: "nc-s-corp-entity-v1", taxLabel: "North Carolina entity tax" },
        sCorpMinimumTax: { amount: 200, taxBase: 120000, minimumTax: 200, ruleVersion: "nc-minimum-v1" },
      },
    },
    entityTaxes: {
      sCorpEntityTax: 0,
      sCorpMinimumTax: 200,
      detail: {
        knownAmount: 200,
        sCorpEntityTax: { amount: 0, taxBase: 120000, rate: 0, ruleVersion: "nc-s-corp-entity-v1", taxLabel: "North Carolina entity tax" },
        sCorpMinimumTax: { amount: 200, taxBase: 120000, minimumTax: 200, ruleVersion: "nc-minimum-v1" },
      },
    },
  };
  return result;
}

function seResult(entityPath) {
  const entityType = entityPath === "sole_proprietor" ? "sole_proprietor" : "single_member_llc";
  const result = baseResult({
    profile: { entity_type: entityType, tax_election: null, owner_w2_wages_ytd: null, metadata: { other_social_security_wages_ytd: 10000 } },
    entityPath,
  });
  result.entity = { entityPath };
  result.projection.projectedAnnual.taxableBusinessIncome = 100000;
  result.actuals.taxableIncome.businessTaxableIncome.finalBusinessTaxableIncome = 100000;
  result.federal = {
    selfEmploymentTax: {
      meta: {
        engineVersion: "se-v1",
        ruleVersions: {
          selfEmploymentTax: "se-rule-v1",
          socialSecurityWageBase: "ss-wage-base-v1",
          additionalMedicareThreshold: "addl-medicare-v1",
        },
      },
      input: {
        annualNetBusinessIncome: 100000,
        otherW2Wages: 10000,
        otherWagesSource: "profile_metadata",
      },
      result: {
        netEarningsFromSelfEmployment: 92350,
        socialSecurityTax: 10769.4,
        medicareTax: 2678.15,
        additionalMedicareTax: 0,
        totalSelfEmploymentTax: 13447.55,
        deductibleHalfSelfEmploymentTax: 6723.78,
      },
      detail: {
        socialSecurity: { wageBase: 96850, otherWages: 10000, remainingWageBase: 86850, taxableBase: 86850, rate: 0.124, tax: 10769.4 },
        medicare: { taxableBase: 92350, rate: 0.029, tax: 2678.15 },
        additionalMedicare: { threshold: 200000, taxableBase: 0, rate: 0.009, tax: 0, applied: false },
      },
    },
  };
  return result;
}

function sCorpWorkpaper({ ownerWages = 72000, payrollTax = 5508, passThroughIncome = 120000 } = {}) {
  return {
    lines: [
      line("entity_treatment:business_profit", "Business profit", 197508),
      line("entity_treatment:owner_wages", "Owner wages", ownerWages),
      line("entity_treatment:employer_payroll_taxes", "Employer payroll taxes", payrollTax),
      line("entity_treatment:pass_through_income", "S-Corp pass-through income", passThroughIncome),
      line("entity_treatment:distributions_excluded", "Distributions excluded", 30000, { status: "excluded" }),
      line("entity_treatment:entity_level_taxable_income", "State entity taxable income", 120000),
      line("entity_treatment:state_entity_taxes", "State entity taxes", 200),
      line("entity_treatment:ptet", "PTET", 5400),
    ],
    ruleVersionMap: { entity: { sCorporation: "s-corp-v1" } },
  };
}

function seWorkpaper() {
  return {
    lines: [
      line("entity_treatment:business_profit", "Business profit", 100000),
      line("entity_treatment:net_earnings_from_self_employment", "Net earnings from self-employment", 92350),
      line("entity_treatment:se_wage_base_treatment", "SE wage-base treatment", 86850),
      line("entity_treatment:se_tax_deduction", "SE tax deduction", 6723.78),
    ],
  };
}

function line(code, label, amount, overrides = {}) {
  return {
    code,
    label,
    section: "entity_treatment",
    parent_code: null,
    amount,
    sort_order: 10,
    display_sign: overrides.displaySign || null,
    status: overrides.status || (amount == null ? "unavailable" : "calculated"),
    support_level: "supported",
    confidence: 0.9,
    formula_code: overrides.formulaCode || null,
    formula_description: `${label} calculation from entity graph source nodes.`,
    explanation: `${label} calculation from entity graph source nodes.`,
    source_refs: [],
    rule_refs: [],
    rule_versions: {},
    metadata: { materiality: "high" },
  };
}
