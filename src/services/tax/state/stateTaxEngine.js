// /src/services/tax/state/stateTaxEngine.js
import { TAX_RULE_SUPPORT_LEVELS, normalizeFilingStatus, normalizeStateCode, normalizeTaxYear } from "../taxDomain.js";
import { validationError } from "../taxErrors.js";
import { TAX_STATE_ENGINE_VERSION } from "../taxEngineVersions.js";
import { computeProgressiveTax } from "../federal/progressiveTax.js";
import { getStateTaxConfigSet, getStateTaxRuleConfig, buildStateSupportSummary } from "../stateTaxRule.repository.js";
import { STATE_TAX_RULE_TYPES } from "../taxRuleTypes.js";
import { computeStateTaxConfidence } from "./stateTaxConfidence.js";
import { STATE_COMPONENT_STATUSES, STATE_TAX_COMPONENTS, STATE_TAX_WARNING_CODES, round2, stateWarning } from "./stateTaxDomain.js";

export async function computeStateTax({
  supabase,
  businessId,
  taxYear,
  asOfDate,
  stateCode,
  filingStatus,
  entityContext,
  federalContext,
  taxableIncomeContext,
  projectionContext,
  sCorpContext = null,
  scenario = null,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const year = normalizeTaxYear(taxYear);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  const state = normalizeStateCode(stateCode);
  const normalizedFiling = normalizeFilingStatus(filingStatus);
  const warnings = [];
  const blockers = [];
  if (!state) {
    blockers.push({ code: STATE_TAX_WARNING_CODES.STATE_MISSING, message: "Primary state is required for state tax calculation." });
    warnings.push(stateWarning(STATE_TAX_WARNING_CODES.STATE_MISSING, "critical", "Primary state is missing."));
    return emptyStateResult({ stateCode: null, taxYear: year, filingStatus: normalizedFiling, entityContext, warnings, blockers });
  }

  let configSet;
  try {
    configSet = await getStateTaxConfigSet({
      supabase,
      taxYear: year,
      stateCode: state,
      filingStatus: normalizedFiling,
      entityType: entityContext?.entity?.entityType,
      entityPath: entityContext?.entity?.entityPath,
      taxElection: entityContext?.entity?.taxElection,
      ptetElection: entityContext?.entity?.ptetElection,
      stateElection: stateElectionEnabled(entityContext),
      asOfDate,
    });
  } catch (err) {
    configSet = { stateCode: state, configs: {}, missing: [{ code: err.code, details: err.details }], warnings: [], supportLevel: TAX_RULE_SUPPORT_LEVELS.UNSUPPORTED, isUsableForEstimate: false, isUsableForReserve: false, assumptions: [] };
  }
  warnings.push(...(configSet.warnings || []));
  if (!configSet.isUsableForEstimate) {
    warnings.push(stateWarning(STATE_TAX_WARNING_CODES.STATE_RULE_MISSING, "high", "State tax rule config is missing or unsupported.", { stateCode: state }));
    blockers.push({ code: STATE_TAX_WARNING_CODES.UNSUPPORTED_STATE, message: "State tax rule config is unavailable.", stateCode: state });
  }

  const incomeRule = configSet.configs?.noIndividualIncomeTax || configSet.configs?.[STATE_TAX_RULE_TYPES.INDIVIDUAL_INCOME_TAX] || null;
  const standardDeductionRule = await optionalStateRule({ supabase, taxYear: year, stateCode: state, ruleType: STATE_TAX_RULE_TYPES.STANDARD_DEDUCTION, filingStatus: normalizedFiling, entityContext, asOfDate });
  const personalExemptionRule = await optionalStateRule({ supabase, taxYear: year, stateCode: state, ruleType: STATE_TAX_RULE_TYPES.PERSONAL_EXEMPTION, filingStatus: normalizedFiling, entityContext, asOfDate });
  const stateDeductionAdjustmentRule = await optionalStateRule({ supabase, taxYear: year, stateCode: state, ruleType: STATE_TAX_RULE_TYPES.STATE_DEDUCTION_ADJUSTMENT, filingStatus: normalizedFiling, entityContext, asOfDate });
  const ownerLevelBusinessElectionRule = await optionalStateRule({ supabase, taxYear: year, stateCode: state, ruleType: STATE_TAX_RULE_TYPES.OWNER_LEVEL_BUSINESS_INCOME_ELECTION, filingStatus: normalizedFiling, entityContext, asOfDate });
  const capitalGainsExciseRule = await optionalStateRule({ supabase, taxYear: year, stateCode: state, ruleType: STATE_TAX_RULE_TYPES.INDIVIDUAL_CAPITAL_GAINS_EXCISE_TAX, filingStatus: normalizedFiling, entityContext, asOfDate });
  const grossReceiptsTaxRule = await optionalStateRule({ supabase, taxYear: year, stateCode: state, ruleType: STATE_TAX_RULE_TYPES.GROSS_RECEIPTS_TAX, filingStatus: normalizedFiling, entityContext, asOfDate });
  const payrollExciseTaxRule = await optionalStateRule({ supabase, taxYear: year, stateCode: state, ruleType: STATE_TAX_RULE_TYPES.PAYROLL_EXCISE_TAX, filingStatus: normalizedFiling, entityContext, asOfDate });
  const franchiseTaxRule = await optionalStateRule({ supabase, taxYear: year, stateCode: state, ruleType: STATE_TAX_RULE_TYPES.FRANCHISE_TAX, filingStatus: normalizedFiling, entityContext, asOfDate });
  const sCorpEntityTaxRule = await optionalStateRule({ supabase, taxYear: year, stateCode: state, ruleType: STATE_TAX_RULE_TYPES.S_CORP_ENTITY_TAX, filingStatus: normalizedFiling, entityContext, asOfDate });
  const sCorpMinimumRule = await optionalStateRule({ supabase, taxYear: year, stateCode: state, ruleType: STATE_TAX_RULE_TYPES.S_CORP_MINIMUM_TAX, filingStatus: normalizedFiling, entityContext, asOfDate });
  const taxableBase = stateTaxableIncome({ federalContext, taxableIncomeContext, projectionContext, sCorpContext, standardDeductionRule, personalExemptionRule, stateDeductionAdjustmentRule, filingStatus: normalizedFiling });
  const stateTax = computeByRule({ rule: incomeRule, taxableIncome: taxableBase.stateTaxableIncome, warnings, federalContext, filingStatus: normalizedFiling });
  const individualIncomeTax = buildIndividualIncomeTax({ rule: incomeRule, stateTax, taxableBase });
  const ownerLevelBusinessIncomeElection = buildOwnerLevelBusinessIncomeElection({ rule: ownerLevelBusinessElectionRule, entityContext, sCorpContext });
  const businessExcises = buildBusinessExcises({ grossReceiptsTaxRule, payrollExciseTaxRule, entityContext, sCorpContext, stateCode: state });
  const capitalGainsExciseTax = computeCapitalGainsExciseTax({ rule: capitalGainsExciseRule, federalContext });
  const entityTax = buildEntityTax({ caveatRule: configSet.configs?.entityTaxCaveat, franchiseTaxRule, sCorpEntityTaxRule, sCorpMinimumRule, businessExcises, entityContext, sCorpContext, taxableBase, warnings, stateCode: state });
  const sCorpMinimumTax = entityTax.sCorpMinimumTax?.amount || 0;
  const sCorpEntityTax = entityTax.sCorpEntityTax?.amount || 0;
  if (entityContext?.entity?.entityPath === "s_corporation" && !sCorpMinimumRule && !sCorpEntityTaxRule) {
    warnings.push(stateWarning(STATE_TAX_WARNING_CODES.S_CORP_ENTITY_TAX_UNKNOWN, "low", "S-Corp entity tax config is unavailable for this state."));
  }
  warnings.push(
    stateWarning(STATE_TAX_WARNING_CODES.LOCAL_TAX_UNSUPPORTED, "low", "Local income tax is deferred unless verified local configs are added."),
    stateWarning(STATE_TAX_WARNING_CODES.PTE_TAX_UNSUPPORTED, "low", "Pass-through entity tax is deferred unless verified state configs are added.")
  );
  const totalStateTax = buildTotalStateTax({ individualIncomeTax, entityTax });
  const stateWithholding = Number(sCorpContext?.withholding?.stateWithholdingYtd ?? federalContext?.input?.stateWithholdingYtd ?? 0);
  const range = computeRange({ rule: incomeRule, projectionContext, federalContext, standardDeductionRule, personalExemptionRule, filingStatus: normalizedFiling });
  const provisionalReserve = await computeProvisionalStateReserve({ supabase, stateCode: state, taxYear: year, taxableBase, totalStateTax, asOfDate });
  const confidence = computeStateTaxConfidence({
    stateCode: state,
    configSet,
    filingStatus: normalizedFiling,
    entityContext,
    withholdingKnown: stateWithholding > 0,
    multiState: scenario?.multiState === true,
    projectionContext,
    warnings,
    blockers,
    stateResultStatus: totalStateTax.status,
  });

  return {
    meta: {
      stateCode: state,
      taxYear: year,
      filingStatus: normalizedFiling,
      entityPath: entityContext?.entity?.entityPath || "unknown",
      engineVersion: TAX_STATE_ENGINE_VERSION,
      ruleVersions: ruleVersions([incomeRule, standardDeductionRule, personalExemptionRule, stateDeductionAdjustmentRule, ownerLevelBusinessElectionRule, capitalGainsExciseRule, grossReceiptsTaxRule, payrollExciseTaxRule, franchiseTaxRule, sCorpEntityTaxRule, sCorpMinimumRule]),
      supportSummary: buildStateSupportSummary([incomeRule, standardDeductionRule, personalExemptionRule, stateDeductionAdjustmentRule, ownerLevelBusinessElectionRule, capitalGainsExciseRule, grossReceiptsTaxRule, payrollExciseTaxRule, franchiseTaxRule, sCorpEntityTaxRule, sCorpMinimumRule].filter(Boolean), { stateCode: state }),
    },
    income: {
      federalAdjustedGrossIncomeInput: round2(Number(federalContext?.income?.adjustedGrossIncome || 0)),
      businessIncomeInput: round2(Number(taxableIncomeContext?.businessTaxableIncome?.finalBusinessTaxableIncome ?? projectionContext?.projectedAnnual?.taxableBusinessIncome ?? 0)),
      stateAdjustments: taxableBase.stateAdjustments,
      stateTaxableIncome: taxableBase.stateTaxableIncome,
    },
    deductions: {
      standardDeduction: taxableBase.standardDeduction,
      standardDeductionDetails: taxableBase.standardDeductionDetails,
      personalExemption: taxableBase.personalExemption,
      personalExemptionDetails: taxableBase.personalExemptionDetails,
      otherSupportedDeductions: 0,
    },
    tax: {
      regularStateIncomeTax: individualIncomeTax.amount,
      passThroughEntityTax: null,
      franchiseTax: entityTax.franchiseTaxAmount,
      sCorpMinimumTax,
      sCorpEntityTax,
      replacementTax: entityTax.replacementTaxAmount,
      localIncomeTax: null,
      ownerLevelBusinessIncomeElection: ownerLevelBusinessIncomeElection.amount,
      capitalGainsExciseTax: capitalGainsExciseTax.amount,
      grossReceiptsTax: businessExcises.grossReceiptsTax.amount,
      payrollExciseTax: businessExcises.payrollExciseTax.amount,
      totalStateTax: totalStateTax.amount,
      knownComponentsAmount: totalStateTax.knownComponentsAmount,
      status: totalStateTax.status,
    },
    individualIncomeTax,
    entityTax,
    businessExcises,
    capitalGainsExciseTax,
    ownerLevelBusinessIncomeElection,
    totalStateTax,
    provisionalReserve,
    withholding: {
      stateWithholdingYtd: round2(stateWithholding),
    },
    range,
    confidence,
    assumptions: [
      "State taxable income uses federal AGI/business income as input and only applies verified state configs available in state_tax_rule_configs.",
      ...configSet.assumptions,
    ],
    warnings: dedupeWarnings(warnings),
    unsupportedItems: ["multi_state_allocation", "local_income_tax", "pte_tax_unless_configured", ...(stateDeductionAdjustmentRule ? [] : ["state_deduction_adjustment"]), ...(entityTax.status === STATE_COMPONENT_STATUSES.PARTIAL ? ["state_entity_tax_caveats"] : [])],
    components: buildComponents({ taxableBase, standardDeductionRule, personalExemptionRule, stateTax, individualIncomeTax, entityTax, ownerLevelBusinessIncomeElection, capitalGainsExciseTax, businessExcises, totalStateTax, provisionalReserve, stateWithholding }),
  };
}

function stateTaxableIncome({ federalContext, taxableIncomeContext, projectionContext, sCorpContext, standardDeductionRule, personalExemptionRule, stateDeductionAdjustmentRule, filingStatus }) {
  const federalAgi = Number(federalContext?.income?.adjustedGrossIncome);
  const business = Number(sCorpContext?.income?.passThroughIncome ?? taxableIncomeContext?.businessTaxableIncome?.finalBusinessTaxableIncome ?? projectionContext?.projectedAnnual?.taxableBusinessIncome ?? 0);
  const base = Number.isFinite(federalAgi) && federalAgi !== 0 ? federalAgi : business;
  const standard = deductionAmountConfig(standardDeductionRule, filingStatus, { federalContext, deductionType: "standard_deduction" });
  const personal = deductionAmountConfig(personalExemptionRule, filingStatus, { federalContext, deductionType: "personal_exemption" });
  const standardCalculationAmount = Number(standard.calculationAmount || 0);
  const personalCalculationAmount = Number(personal.calculationAmount || 0);
  const stateDeductionAdjustment = computeStateDeductionAdjustment({ rule: stateDeductionAdjustmentRule, filingStatus, federalContext });
  const adjustmentAmount = Number(stateDeductionAdjustment.amount || 0);
  return {
    stateTaxableIncome: round2(Math.max(0, base - standardCalculationAmount - personalCalculationAmount + adjustmentAmount)),
    stateAdjustments: round2(adjustmentAmount),
    stateDeductionAdjustment,
    standardDeduction: standard.amount,
    standardDeductionDetails: standard,
    personalExemption: personal.amount,
    personalExemptionDetails: personal,
    hasPartialDeduction: standard.status === STATE_COMPONENT_STATUSES.PARTIAL || personal.status === STATE_COMPONENT_STATUSES.PARTIAL || stateDeductionAdjustment.status === STATE_COMPONENT_STATUSES.PARTIAL,
  };
}

function computeByRule({ rule, taxableIncome, warnings, federalContext, filingStatus }) {
  if (!rule) return { tax: null, kind: "unsupported" };
  const config = rule.config || {};
  if (rule.rule_type === STATE_TAX_RULE_TYPES.NO_INDIVIDUAL_INCOME_TAX || config.kind === "none") {
    return { tax: 0, kind: "none" };
  }
  if (config.kind === "flat") return { tax: round2(taxableIncome * Number(config.rate || 0)), kind: "flat" };
  if (config.kind === "progressive") {
    const computed = computeProgressiveTax({ taxableIncome, brackets: config.brackets });
    return { tax: computed.totalTax, kind: "progressive", bracketBreakdown: computed.bracketBreakdown };
  }
  if (config.kind === "income_classes") return computeIncomeClassTax({ rule, taxableIncome, federalContext, filingStatus });
  if (config.kind === "gross_income_categories") {
    return { tax: null, kind: "gross_income_categories", status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "state_gross_income_categories_required" };
  }
  warnings.push(stateWarning(STATE_TAX_WARNING_CODES.UNSUPPORTED_STATE, "high", "State income tax rule kind is unsupported."));
  return { tax: null, kind: "unsupported" };
}

function computeIncomeClassTax({ rule, taxableIncome, federalContext }) {
  const config = rule.config || {};
  const classInputs = federalContext?.stateIncomeClasses || federalContext?.income?.stateIncomeClasses || null;
  if (config.requiresIncomeClassBreakdown === true && !classInputs) {
    return { tax: null, kind: "income_classes", status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "state_income_class_breakdown_required" };
  }
  const rates = config.ratesByIncomeClass || {};
  const classes = classInputs || { ordinary_income: taxableIncome };
  const details = [];
  let regularTax = 0;
  let surtaxBase = 0;
  for (const [className, rawAmount] of Object.entries(classes)) {
    const amount = Math.max(0, Number(rawAmount || 0));
    if (!amount) continue;
    const rate = Number(rates[className] ?? rates.default ?? 0);
    const deductionPercent = Number(config.deductionsByIncomeClass?.[className]?.deductionPercent || 0);
    const taxableClassAmount = round2(Math.max(0, amount * (1 - deductionPercent)));
    const tax = round2(taxableClassAmount * rate);
    details.push({ className, amount: round2(amount), taxableClassAmount, rate, tax });
    regularTax += tax;
    surtaxBase += taxableClassAmount;
  }
  const surtax = computeSurtax({ config, surtaxBase });
  return { tax: round2(regularTax + surtax.amount), kind: "income_classes", incomeClassBreakdown: details, surtax };
}

function computeSurtax({ config, surtaxBase }) {
  const threshold = finiteOrNull(config.surtax?.threshold);
  const rate = finiteOrNull(config.surtax?.rate);
  if (threshold == null || rate == null) return { amount: 0, taxableBase: 0 };
  const taxable = round2(Math.max(0, Number(surtaxBase || 0) - threshold));
  return { amount: round2(taxable * rate), taxableBase: taxable, threshold, rate };
}

function computeStateDeductionAdjustment({ rule, filingStatus, federalContext }) {
  if (!rule) return { amount: 0, status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE };
  const config = rule.config || {};
  if (config.adjustmentType !== "federal_standard_or_itemized_deduction_addback") {
    return { amount: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "state_deduction_adjustment_type_unsupported", ruleVersion: rule.version };
  }
  if (!filingStatus || filingStatus === "unknown") {
    return { amount: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "filing_status_required_for_state_deduction_addback", ruleVersion: rule.version };
  }
  const federalAgi = finiteOrNull(federalContext?.income?.adjustedGrossIncome);
  const federalDeduction = finiteOrNull(
    federalContext?.deductions?.standardDeduction
    ?? federalContext?.deductions?.itemizedDeduction
    ?? federalContext?.deductions?.federalStandardOrItemizedDeductionAmount
    ?? federalContext?.input?.federalStandardOrItemizedDeductionAmount
  );
  if (federalAgi == null || federalDeduction == null) {
    return { amount: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "federal_agi_and_deduction_required_for_state_deduction_addback", ruleVersion: rule.version };
  }
  const threshold = finiteOrNull(config.appliesWhenFederalAgiExceeds);
  if (threshold == null || federalAgi <= threshold) {
    return { amount: 0, status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE, reasonCode: "state_deduction_addback_threshold_not_exceeded", ruleVersion: rule.version };
  }
  const retainedLimit = finiteOrNull(config.deductionRetainedLimitsByFilingStatus?.[filingStatus]);
  if (retainedLimit == null) {
    return { amount: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "state_deduction_addback_limit_missing", ruleVersion: rule.version };
  }
  const amount = round2(Math.max(0, federalDeduction - retainedLimit));
  return {
    amount,
    status: STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED,
    adjustmentType: config.adjustmentType,
    retainedLimit,
    federalDeduction,
    ruleVersion: rule.version,
  };
}

function computeRange({ rule, projectionContext, federalContext, standardDeductionRule, personalExemptionRule, filingStatus }) {
  const source = projectionContext?.range || null;
  const standard = amountConfig(standardDeductionRule, filingStatus, { federalContext, deductionType: "standard_deduction" });
  const exemption = amountConfig(personalExemptionRule, filingStatus, { federalContext, deductionType: "personal_exemption" });
  const run = (value) => computeByRule({ rule, taxableIncome: Math.max(0, Number(value || 0) - standard - exemption), warnings: [] }).tax;
  if (!rule) return { low: null, base: null, high: null };
  if (!source) {
    const base = federalContext?.income?.adjustedGrossIncome || 0;
    return { low: run(base), base: run(base), high: run(base) };
  }
  return {
    low: run(source.taxableIncomeLow),
    base: run(source.taxableIncomeBase),
    high: run(source.taxableIncomeHigh),
  };
}

function buildOwnerLevelBusinessIncomeElection({ rule, entityContext, sCorpContext }) {
  if (!rule) {
    return {
      status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE,
      amount: null,
      reasonCode: "owner_level_business_income_election_not_elected",
      taxLabel: "owner_level_business_income_election",
    };
  }
  const config = rule.config || {};
  const qualifyingIncome = finiteOrNull(
    sCorpContext?.stateInputs?.qualifyingActiveTradeBusinessIncome
    ?? sCorpContext?.income?.qualifyingActiveTradeBusinessIncome
    ?? entityContext?.entity?.stateInputs?.qualifyingActiveTradeBusinessIncome
  );
  if (qualifyingIncome == null) {
    return {
      status: STATE_COMPONENT_STATUSES.PARTIAL,
      amount: null,
      rate: Number(config.rate || 0),
      reasonCode: "qualifying_active_trade_business_income_segmentation_required",
      ownerLevelElection: true,
      notPassThroughEntityTax: true,
      notEntityTax: true,
      excludedOrSeparateItems: config.excludedOrSeparateItems || [],
      taxLabel: "owner_level_active_trade_business_election",
      ruleVersion: rule.version,
    };
  }
  return {
    status: STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED,
    amount: round2(Math.max(0, qualifyingIncome) * Number(config.rate || 0)),
    taxBase: round2(Math.max(0, qualifyingIncome)),
    rate: Number(config.rate || 0),
    ownerLevelElection: true,
    notPassThroughEntityTax: true,
    notEntityTax: true,
    excludedOrSeparateItems: config.excludedOrSeparateItems || [],
    taxLabel: "owner_level_active_trade_business_election",
    ruleVersion: rule.version,
  };
}

function buildIndividualIncomeTax({ rule, stateTax, taxableBase }) {
  if (!rule) {
    return {
      status: STATE_COMPONENT_STATUSES.UNAVAILABLE,
      amount: null,
      reasonCode: "state_individual_income_tax_rule_unavailable",
      ruleVersion: null,
    };
  }
  if (rule.rule_type === STATE_TAX_RULE_TYPES.NO_INDIVIDUAL_INCOME_TAX || stateTax.kind === "none") {
    return {
      status: STATE_COMPONENT_STATUSES.VERIFIED_ZERO,
      amount: 0,
      reasonCode: rule.config?.individualIncomeTaxStatus === STATE_COMPONENT_STATUSES.VERIFIED_ZERO
        ? "no_broad_individual_income_tax"
        : "no_individual_income_tax",
      ruleVersion: rule.version,
      createsIndividualEstimatedPaymentSchedule: rule.config?.createsIndividualEstimatedPaymentSchedule === true,
      createsIndividualSafeHarbor: rule.config?.createsIndividualSafeHarbor === true,
      userFacingExplanation: rule.config?.userFacingExplanation || "No broad individual earned-income tax.",
    };
  }
  if (taxableBase?.hasPartialDeduction) {
    return {
      status: STATE_COMPONENT_STATUSES.PARTIAL,
      amount: null,
      knownAmount: stateTax.tax,
      reasonCode: "state_deduction_inputs_partial",
      ruleVersion: rule.version,
    };
  }
  if (stateTax.status === STATE_COMPONENT_STATUSES.PARTIAL) {
    return {
      status: STATE_COMPONENT_STATUSES.PARTIAL,
      amount: null,
      knownAmount: stateTax.tax,
      reasonCode: stateTax.reasonCode || "state_individual_income_tax_partial",
      ruleVersion: rule.version,
    };
  }
  if (stateTax.tax != null) {
    return {
      status: STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED,
      amount: stateTax.tax,
      reasonCode: `state_income_tax_${stateTax.kind}`,
      ruleVersion: rule.version,
    };
  }
  return {
    status: STATE_COMPONENT_STATUSES.UNAVAILABLE,
    amount: null,
    reasonCode: "state_individual_income_tax_unsupported",
    ruleVersion: rule.version,
  };
}

function buildEntityTax({ caveatRule, franchiseTaxRule, sCorpEntityTaxRule, sCorpMinimumRule, businessExcises, entityContext, sCorpContext, taxableBase, warnings, stateCode }) {
  const entityPath = entityContext?.entity?.entityPath || "unknown";
  const franchiseTax = computeFranchiseTax({ rule: franchiseTaxRule, entityContext, sCorpContext, stateCode });
  const sCorpEntityTax = computeSCorpEntityTax({ rule: sCorpEntityTaxRule, entityPath, entityContext, sCorpContext, taxableBase });
  const sCorpMinimumTax = computeSCorpMinimumTax({ rule: sCorpMinimumRule, entityPath, entityContext, sCorpContext, taxableBase, stateCode });
  const businessExciseKnownAmount = round2(Number(businessExcises?.grossReceiptsTax?.amount || 0) + Number(businessExcises?.payrollExciseTax?.amount || 0));
  const knownEntityAmount = round2(Number(franchiseTax.amount || 0) + Number(sCorpEntityTax.amount || 0) + Number(sCorpMinimumTax.amount || 0) + businessExciseKnownAmount);
  const hasPartialEntityComponent = [franchiseTax, sCorpEntityTax, sCorpMinimumTax, businessExcises?.grossReceiptsTax, businessExcises?.payrollExciseTax]
    .some((row) => row?.status === STATE_COMPONENT_STATUSES.PARTIAL);
  const caveats = caveatRule?.config?.caveats || [];
  if (caveats.length || hasPartialEntityComponent) {
    warnings.push(stateWarning(STATE_TAX_WARNING_CODES.ENTITY_TAX_CAVEAT, "medium", caveatRule?.config?.userFacingExplanation || "State business/entity taxes may apply but are not fully calculated.", { caveatCodes: caveats.map((row) => row.code).filter(Boolean) }));
    return {
      status: STATE_COMPONENT_STATUSES.PARTIAL,
      amount: null,
      knownAmount: knownEntityAmount,
      franchiseTaxAmount: franchiseTax.amount,
      replacementTaxAmount: sCorpEntityTax.replacementTax === true ? sCorpEntityTax.amount : 0,
      possibleTaxes: caveats.map((row) => row.code).filter(Boolean),
      caveats,
      ruleVersion: caveatRule?.version || franchiseTaxRule?.version || sCorpEntityTaxRule?.version || sCorpMinimumRule?.version || null,
      franchiseTax,
      sCorpEntityTax,
      sCorpMinimumTax,
      businessExcises,
      entityPath,
    };
  }
  if (knownEntityAmount > 0) {
    return {
      status: STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED,
      amount: knownEntityAmount,
      knownAmount: knownEntityAmount,
      franchiseTaxAmount: franchiseTax.amount || 0,
      replacementTaxAmount: sCorpEntityTax.replacementTax === true ? sCorpEntityTax.amount : 0,
      possibleTaxes: [],
      caveats: [],
      ruleVersion: sCorpEntityTaxRule?.version || sCorpMinimumRule?.version || null,
      franchiseTax,
      sCorpEntityTax,
      sCorpMinimumTax,
      businessExcises,
      entityPath,
    };
  }
  return {
    status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE,
    amount: 0,
    knownAmount: 0,
    franchiseTaxAmount: franchiseTax.amount || 0,
    replacementTaxAmount: 0,
    possibleTaxes: [],
    caveats: [],
    ruleVersion: null,
    franchiseTax,
    sCorpEntityTax,
    sCorpMinimumTax,
    businessExcises,
    entityPath,
  };
}

function buildBusinessExcises({ grossReceiptsTaxRule, payrollExciseTaxRule, entityContext, sCorpContext, stateCode }) {
  return {
    grossReceiptsTax: computeGrossReceiptsTax({ rule: grossReceiptsTaxRule, entityContext, sCorpContext, stateCode }),
    payrollExciseTax: computePayrollExciseTax({ rule: payrollExciseTaxRule, entityContext, sCorpContext, stateCode }),
  };
}

function computeGrossReceiptsTax({ rule, entityContext, sCorpContext, stateCode }) {
  if (!rule) return { amount: 0, status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE, ruleVersion: null };
  const config = rule.config || {};
  const stateInputs = mergedStateInputs(entityContext, sCorpContext);
  if (config.requiresStateNexus === true && !hasStateNexusGeneric({ stateCode, stateInputs, entityContext })) {
    return { amount: 0, status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE, reasonCode: "state_nexus_not_present", ruleVersion: rule.version };
  }
  if (stateInputs.nevadaCommerceExemptEntity === true || stateInputs.washingtonBoExemptEntity === true) {
    return { amount: 0, status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE, reasonCode: "business_excise_exempt", ruleVersion: rule.version };
  }
  const grossReceipts = finiteOrNull(stateInputs.nevadaGrossRevenue ?? stateInputs.washingtonGrossReceipts ?? stateInputs.grossReceipts);
  if (grossReceipts == null) {
    return { amount: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "gross_receipts_required_for_business_excise", ruleVersion: rule.version, taxBase: config.taxBase };
  }
  const threshold = finiteOrNull(config.grossRevenueThreshold);
  if (threshold != null && grossReceipts <= threshold) {
    return { amount: 0, status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE, reasonCode: "gross_receipts_threshold_not_exceeded", taxBase: round2(grossReceipts), threshold, ruleVersion: rule.version };
  }
  if (config.industryClassificationRequired === true && !stateInputs.industryClassification) {
    return { amount: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "industry_classification_required_for_business_excise", taxBase: round2(grossReceipts), ruleVersion: rule.version };
  }
  if (config.ratesByClassificationRequired === true || config.rateTableRequired === true || config.rate == null) {
    return { amount: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "classification_rate_required_for_business_excise", taxBase: round2(grossReceipts), ruleVersion: rule.version };
  }
  const amount = round2(Math.max(0, grossReceipts - (threshold || 0)) * Number(config.rate || 0));
  return { amount, status: STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED, taxBase: round2(grossReceipts), rate: Number(config.rate), ruleVersion: rule.version };
}

function computePayrollExciseTax({ rule, entityContext, sCorpContext, stateCode }) {
  if (!rule) return { amount: 0, status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE, ruleVersion: null };
  const config = rule.config || {};
  const stateInputs = mergedStateInputs(entityContext, sCorpContext);
  if (config.requiresStateNexus === true && !hasStateNexusGeneric({ stateCode, stateInputs, entityContext })) {
    return { amount: 0, status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE, reasonCode: "state_nexus_not_present", ruleVersion: rule.version };
  }
  const wages = finiteOrNull(stateInputs.nevadaQuarterlyGrossWages ?? stateInputs.quarterlyGrossWages);
  if (wages == null || wages <= 0) {
    return { amount: 0, status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE, reasonCode: "payroll_wages_not_present", ruleVersion: rule.version };
  }
  const classification = stateInputs.nevadaEmployerClassification || "general_business";
  const financialOrMining = ["financial_institution", "mining"].includes(classification);
  const rate = financialOrMining ? Number(config.financialMiningRate || config.rate || 0) : Number(config.rate || 0);
  const exclusion = financialOrMining ? 0 : Number(config.generalQuarterlyWageExclusion || 0);
  const healthBenefits = finiteOrNull(stateInputs.nevadaHealthBenefitDeduction ?? stateInputs.healthBenefitDeduction) ?? 0;
  const taxableWages = round2(Math.max(0, wages - exclusion - healthBenefits));
  return { amount: round2(taxableWages * rate), status: STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED, taxBase: taxableWages, rate, wageExclusion: exclusion, ruleVersion: rule.version };
}

function computeFranchiseTax({ rule, entityContext, sCorpContext, stateCode }) {
  if (!rule) return { amount: 0, status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE, ruleVersion: null };
  const config = rule.config || {};
  const stateInputs = mergedStateInputs(entityContext, sCorpContext);
  if (config.requiresStateNexus === true && !hasStateNexus({ stateCode, stateInputs, entityContext })) {
    return { amount: 0, status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE, reasonCode: "state_nexus_not_present", ruleVersion: rule.version };
  }
  if (stateInputs.tennesseeExemptEntity === true || stateInputs.entityExemptFromTennesseeFranchiseExcise === true) {
    return { amount: 0, status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE, reasonCode: "tennessee_entity_exempt", ruleVersion: rule.version };
  }
  if (config.requiresEntityApplicability === true && stateInputs.tennesseeEntityApplicabilityConfirmed !== true) {
    return { amount: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "tennessee_entity_applicability_required", ruleVersion: rule.version };
  }
  if (config.requiresExemptionEvaluation === true && stateInputs.tennesseeExemptionEvaluated !== true) {
    return { amount: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "tennessee_exemption_evaluation_required", ruleVersion: rule.version };
  }
  const netWorth = finiteOrNull(stateInputs.tennesseeNetWorth ?? stateInputs.tennesseeApportionedNetWorth);
  if (netWorth == null) {
    return { amount: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "tennessee_net_worth_required", ruleVersion: rule.version };
  }
  const rateTax = round2(Math.max(0, netWorth) * Number(config.rate || 0));
  const minimum = config.minimumTaxAppliesOnlyAfterApplicabilityConfirmed === true
    ? round2(Number(config.minimumAmount || 0))
    : 0;
  return {
    amount: round2(Math.max(rateTax, minimum)),
    status: STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED,
    rateTax,
    minimumTax: minimum,
    taxBase: round2(Math.max(0, netWorth)),
    ruleVersion: rule.version,
  };
}

function hasStateNexus({ stateCode, stateInputs, entityContext }) {
  const nexus = stateInputs.tennesseeNexus ?? stateInputs.stateNexus?.[stateCode] ?? entityContext?.entity?.stateNexus?.[stateCode];
  if (stateCode === "TN" && nexus !== false) return true;
  if (stateCode === "TN" && nexus == null && (entityContext?.entity?.state || entityContext?.entity?.primaryTaxState) === "TN") return true;
  return nexus === true;
}

function hasStateNexusGeneric({ stateCode, stateInputs, entityContext }) {
  const stateKey = String(stateCode || "").toUpperCase();
  const stateNameKeys = { NJ: "newJerseyNexus", MA: "massachusettsNexus", WA: "washingtonNexus", NV: "nevadaNexus", IN: "indianaNexus", TN: "tennesseeNexus" };
  const nexus = stateInputs[stateNameKeys[stateKey]] ?? stateInputs[`${stateKey.toLowerCase()}Nexus`] ?? stateInputs.stateNexus?.[stateKey] ?? entityContext?.entity?.stateNexus?.[stateKey];
  if (nexus != null) return nexus === true;
  return (entityContext?.entity?.state || entityContext?.entity?.primaryTaxState) === stateKey;
}

function mergedStateInputs(entityContext, sCorpContext) {
  return {
    ...(entityContext?.entity?.stateInputs || {}),
    ...(sCorpContext?.stateInputs || {}),
  };
}

function computeCapitalGainsExciseTax({ rule, federalContext }) {
  if (!rule) return { amount: 0, status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE, ruleVersion: null };
  const config = rule.config || {};
  const longTermGains = finiteOrNull(
    federalContext?.stateIncomeClasses?.washingtonLongTermCapitalGains
    ?? federalContext?.income?.stateIncomeClasses?.washingtonLongTermCapitalGains
    ?? federalContext?.input?.washingtonLongTermCapitalGains
  );
  if (longTermGains == null || longTermGains <= 0) {
    return { amount: 0, status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE, reasonCode: "washington_qualifying_long_term_capital_gain_not_present", ruleVersion: rule.version };
  }
  const deduction = finiteOrNull(config.indexedStandardDeductionAmount);
  if (deduction == null) {
    return { amount: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "washington_2026_indexed_capital_gains_deduction_unavailable", taxableWashingtonCapitalGains: null, ruleVersion: rule.version };
  }
  const taxable = round2(Math.max(0, longTermGains - deduction));
  const brackets = config.brackets || [];
  if (!brackets.length) {
    return { amount: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "washington_capital_gains_brackets_required", taxableWashingtonCapitalGains: taxable, ruleVersion: rule.version };
  }
  const computed = computeProgressiveTax({ taxableIncome: taxable, brackets });
  return { amount: computed.totalTax, status: STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED, taxableWashingtonCapitalGains: taxable, bracketBreakdown: computed.bracketBreakdown, ruleVersion: rule.version };
}

function computeSCorpEntityTax({ rule, entityPath, entityContext, sCorpContext, taxableBase }) {
  if (!rule || entityPath !== "s_corporation") return { amount: 0, rateTax: 0, replacementTax: false, exceptionApplied: null, ruleVersion: rule?.version || null };
  const config = rule.config || {};
  const stateInputs = mergedStateInputs(entityContext, sCorpContext);
  const stateCode = String(rule.state_code || "").toUpperCase();
  if (config.requiresStateNexus === true && !hasStateNexusGeneric({ stateCode, stateInputs, entityContext: { entity: { stateInputs } } })) {
    return { amount: 0, rateTax: 0, minimumTax: 0, status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE, reasonCode: "state_nexus_not_present", replacementTax: false, ruleVersion: rule.version };
  }
  if (config.requiresEntityApplicability === true && stateEntityApplicabilityConfirmed({ stateCode, stateInputs }) !== true) {
    return { amount: null, rateTax: null, minimumTax: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "entity_applicability_required_for_s_corp_entity_tax", replacementTax: false, ruleVersion: rule.version };
  }
  if (Array.isArray(config.netIncomeMeasureByReceipts)) {
    return computeSCorpEntityTaxByReceipts({ rule, config, stateInputs });
  }
  const base = sCorpTaxBase({ sCorpContext, taxableBase });
  const rate = config.rate == null ? null : Number(config.rate);
  const rateTax = Number.isFinite(rate) ? round2(base * rate) : 0;
  return {
    amount: rateTax,
    rateTax,
    minimumTax: 0,
    status: STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED,
    taxBase: round2(base),
    rate,
    taxLabel: config.taxLabel || "S-Corp entity tax",
    replacementTax: config.replacementTax === true || config.taxLabel === "personal_property_replacement_tax",
    ruleVersion: rule.version,
  };
}

function computeSCorpEntityTaxByReceipts({ rule, config, stateInputs }) {
  const receipts = finiteOrNull(stateInputs.massachusettsReceipts ?? stateInputs.stateReceipts);
  const netIncomeBase = finiteOrNull(stateInputs.massachusettsNetIncomeBase ?? stateInputs.stateSourceNetIncome);
  const nonIncomeMeasureBase = finiteOrNull(stateInputs.massachusettsNetWorthOrTangiblePropertyBase ?? stateInputs.netWorthOrTangiblePropertyBase);
  if (config.requiresMassachusettsReceipts === true && receipts == null) {
    return { amount: null, rateTax: null, minimumTax: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "massachusetts_receipts_required_for_s_corp_entity_tax", replacementTax: false, ruleVersion: rule.version };
  }
  if (config.requiresMassachusettsNetIncomeBase === true && netIncomeBase == null) {
    return { amount: null, rateTax: null, minimumTax: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "massachusetts_net_income_base_required_for_s_corp_entity_tax", replacementTax: false, ruleVersion: rule.version };
  }
  if (config.nonIncomeMeasureRate != null && nonIncomeMeasureBase == null) {
    return { amount: null, rateTax: null, minimumTax: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "massachusetts_non_income_measure_base_required_for_s_corp_entity_tax", replacementTax: false, ruleVersion: rule.version };
  }
  const netIncomeRate = receiptTierRate(config.netIncomeMeasureByReceipts, receipts);
  const netIncomeTax = round2(Math.max(0, netIncomeBase || 0) * netIncomeRate);
  const nonIncomeTax = round2(Math.max(0, nonIncomeMeasureBase || 0) * Number(config.nonIncomeMeasureRate || 0));
  const minimumTax = round2(Number(config.minimumAmount || 0));
  const amount = round2(Math.max(minimumTax, netIncomeTax + nonIncomeTax));
  return {
    amount,
    rateTax: round2(netIncomeTax + nonIncomeTax),
    minimumTax,
    taxBase: round2(Math.max(0, netIncomeBase || 0)),
    nonIncomeMeasureTaxBase: round2(Math.max(0, nonIncomeMeasureBase || 0)),
    massachusettsReceipts: round2(receipts),
    netIncomeMeasureRate: netIncomeRate,
    status: STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED,
    taxLabel: config.taxName || "Massachusetts S-Corporation excise",
    replacementTax: false,
    ruleVersion: rule.version,
  };
}

function stateEntityApplicabilityConfirmed({ stateCode, stateInputs }) {
  const stateNameKeys = { NJ: "newJerseyEntityApplicabilityConfirmed", MA: "massachusettsEntityApplicabilityConfirmed", TN: "tennesseeEntityApplicabilityConfirmed" };
  return stateInputs[stateNameKeys[stateCode]] ?? stateInputs.entityApplicabilityConfirmed;
}

function receiptTierRate(schedule, receipts) {
  const row = schedule.find((item) => receipts >= Number(item.minimumInclusive ?? item.from ?? 0) && (item.maximumExclusive == null && item.to == null || receipts < Number(item.maximumExclusive ?? item.to)));
  return Number(row?.rate || 0);
}

function computeSCorpMinimumTax({ rule, entityPath, entityContext, sCorpContext, taxableBase, stateCode }) {
  if (!rule || entityPath !== "s_corporation") return { amount: 0, rateTax: 0, minimumTax: 0, exceptionApplied: null, ruleVersion: rule?.version || null };
  const config = rule.config || {};
  const stateInputs = mergedStateInputs(entityContext, sCorpContext);
  if (config.requiresStateNexus === true && !hasStateNexusGeneric({ stateCode, stateInputs, entityContext })) {
    return { amount: 0, status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE, reasonCode: "state_nexus_not_present", ruleVersion: rule.version };
  }
  if (config.requiresEntityApplicability === true && stateInputs.entityApplicabilityConfirmed !== true && stateInputs.newJerseyEntityApplicabilityConfirmed !== true) {
    return { amount: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "entity_applicability_required_for_s_corp_minimum_tax", ruleVersion: rule.version };
  }
  if (sCorpContext?.stateInputs?.noBusinessShortYear15Days === true) {
    return { amount: 0, rateTax: 0, minimumTax: 0, exceptionApplied: "no_business_short_year_15_day_exception", ruleVersion: rule.version };
  }
  if (Array.isArray(config.grossReceiptsMinimumSchedule)) {
    const grossReceipts = finiteOrNull(stateInputs.newJerseyGrossReceipts ?? stateInputs.stateGrossReceipts ?? stateInputs.grossReceipts);
    if (grossReceipts == null) {
      return { amount: null, status: STATE_COMPONENT_STATUSES.PARTIAL, reasonCode: "gross_receipts_required_for_s_corp_minimum_tax", ruleVersion: rule.version };
    }
    const override = config.affiliatedControlledGroupOverride || {};
    const payroll = finiteOrNull(stateInputs.newJerseyCombinedGroupPayroll ?? stateInputs.combinedGroupPayroll);
    const groupOverride = stateInputs.affiliatedControlledGroup === true
      && payroll != null
      && payroll >= Number(override.totalPayrollThreshold || Infinity);
    const scheduled = groupOverride
      ? Number(override.minimumAmount || 0)
      : scheduledMinimumAmount(config.grossReceiptsMinimumSchedule, grossReceipts);
    return {
      amount: round2(scheduled),
      rateTax: 0,
      minimumTax: round2(scheduled),
      taxBase: round2(grossReceipts),
      exceptionApplied: groupOverride ? "affiliated_controlled_group_override" : null,
      status: STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED,
      ruleVersion: rule.version,
    };
  }
  const base = sCorpTaxBase({ sCorpContext, taxableBase });
  const rate = config.rate == null ? null : Number(config.rate);
  const rateTax = Number.isFinite(rate) ? round2(base * rate) : 0;
  const firstYearException = sCorpContext?.stateInputs?.firstYearException === true || sCorpContext?.stateInputs?.californiaFirstYearException === true;
  const minimumTax = firstYearException ? 0 : round2(Number(config.minimumAmount ?? config.amount ?? 0));
  return {
    amount: round2(Math.max(rateTax, minimumTax)),
    rateTax,
    minimumTax,
    taxBase: round2(base),
    rate,
    exceptionApplied: firstYearException ? "first_year_minimum_franchise_tax_exception" : null,
    ruleVersion: rule.version,
  };
}

function scheduledMinimumAmount(schedule, grossReceipts) {
  const row = schedule.find((item) => grossReceipts >= Number(item.minimumInclusive ?? item.from ?? 0) && (item.maximumExclusive == null && item.to == null || grossReceipts < Number(item.maximumExclusive ?? item.to)));
  return Number(row?.amount || 0);
}

function sCorpTaxBase({ sCorpContext, taxableBase }) {
  return Math.max(0, Number(
    sCorpContext?.stateInputs?.stateSourceNetIncome
    ?? sCorpContext?.income?.stateSourceNetIncome
    ?? sCorpContext?.income?.passThroughIncome
    ?? taxableBase?.stateTaxableIncome
    ?? 0
  ));
}

function buildTotalStateTax({ individualIncomeTax, entityTax }) {
  const knownComponentsAmount = round2(Number(individualIncomeTax.amount || 0) + Number(entityTax.knownAmount || 0));
  const individualKnown = [STATE_COMPONENT_STATUSES.VERIFIED_ZERO, STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED].includes(individualIncomeTax.status);
  const entityKnown = [STATE_COMPONENT_STATUSES.VERIFIED_ZERO, STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED, STATE_COMPONENT_STATUSES.NOT_APPLICABLE].includes(entityTax.status);
  if (individualKnown && entityKnown) {
    return { status: STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED, amount: knownComponentsAmount, knownComponentsAmount };
  }
  if (individualKnown || knownComponentsAmount > 0) {
    return { status: STATE_COMPONENT_STATUSES.PARTIAL, amount: null, knownComponentsAmount };
  }
  return { status: STATE_COMPONENT_STATUSES.UNAVAILABLE, amount: null, knownComponentsAmount };
}

async function computeProvisionalStateReserve({ supabase, stateCode, taxYear, taxableBase, totalStateTax, asOfDate }) {
  if (totalStateTax.status === STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED && totalStateTax.amount != null) {
    return {
      status: "not_applied",
      amount: 0,
      isLiabilityEstimate: false,
      reasonCode: "verified_state_liability_available",
    };
  }
  const policy = await loadUnsupportedStateReservePolicy({ supabase, taxYear, asOfDate });
  if (!policy) {
    return { status: "unavailable", amount: null, isLiabilityEstimate: false, reasonCode: "provisional_policy_missing" };
  }
  const income = Number(taxableBase.stateTaxableIncome || 0);
  const applicableIncome = policy.applyOnlyToPositiveProjectedIncome === false ? income : Math.max(0, income);
  const baseReserve = round2(applicableIncome * Number(policy.baseReserveRate || 0));
  const uncertaintyBuffer = round2(applicableIncome * Number(policy.uncertaintyBufferRate || 0));
  const amount = round2(baseReserve + uncertaintyBuffer);
  return {
    status: "available",
    policyCode: policy.policyCode,
    amount,
    baseReserve,
    uncertaintyBuffer,
    recommendedReserveRate: round2(Number(policy.recommendedReserveRate || 0)),
    displayRangeLow: policy.displayRangeLow,
    displayRangeHigh: policy.displayRangeHigh,
    taxableIncomeBase: applicableIncome,
    isLiabilityEstimate: false,
    reserveOnly: true,
    createsSafeHarbor: false,
    createsPaymentSchedule: false,
    label: policy.label || "Provisional state reserve estimate",
    disclaimer: policy.disclaimer || "This is conservative reserve guidance, not a calculated state tax liability.",
  };
}

async function loadUnsupportedStateReservePolicy({ supabase, taxYear, asOfDate }) {
  const fallback = defaultUnsupportedStateReservePolicy();
  try {
    const { data, error } = await supabase
      .from("tax_reserve_policy_configs")
      .select("*")
      .eq("policy_code", "unsupported_state_provisional_reserve_v1")
      .eq("tax_year", taxYear)
      .eq("is_active", true)
      .limit(1);
    if (error) return fallback;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return fallback;
    const effective = (!row.effective_from || String(row.effective_from).slice(0, 10) <= String(asOfDate || `${taxYear}-12-31`).slice(0, 10))
      && (!row.effective_to || String(row.effective_to).slice(0, 10) >= String(asOfDate || `${taxYear}-12-31`).slice(0, 10));
    return effective ? { ...fallback, ...(row.config || {}) } : fallback;
  } catch {
    return fallback;
  }
}

function defaultUnsupportedStateReservePolicy() {
  return {
    policyCode: "unsupported_state_provisional_reserve_v1",
    liabilityStatus: "unavailable",
    reserveStatus: "provisional",
    baseReserveRate: 0.07,
    uncertaintyBufferRate: 0.02,
    recommendedReserveRate: 0.09,
    displayRangeLow: 0.06,
    displayRangeHigh: 0.12,
    taxableIncomeFloor: 0,
    applyOnlyToPositiveProjectedIncome: true,
    createsSafeHarbor: false,
    createsPaymentSchedule: false,
    createsTaxLiability: false,
    overriddenByVerifiedStateRule: true,
    label: "Provisional state reserve estimate",
    disclaimer: "This is conservative reserve guidance, not a calculated state tax liability.",
  };
}

async function optionalStateRule({ supabase, taxYear, stateCode, ruleType, filingStatus, entityContext, asOfDate }) {
  try {
    return await getStateTaxRuleConfig({
      supabase,
      taxYear,
      stateCode,
      ruleType,
      filingStatus,
      entityType: entityContext?.entity?.entityType,
      entityPath: entityContext?.entity?.entityPath,
      taxElection: entityContext?.entity?.taxElection,
      ptetElection: entityContext?.entity?.ptetElection,
      stateElection: stateElectionEnabled(entityContext),
      asOfDate,
      minimumSupportLevel: TAX_RULE_SUPPORT_LEVELS.SUPPORTED,
    });
  } catch {
    return null;
  }
}

function stateElectionEnabled(entityContext) {
  const entity = entityContext?.entity || {};
  const stateInputs = entity.stateInputs || {};
  return entity.stateElection === true
    || entity.activeTradeBusinessElection === true
    || entity.scActiveTradeBusinessElection === true
    || stateInputs.stateBusinessIncomeElection === true
    || stateInputs.activeTradeBusinessElection === true
    || stateInputs.scActiveTradeBusinessElection === true;
}

function amountConfig(rule, filingStatus, context = {}) {
  const config = deductionAmountConfig(rule, filingStatus, context);
  return config.calculationAmount ?? config.amount ?? 0;
}

function deductionAmountConfig(rule, filingStatus, context = {}) {
  const config = rule?.config || {};
  const notApplicable = config.notApplicable === true;
  if (notApplicable) {
    return {
      amount: null,
      calculationAmount: 0,
      status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE,
      notApplicable: true,
      label: "Not applicable",
      ruleVersion: rule?.version || null,
    };
  }
  if (context.deductionType === "personal_exemption" && config.eligibilityMethod === "federal_agi_cutoff") {
    return personalExemptionCutoffAmount({ rule, config, filingStatus, federalContext: context.federalContext });
  }
  if (filingStatus && config.amountByFilingStatus && config.amountByFilingStatus[filingStatus] != null) {
    const amount = round2(Number(config.amountByFilingStatus[filingStatus]));
    return {
      amount,
      calculationAmount: amount,
      status: STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED,
      notApplicable: false,
      label: null,
      ruleVersion: rule?.version || null,
    };
  }
  const amount = config.amount == null && config.baseAmount == null ? null : round2(Number(config.amount ?? config.baseAmount));
  if (rule && amount == null && config.supportStatus === "known_rule_2026_value_unavailable") {
    return {
      amount: null,
      calculationAmount: 0,
      status: STATE_COMPONENT_STATUSES.PARTIAL,
      notApplicable: false,
      label: config.userFacingUnavailableMessage || "Current-year deduction amount unavailable",
      supportStatus: config.supportStatus,
      ruleVersion: rule?.version || null,
    };
  }
  return {
    amount,
    calculationAmount: amount ?? 0,
    status: rule && amount != null ? STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED : rule ? STATE_COMPONENT_STATUSES.UNAVAILABLE : STATE_COMPONENT_STATUSES.UNAVAILABLE,
    notApplicable: false,
    label: null,
    ruleVersion: rule?.version || null,
  };
}

function personalExemptionCutoffAmount({ rule, config, filingStatus, federalContext }) {
  if (!filingStatus || filingStatus === "unknown") {
    return partialDeduction({ rule, reasonCode: "filing_status_required_for_state_personal_exemption" });
  }
  const federalAgi = finiteOrNull(federalContext?.income?.adjustedGrossIncome);
  if (federalAgi == null) {
    return partialDeduction({ rule, reasonCode: "federal_agi_required_for_state_personal_exemption" });
  }
  const cutoff = finiteOrNull(config.agiCutoffsByFilingStatus?.[filingStatus] ?? config.agiCutoffsByFilingStatus?.default);
  if (cutoff == null) {
    return partialDeduction({ rule, reasonCode: "state_personal_exemption_cutoff_missing" });
  }
  if (federalAgi > cutoff) {
    const amount = round2(Number(config.amountAboveCutoff ?? 0));
    return {
      amount,
      calculationAmount: amount,
      status: amount === 0 ? STATE_COMPONENT_STATUSES.VERIFIED_ZERO : STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED,
      notApplicable: false,
      eligibilityMethod: config.eligibilityMethod,
      cutoff,
      cutoffExceeded: true,
      ruleVersion: rule?.version || null,
    };
  }
  const baseAmount = round2(Number(config.amount || 0) * personalExemptionUnitCount({ filingStatus, federalContext }));
  const seniorBlindAmount = round2(Number(config.additionalSeniorOrBlindAmount || 0) * explicitSeniorBlindCount({ filingStatus, federalContext }));
  const dependentAmount = round2(Number(config.amount || 0) * explicitDependentCount({ federalContext }));
  const amount = round2(baseAmount + seniorBlindAmount + dependentAmount);
  return {
    amount,
    calculationAmount: amount,
    status: STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED,
    notApplicable: false,
    eligibilityMethod: config.eligibilityMethod,
    cutoff,
    cutoffExceeded: false,
    baseAmount,
    seniorBlindAmount,
    dependentAmount,
    ruleVersion: rule?.version || null,
  };
}

function partialDeduction({ rule, reasonCode }) {
  return {
    amount: null,
    calculationAmount: 0,
    status: STATE_COMPONENT_STATUSES.PARTIAL,
    notApplicable: false,
    reasonCode,
    ruleVersion: rule?.version || null,
  };
}

function personalExemptionUnitCount({ filingStatus, federalContext }) {
  if (federalContext?.input?.taxpayerClaimedAsDependent === true) {
    return 0;
  }
  if (filingStatus === "married_filing_jointly") {
    const spouseClaimed = federalContext?.input?.spouseClaimedAsDependent === true;
    return spouseClaimed ? 1 : 2;
  }
  return 1;
}

function explicitSeniorBlindCount({ filingStatus, federalContext }) {
  const input = federalContext?.input || {};
  let count = 0;
  if (input.taxpayerSenior === true) count += 1;
  if (input.taxpayerBlind === true) count += 1;
  if (filingStatus === "married_filing_jointly") {
    if (input.spouseSenior === true) count += 1;
    if (input.spouseBlind === true) count += 1;
  }
  return count;
}

function explicitDependentCount({ federalContext }) {
  const count = finiteOrNull(federalContext?.input?.illinoisDependentExemptionCount);
  return count == null ? 0 : Math.max(0, count);
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ruleVersions(rules) {
  return Object.fromEntries(rules.filter(Boolean).map((rule) => [rule.rule_type, rule.version]));
}

function buildComponents({ taxableBase, stateTax, individualIncomeTax, entityTax, ownerLevelBusinessIncomeElection, capitalGainsExciseTax, businessExcises, totalStateTax, provisionalReserve, stateWithholding }) {
  return [
    component(STATE_TAX_COMPONENTS.STATE_TAXABLE_INCOME, taxableBase.stateTaxableIncome),
    component(STATE_TAX_COMPONENTS.STATE_STANDARD_DEDUCTION, negativeOrNull(taxableBase.standardDeduction), taxableBase.standardDeductionDetails),
    component(STATE_TAX_COMPONENTS.STATE_PERSONAL_EXEMPTION, negativeOrNull(taxableBase.personalExemption), taxableBase.personalExemptionDetails),
    component(STATE_TAX_COMPONENTS.STATE_DEDUCTION_ADJUSTMENT, taxableBase.stateDeductionAdjustment?.amount ?? null, taxableBase.stateDeductionAdjustment),
    component(stateTax.kind === "progressive" ? STATE_TAX_COMPONENTS.STATE_PROGRESSIVE_TAX : stateTax.kind === "none" ? STATE_TAX_COMPONENTS.NO_INDIVIDUAL_INCOME_TAX : STATE_TAX_COMPONENTS.STATE_FLAT_TAX, individualIncomeTax.amount, { status: individualIncomeTax.status, reasonCode: individualIncomeTax.reasonCode }),
    component(STATE_TAX_COMPONENTS.ENTITY_TAX_CAVEAT, entityTax.amount, { status: entityTax.status, possibleTaxes: entityTax.possibleTaxes }),
    component(STATE_TAX_COMPONENTS.STATE_FRANCHISE_TAX, entityTax.franchiseTax?.amount ?? null, entityTax.franchiseTax || { status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE }),
    component(STATE_TAX_COMPONENTS.STATE_CAPITAL_GAINS_EXCISE_TAX, capitalGainsExciseTax?.amount ?? null, capitalGainsExciseTax || { status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE }),
    component(STATE_TAX_COMPONENTS.STATE_GROSS_RECEIPTS_TAX, businessExcises?.grossReceiptsTax?.amount ?? null, businessExcises?.grossReceiptsTax || { status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE }),
    component(STATE_TAX_COMPONENTS.STATE_PAYROLL_EXCISE_TAX, businessExcises?.payrollExciseTax?.amount ?? null, businessExcises?.payrollExciseTax || { status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE }),
    component(STATE_TAX_COMPONENTS.OWNER_LEVEL_BUSINESS_INCOME_ELECTION, ownerLevelBusinessIncomeElection?.amount ?? null, ownerLevelBusinessIncomeElection || { status: STATE_COMPONENT_STATUSES.NOT_APPLICABLE }),
    component(STATE_TAX_COMPONENTS.S_CORP_ENTITY_TAX, entityTax.sCorpEntityTax?.amount || 0, { status: entityTax.sCorpEntityTax?.amount > 0 ? STATE_COMPONENT_STATUSES.VERIFIED_CALCULATED : STATE_COMPONENT_STATUSES.NOT_APPLICABLE, taxLabel: entityTax.sCorpEntityTax?.taxLabel || null, replacementTax: entityTax.sCorpEntityTax?.replacementTax === true }),
    component(STATE_TAX_COMPONENTS.S_CORP_MINIMUM_TAX, entityTax.sCorpMinimumTax?.amount || 0),
    component(STATE_TAX_COMPONENTS.LOCAL_INCOME_TAX, null, { status: STATE_COMPONENT_STATUSES.DEFERRED }),
    component(STATE_TAX_COMPONENTS.PROVISIONAL_STATE_RESERVE, provisionalReserve?.amount ?? null, { status: provisionalReserve?.status, isLiabilityEstimate: false }),
    component(STATE_TAX_COMPONENTS.STATE_WITHHOLDING, stateWithholding),
  ];
}

function negativeOrNull(value) {
  return value == null ? null : -value;
}

function emptyStateResult({ stateCode, taxYear, filingStatus, entityContext, warnings, blockers }) {
  return {
    meta: { stateCode, taxYear, filingStatus, entityPath: entityContext?.entity?.entityPath || "unknown", engineVersion: TAX_STATE_ENGINE_VERSION, ruleVersions: {}, supportSummary: { supportLevel: "unsupported", ruleCount: 0 } },
    income: { federalAdjustedGrossIncomeInput: 0, businessIncomeInput: 0, stateAdjustments: 0, stateTaxableIncome: null },
    deductions: { standardDeduction: 0, personalExemption: 0, otherSupportedDeductions: 0 },
    tax: { regularStateIncomeTax: null, passThroughEntityTax: null, franchiseTax: null, sCorpMinimumTax: null, localIncomeTax: null, totalStateTax: null, knownComponentsAmount: 0, status: STATE_COMPONENT_STATUSES.UNAVAILABLE },
    individualIncomeTax: { status: STATE_COMPONENT_STATUSES.UNAVAILABLE, amount: null },
    entityTax: { status: STATE_COMPONENT_STATUSES.UNAVAILABLE, amount: null, possibleTaxes: [] },
    totalStateTax: { status: STATE_COMPONENT_STATUSES.UNAVAILABLE, amount: null, knownComponentsAmount: 0 },
    provisionalReserve: { status: "unavailable", amount: null, isLiabilityEstimate: false },
    withholding: { stateWithholdingYtd: 0 },
    range: { low: 0, base: 0, high: 0 },
    confidence: computeStateTaxConfidence({ stateCode, blockers }),
    assumptions: [],
    warnings,
    unsupportedItems: ["state_tax"],
    components: [],
    blockers,
  };
}

function component(componentType, amount, extra = {}) {
  return { componentType, amount: amount == null ? null : round2(amount), ...extra };
}

function dedupeWarnings(warnings) {
  const seen = new Set();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
