// /src/services/tax/orchestrator/taxOrchestrator.js
import { TAX_CALCULATION_TYPES, TAX_TRIGGER_SOURCES, normalizeDateOnly, normalizeTaxYear } from "../taxDomain.js";
import { taxCalculationError, validationError } from "../taxErrors.js";
import { TAX_ORCHESTRATOR_ENGINE_VERSION } from "../taxEngineVersions.js";
import { getTaxProfile, computeTaxProfileCompleteness } from "../taxProfile.service.js";
import { getActiveTaxMemories } from "../taxProfileMemory.service.js";
import { computeTaxDeductionsSummary } from "../taxDeductionsEngine.js";
import { computeTaxableIncome } from "../taxableIncome/taxableIncomeEngine.js";
import { projectAnnualTaxableIncome } from "../projection/annualProjectionEngine.js";
import { evaluateTaxEntity } from "../entity/entityEngine.js";
import { ENTITY_PATHS } from "../entity/entityDomain.js";
import { computeSelfEmploymentTax } from "../selfEmployment/selfEmploymentTaxEngine.js";
import { computeSCorpTaxContext } from "../sCorp/sCorpEngine.js";
import { computeFederalIncomeTax } from "../federal/federalTaxEngine.js";
import { computeStateTax } from "../state/stateTaxEngine.js";
import { summarizeTaxPayments } from "../payments/taxPayment.service.js";
import { computeSafeHarbor } from "../payments/safeHarborEngine.js";
import { buildTaxDeadlines } from "../payments/taxDeadlineEngine.js";
import { getTaxRuleConfig } from "../taxRuleConfig.repository.js";
import { getStateTaxRuleConfig } from "../stateTaxRule.repository.js";
import { FEDERAL_TAX_RULE_TYPES, STATE_TAX_RULE_TYPES } from "../taxRuleTypes.js";
import { computeCanonicalTaxConfidence } from "../confidence/taxConfidenceEngine.js";
import { computeTaxReserve, persistTaxReserveSnapshot } from "../reserve/taxReserveEngine.js";
import { resolveTaxReservePolicy } from "../reserve/taxReservePolicy.service.js";
import { buildTaxRunFingerprint } from "../runs/taxRunFingerprint.js";
import { createTaxRunSkeleton, findRunByFingerprint, listRunningTaxRunsForCalculation, markTaxRunAbandoned, markTaxRunFailed } from "../runs/taxRun.repository.js";
import { persistCanonicalTaxCalculation } from "../runs/taxRunPersistence.service.js";
import { TAX_RUN_COMPLETION_TYPES, TAX_RUN_STATUSES, TAX_RUN_SUPERSESSION_REASONS } from "../runs/taxRunDomain.js";
import { emitTaxDataChanged } from "../taxChangeEvents.js";
import { computeTaxAttributableThroughDate } from "../throughDate/throughDateTaxAttribution.js";

export async function runCanonicalTaxCalculation({
  supabase,
  businessId,
  taxYear,
  year,
  asOfDate,
  calculationType = TAX_CALCULATION_TYPES.FULL_ESTIMATE,
  projectionMethod = "blended",
  projectionScenario = "base",
  manualOverrides = null,
  triggerSource = TAX_TRIGGER_SOURCES.MANUAL,
  userId = null,
  persistRun = true,
  force = false,
  requestId = null,
  completionType = null,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const normalizedYear = normalizeTaxYear(taxYear ?? year);
  if (!normalizedYear) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  const cutoff = normalizeDateOnly(asOfDate) || new Date().toISOString().slice(0, 10);
  let runId = null;
  let supersedesRunId = null;
  let fingerprint = null;

  try {
    const profile = await getTaxProfile({ supabase, businessId, taxYear: normalizedYear, includeBusinessDefaults: false });
    fingerprint = buildTaxRunFingerprint({
      businessId,
      taxYear: normalizedYear,
      asOfDate: cutoff,
      calculationType,
      projectionMethod,
      projectionScenario,
      triggerSource,
      profileVersion: profile?.updated_at || profile?.created_at || profile?.id || null,
      sourceFreshness: {},
      engineVersions: { orchestrator: TAX_ORCHESTRATOR_ENGINE_VERSION },
      ruleVersions: {},
      manualOverrides,
    });
    if (persistRun) {
      const existing = await findRunByFingerprint({ supabase, businessId, taxYear: normalizedYear, fingerprint });
      if (existing && !force) {
        if ([TAX_RUN_STATUSES.COMPLETED, TAX_RUN_STATUSES.PARTIAL].includes(existing.status)) {
          return canonicalFromPersistedRun(existing, { reusedExistingRun: true, fingerprint });
        }
        if (existing.status === TAX_RUN_STATUSES.RUNNING && !isStaleRun(existing)) {
          return canonicalFromPersistedRun(existing, { reusedExistingRun: true, fingerprint, persistenceStatus: "running" });
        }
        if (existing.status === TAX_RUN_STATUSES.RUNNING && isStaleRun(existing)) {
          await markTaxRunAbandoned({ supabase, businessId, runId: existing.id, reason: "stale_source_data" });
        }
      } else if (existing && force && [TAX_RUN_STATUSES.COMPLETED, TAX_RUN_STATUSES.PARTIAL].includes(existing.status)) {
        supersedesRunId = existing.id;
      }
      if (!existing) {
        await abandonStaleRunningCalculations({
          supabase,
          businessId,
          taxYear: normalizedYear,
          asOfDate: cutoff,
          calculationType,
        });
      }
      const skeleton = await createTaxRunSkeleton({
        supabase,
        businessId,
        taxProfileId: profile?.id || null,
        taxYear: normalizedYear,
        asOfDate: cutoff,
        calculationType,
        triggerSource,
        calculationVersion: TAX_ORCHESTRATOR_ENGINE_VERSION,
        completionType: completionType || (manualOverrides ? TAX_RUN_COMPLETION_TYPES.SCENARIO : TAX_RUN_COMPLETION_TYPES.AUTHORITATIVE),
        fingerprint,
        requestId,
        expectedComponentCount: 0,
        metadata: { calculationPayloadVersion: TAX_ORCHESTRATOR_ENGINE_VERSION },
      });
      runId = skeleton?.id || null;
    }
    const completeness = computeTaxProfileCompleteness(profile);
    const memories = await safeMemories({ supabase, businessId, asOfDate: cutoff });
    const entityContext = await evaluateTaxEntity({ supabase, businessId, taxYear: normalizedYear, asOfDate: cutoff, profile, memories });
    if (entityContext.blockers?.length) {
      throw taxCalculationError("entity_context_unavailable", "Entity setup blocks authoritative tax calculation.", { blockers: entityContext.blockers });
    }
    const [taxableIncome, deductions, projection] = await Promise.all([
      computeTaxableIncome({ supabase, businessId, taxYear: normalizedYear, asOfDate: cutoff, calculationType: "ytd_actual", manualOverrides }),
      computeTaxDeductionsSummary({ supabase, businessId, taxYear: normalizedYear, asOfDate: cutoff }),
      projectAnnualTaxableIncome({ supabase, businessId, taxYear: normalizedYear, asOfDate: cutoff, method: projectionMethod, scenario: projectionScenario, manualOverrides }),
    ]);

    const entityPath = entityContext.entity.entityPath;
    let seTax = null;
    let sCorp = null;
    let annualBusinessIncomeForFederal = projection.projectedAnnual.taxableBusinessIncome;
    let otherIncome = null;
    let aboveTheLineAdjustments = 0;
    if ([ENTITY_PATHS.SOLE_PROPRIETOR, ENTITY_PATHS.SINGLE_MEMBER_LLC_DISREGARDED].includes(entityPath)) {
      seTax = await computeSelfEmploymentTax({
        supabase,
        businessId,
        taxYear: normalizedYear,
        asOfDate: cutoff,
        entityContext,
        annualNetBusinessIncome: projection.projectedAnnual.taxableBusinessIncome,
        annualNetBusinessIncomeRange: {
          low: projection.range.taxableIncomeLow,
          base: projection.range.taxableIncomeBase,
          high: projection.range.taxableIncomeHigh,
        },
      });
      aboveTheLineAdjustments = seTax.federalAdjustmentOutput.amount;
    } else if (entityPath === ENTITY_PATHS.S_CORPORATION) {
      sCorp = await computeSCorpTaxContext({ supabase, businessId, taxYear: normalizedYear, asOfDate: cutoff, entityContext, taxableIncomeContext: taxableIncome, projectionContext: projection });
      annualBusinessIncomeForFederal = sCorp.income.passThroughIncome;
      otherIncome = { amount: Number(sCorp.wages.projectedOwnerW2Wages || 0) };
    }

    const federal = await computeFederalIncomeTax({
      supabase,
      businessId,
      taxYear: normalizedYear,
      asOfDate: cutoff,
      filingStatus: profile?.filing_status,
      entityType: profile?.entity_type,
      annualBusinessTaxableIncome: annualBusinessIncomeForFederal,
      annualBusinessTaxableIncomeRange: {
        low: projection.range.taxableIncomeLow,
        base: annualBusinessIncomeForFederal,
        high: projection.range.taxableIncomeHigh,
      },
      otherIncome,
      aboveTheLineAdjustments,
      qbiDeduction: 0,
    });

    const state = await computeStateBestEffort({ supabase, businessId, taxYear: normalizedYear, asOfDate: cutoff, profile, entityContext, federal, taxableIncome, projection, sCorp });
    const payments = await summarizeTaxPayments({ supabase, businessId, taxYear: normalizedYear, profile });
    const federalSafeHarborConfig = await optionalFederalRule({ supabase, taxYear: normalizedYear, ruleType: FEDERAL_TAX_RULE_TYPES.ESTIMATED_TAX_SAFE_HARBOR, filingStatus: profile?.filing_status, entityType: profile?.entity_type, asOfDate: cutoff });
    const federalDueDateConfig = await optionalFederalRule({ supabase, taxYear: normalizedYear, ruleType: FEDERAL_TAX_RULE_TYPES.ESTIMATED_TAX_DUE_DATES, filingStatus: profile?.filing_status, entityType: profile?.entity_type, asOfDate: cutoff });
    const stateSafeHarborConfig = await optionalStateRule({ supabase, taxYear: normalizedYear, stateCode: profile?.primary_tax_state, ruleType: STATE_TAX_RULE_TYPES.ESTIMATED_TAX_SAFE_HARBOR, filingStatus: profile?.filing_status, entityType: profile?.entity_type, asOfDate: cutoff });
    const stateDueDateConfig = await optionalStateRule({ supabase, taxYear: normalizedYear, stateCode: profile?.primary_tax_state, ruleType: STATE_TAX_RULE_TYPES.ESTIMATED_TAX_DUE_DATES, filingStatus: profile?.filing_status, entityType: profile?.entity_type, asOfDate: cutoff });
    const totalFederalTax = round2(federal.tax.federalIncomeTax + Number(seTax?.result?.totalSelfEmploymentTax || 0));
    const stateTaxKnown = state.tax.totalStateTax != null;
    const totalStateTax = stateTaxKnown ? round2(state.tax.totalStateTax) : null;
    const knownStateComponentsAmount = round2(state.tax.knownComponentsAmount || 0);
    const safeHarbor = computeSafeHarbor({
      currentProjectedFederalTax: totalFederalTax,
      currentProjectedStateTax: totalStateTax,
      priorYearTotalTax: profile?.prior_year_total_tax,
      priorYearAgi: profile?.prior_year_agi,
      filingStatus: profile?.filing_status,
      safeHarborMethod: profile?.safe_harbor_method,
      federalSafeHarborConfig,
      stateSafeHarborConfig,
      federalDueDateConfig,
      stateDueDateConfig,
      payments,
      withholding: { federal: payments.federal.withholding, state: payments.state.withholding },
      asOfDate: cutoff,
      taxYear: normalizedYear,
    });
    const deadlines = buildTaxDeadlines({ businessId, taxYear: normalizedYear, federalDueDateConfig, stateDueDateConfig, entityContext, asOfDate: cutoff });
    const projectedTotalTax = round2(totalFederalTax + (totalStateTax ?? knownStateComponentsAmount));
    const paymentsAndWithholdingYtd = payments.totals.totalPaidAndWithheld;
    const remainingProjectedLiability = round2(Math.max(0, projectedTotalTax - paymentsAndWithholdingYtd));
    const projectedOverpayment = round2(Math.max(0, paymentsAndWithholdingYtd - projectedTotalTax));
    const throughDateTaxAttribution = computeTaxAttributableThroughDate({
      taxYear: normalizedYear,
      asOfDate: cutoff,
      projection,
      taxableIncome,
      federal: { incomeTax: federal },
      selfEmploymentTax: seTax,
      sCorp,
      state: { incomeTax: state, individualIncomeTax: state.individualIncomeTax },
      projectedTotalTax,
      totalFederalTax,
      totalStateTax,
      knownStateComponentsAmount,
    });
    const warnings = collectWarnings([completeness.warnings, entityContext.warnings, taxableIncome.warnings, projection.warnings, federal.warnings, seTax?.warnings, sCorp?.warnings, state.warnings, payments.reconciliationWarnings, safeHarbor.federal.warnings, safeHarbor.state.warnings]);
    warnings.push({ code: "qbi_not_applied", severity: "medium", message: "QBI remains deferred and was not applied." });
    const result = {
      meta: {
        businessId,
        taxYear: normalizedYear,
        asOfDate: cutoff,
        calculationType,
        triggerSource,
        engineVersions: engineVersions({ entityContext, taxableIncome, projection, federal, seTax, sCorp, state }),
        generatedAt: new Date().toISOString(),
        runId,
        status: "partial",
        fingerprint,
        reusedExistingRun: false,
        persistenceStatus: persistRun ? "running" : "not_requested",
        supersedesRunId,
        sourceFreshness: taxableIncome.meta?.sourceFreshness || {},
      },
      profile: { profile, completeness, entityContext },
      actuals: { taxableIncome, deductions, revenue: taxableIncome.revenue, coverage: taxableIncome.coverage },
      projection: { method: projection.meta.method, actual: projection.actual, projectedFuture: projection.projectedFuture, projectedAnnual: projection.projectedAnnual, scenarios: projection.scenarios, range: projection.range, confidence: projection.confidence },
      entity: { entityPath, routing: entityContext.routing, requirements: entityContext.requirements, warnings: entityContext.warnings },
      federal: { incomeTax: federal, selfEmploymentTax: seTax, payrollTaxContext: sCorp?.payroll || null, totalFederalTax, range: federal.range, components: [...(federal.components || []), ...(seTax?.components || [])] },
      state: {
        stateCode: profile?.primary_tax_state || null,
        incomeTax: state,
        individualIncomeTax: state.individualIncomeTax,
        entityTaxes: {
          sCorpMinimumTax: state.tax.sCorpMinimumTax,
          sCorpEntityTax: state.tax.sCorpEntityTax,
          replacementTax: state.tax.replacementTax,
          detail: state.entityTax,
        },
        localTaxes: state.tax.localIncomeTax,
        totalStateTax,
        totalStateTaxStatus: state.totalStateTax?.status || state.tax.status || null,
        knownComponentsAmount: knownStateComponentsAmount,
        provisionalReserve: state.provisionalReserve,
        range: state.range,
        components: state.components,
      },
      liability: {
        projectedFederalTax: totalFederalTax,
        projectedStateTax: totalStateTax,
        projectedTotalTax,
        ytdTaxGeneratedEstimate: throughDateTaxAttribution.amount,
        taxAttributableThroughToday: throughDateTaxAttribution,
        paymentsAndWithholdingYtd,
        remainingProjectedLiability,
        projectedOverpayment,
        balanceDueEstimate: remainingProjectedLiability,
      },
      payments,
      safeHarbor,
      deadlines,
      reserveInput: null,
      reserve: null,
      confidence: null,
      warnings,
      missingInputs: [...new Set([...(completeness.missingRequired || []), ...(entityContext.requirements?.missingInputs || []), ...(safeHarbor.federal.blockers || []).map((b) => b.code), ...(safeHarbor.state.blockers || []).map((b) => b.code)])],
      unsupportedItems: [...new Set([...(federal.unsupportedItems || []), ...(state.unsupportedItems || [])])],
      supportedButDeferred: [...new Set(["qbi_deduction", ...(entityContext.supportedButDeferred || []), ...(seTax?.supportedButDeferred || []), ...(sCorp?.supportedButDeferred || [])])],
      assumptions: ["SE tax is computed before federal income tax so the half-SE-tax deduction can reduce federal taxable income.", ...(federal.assumptions || []), ...(state.assumptions || [])],
      components: buildComponents({ taxableIncome, projection, federal, seTax, sCorp, state, payments, safeHarbor }),
    };
    const reservePolicy = resolveTaxReservePolicy({ profile, memories });
    const reserve = await computeTaxReserve({
      supabase,
      businessId,
      taxYear: normalizedYear,
      asOfDate: cutoff,
      canonicalTaxResult: result,
      policy: reservePolicy,
    });
    result.reserve = reserve;
    result.reserveInput = reserve.reserveInput;
    result.warnings = collectWarnings([result.warnings, reserve.warnings]);
    result.assumptions = [...result.assumptions, ...(reserve.assumptions || [])];
    result.components = [...result.components, ...(reserve.components || [])];
    result.meta.engineVersions.reserve = reserve.meta.engineVersion;
    const confidence = computeCanonicalTaxConfidence({
      canonicalResult: result,
      engineConfidences: { taxableIncome: taxableIncome.confidence, projection: projection.confidence, federal: federal.confidence, selfEmployment: seTax?.confidence, sCorp: sCorp?.confidence, state: state.confidence, reserve: reserve.confidence },
      sourceFreshness: result.meta.sourceFreshness,
      coverage: result.actuals.coverage,
      warnings,
      unsupportedItems: result.unsupportedItems,
      deferredItems: result.supportedButDeferred,
    });
    result.confidence = confidence;
    result.meta.confidenceStatus = confidence.status;
    result.meta.estimateReady = confidence.estimateReady;
    result.meta.reserveReady = confidence.reserveReady;
    result.meta.status = statusFromConfidence({ confidence, state, federal });
    if (runId) {
      const finalized = await persistCanonicalTaxCalculation({
        supabase,
        runId,
        businessId,
        canonicalResult: result,
        completionType: completionType || (result.meta.status === "partial" ? TAX_RUN_COMPLETION_TYPES.PARTIAL : TAX_RUN_COMPLETION_TYPES.AUTHORITATIVE),
        supersedesRunId,
        supersessionReason: supersedesRunId ? TAX_RUN_SUPERSESSION_REASONS.NEWER_CALCULATION : null,
      });
      result.meta.runId = finalized?.id || runId;
      result.meta.persistenceStatus = "persisted";
      try {
        const snapshot = await persistTaxReserveSnapshot({
          supabase,
          businessId,
          taxYear: normalizedYear,
          calculationRunId: result.meta.runId,
          reserveResult: result.reserve,
        });
        result.reserve.snapshotId = snapshot?.id || null;
      } catch (snapshotErr) {
        result.reserve.snapshotPersistenceStatus = "failed";
        result.warnings.push({
          code: "tax_reserve_snapshot_persistence_failed",
          severity: "medium",
          message: "Tax calculation was persisted, but the tax reserve snapshot could not be saved.",
          action: "retry_reserve_snapshot",
          error: snapshotErr.code || "tax_reserve_snapshot_failed",
        });
      }
      emitTaxDataChanged({
        businessId,
        taxYear: normalizedYear,
        changeType: result.meta.status === "partial" ? "tax_calculation_partial" : "tax_calculation_completed",
        entityId: result.meta.runId,
        userId,
      });
    }
    return result;
  } catch (err) {
    if (runId) {
      try {
        await markTaxRunFailed({
          supabase,
          businessId,
          runId,
          errorCode: err.code || "tax_calculation_failed",
          errorMessage: err.safeToExpose === false ? "Tax calculation failed." : err.message,
        });
      } catch {
        // Persistence failure is surfaced by the original calculation error.
      }
    }
    throw err;
  }
}

async function computeStateBestEffort(args) {
  try {
    return await computeStateTax({
      supabase: args.supabase,
      businessId: args.businessId,
      taxYear: args.taxYear,
      asOfDate: args.asOfDate,
      stateCode: args.profile?.primary_tax_state,
      filingStatus: args.profile?.filing_status,
      entityContext: args.entityContext,
      federalContext: args.federal,
      taxableIncomeContext: args.taxableIncome,
      projectionContext: args.projection,
      sCorpContext: args.sCorp,
    });
  } catch (err) {
    return {
      meta: { stateCode: args.profile?.primary_tax_state || null, taxYear: args.taxYear, engineVersion: "state-tax-v1", supportSummary: { supportLevel: "unsupported", ruleCount: 0 } },
      income: { stateTaxableIncome: null },
      deductions: { standardDeduction: 0, personalExemption: 0, otherSupportedDeductions: 0 },
      tax: { regularStateIncomeTax: null, passThroughEntityTax: null, franchiseTax: null, sCorpMinimumTax: null, localIncomeTax: null, totalStateTax: null, knownComponentsAmount: 0, status: "unavailable" },
      individualIncomeTax: { status: "unavailable", amount: null, reasonCode: err.code || "state_tax_failed" },
      entityTax: { status: "unavailable", amount: null, possibleTaxes: [] },
      totalStateTax: { status: "unavailable", amount: null, knownComponentsAmount: 0 },
      provisionalReserve: { status: "unavailable", amount: null, isLiabilityEstimate: false },
      withholding: { stateWithholdingYtd: 0 },
      range: { low: null, base: null, high: null },
      confidence: { score: 20, level: "unavailable", blockers: [{ code: err.code || "state_tax_unavailable", message: "State tax unavailable." }] },
      warnings: [{ code: "state_rule_missing", severity: "high", message: "State tax calculation is unavailable.", error: err.code || "state_tax_failed" }],
      unsupportedItems: ["state_tax"],
      components: [],
    };
  }
}

async function optionalFederalRule(args) {
  try {
    return await getTaxRuleConfig(args);
  } catch {
    return null;
  }
}

async function optionalStateRule(args) {
  try {
    return await getStateTaxRuleConfig(args);
  } catch {
    return null;
  }
}

async function safeMemories({ supabase, businessId, asOfDate }) {
  try {
    return await getActiveTaxMemories({ supabase, businessId, asOfDate });
  } catch {
    return [];
  }
}

function engineVersions({ entityContext, taxableIncome, projection, federal, seTax, sCorp, state }) {
  return {
    orchestrator: TAX_ORCHESTRATOR_ENGINE_VERSION,
    entity: entityContext?.meta?.engineVersion,
    taxableIncome: taxableIncome?.meta?.engineVersion,
    projection: projection?.meta?.engineVersion,
    federal: federal?.meta?.engineVersion,
    selfEmployment: seTax?.meta?.engineVersion,
    sCorp: sCorp?.meta?.engineVersion,
    state: state?.meta?.engineVersion,
  };
}

function collectWarnings(groups) {
  const seen = new Set();
  const out = [];
  for (const group of groups.flat().filter(Boolean)) {
    const key = `${group.code}:${group.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(group);
    }
  }
  return out;
}

function buildComponents({ taxableIncome, projection, federal, seTax, sCorp, state, payments, safeHarbor }) {
  return [
    ...(taxableIncome.components || []).map((row) => ({ ...row, engine: "taxable_income" })),
    ...(projection.components || []).map((row) => ({ ...row, engine: "projection" })),
    ...(federal.components || []).map((row) => ({ ...row, engine: "federal" })),
    ...(seTax?.components || []).map((row) => ({ ...row, engine: "self_employment" })),
    ...(sCorp?.components || []).map((row) => ({ ...row, engine: "s_corp" })),
    ...(state.components || []).map((row) => ({ ...row, engine: "state" })),
    { componentType: "payments_and_withholding", amount: payments.totals.totalPaidAndWithheld, engine: "payments" },
    { componentType: "safe_harbor_remaining", amount: safeHarbor.combined.remainingAmount ?? 0, engine: "safe_harbor", status: safeHarbor.combined.status },
  ];
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function isStaleRun(run, olderThanMinutes = 30) {
  const started = Date.parse(run?.started_at || run?.created_at || "");
  if (!Number.isFinite(started)) return true;
  return Date.now() - started > olderThanMinutes * 60000;
}

async function abandonStaleRunningCalculations({ supabase, businessId, taxYear, asOfDate, calculationType }) {
  const running = await listRunningTaxRunsForCalculation({ supabase, businessId, taxYear, asOfDate, calculationType });
  for (const run of running) {
    if (isStaleRun(run)) {
      await markTaxRunAbandoned({ supabase, businessId, runId: run.id, reason: "stale_source_data" });
    }
  }
}

function statusFromConfidence({ confidence, state, federal }) {
  const fatal = confidence?.blockers?.some((blocker) => blocker.severity === "fatal");
  if (fatal && !confidence?.estimateReady) return "failed";
  if (!federal) return "failed";
  if (state?.confidence?.level === "unavailable" || state?.warnings?.some((warning) => ["state_rule_missing", "unsupported_state"].includes(warning.code))) return "partial";
  if (!confidence?.reserveReady || confidence?.level === "low" || confidence?.blockers?.length) return "partial";
  return "completed";
}

function canonicalFromPersistedRun(run, { reusedExistingRun, fingerprint, persistenceStatus = "persisted" } = {}) {
  const projectedFederalTax = round2(run.estimated_federal_tax);
  const projectedStateTax = round2(run.estimated_state_tax);
  const projectedTotalTax = round2(run.estimated_total_tax);
  const paymentsAndWithholdingYtd = round2(Number(run.payments_ytd || 0) + Number(run.withholding_ytd || 0));
  return {
    meta: {
      businessId: run.business_id,
      taxYear: run.tax_year,
      asOfDate: run.as_of_date,
      calculationType: run.calculation_type,
      triggerSource: run.trigger_source,
      engineVersions: { orchestrator: run.calculation_version || TAX_ORCHESTRATOR_ENGINE_VERSION },
      generatedAt: run.completed_at || run.created_at,
      runId: run.id,
      status: run.status,
      fingerprint: fingerprint || run.calculation_fingerprint,
      reusedExistingRun,
      persistenceStatus,
      sourceFreshness: run.source_freshness || {},
    },
    profile: { profile: { id: run.tax_profile_id, entity_type: run.entity_type, filing_status: run.filing_status, primary_tax_state: run.state_code }, completeness: {}, entityContext: null },
    actuals: {
      taxableIncome: { businessTaxableIncome: { finalBusinessTaxableIncome: round2(run.taxable_income_ytd) } },
      deductions: {},
      revenue: {},
      coverage: {},
    },
    projection: { method: null, actual: {}, projectedFuture: {}, projectedAnnual: { taxableBusinessIncome: round2(run.projected_taxable_income) }, scenarios: {}, range: {}, confidence: {} },
    entity: { entityPath: run.entity_type, routing: {}, requirements: {}, warnings: [] },
    federal: { incomeTax: null, selfEmploymentTax: null, payrollTaxContext: null, totalFederalTax: projectedFederalTax, range: {}, components: [] },
    state: { stateCode: run.state_code, incomeTax: null, entityTaxes: {}, localTaxes: 0, totalStateTax: projectedStateTax, range: {}, components: [] },
    liability: {
      projectedFederalTax,
      projectedStateTax,
      projectedTotalTax,
      ytdTaxGeneratedEstimate: projectedTotalTax,
      paymentsAndWithholdingYtd,
      remainingProjectedLiability: round2(run.remaining_projected_liability),
      projectedOverpayment: 0,
      balanceDueEstimate: round2(run.remaining_projected_liability),
    },
    payments: { totals: { totalPaidAndWithheld: paymentsAndWithholdingYtd } },
    safeHarbor: {
      federal: { status: run.safe_harbor_target == null ? "unavailable" : "available", requiredAnnual: run.safe_harbor_target, coveredAmount: run.safe_harbor_covered, remainingAmount: run.safe_harbor_gap, quarterSchedule: [], warnings: [] },
      state: { status: "unavailable", requiredAnnual: null, coveredAmount: 0, remainingAmount: null, quarterSchedule: [], warnings: [] },
      combined: { status: run.safe_harbor_target == null ? "unavailable" : "available", requiredAnnual: run.safe_harbor_target, coveredAmount: run.safe_harbor_covered, remainingAmount: run.safe_harbor_gap },
    },
    deadlines: [],
    reserveInput: {
      recommendedReserveBeforeCashComparison: round2(run.recommended_reserve),
      currentReserve: run.current_reserve == null ? null : round2(run.current_reserve),
      reserveGap: run.reserve_gap == null ? null : round2(run.reserve_gap),
      reserveStatus: run.reserve_gap == null ? "setup_incomplete" : Number(run.reserve_gap) <= 0 ? "on_track" : "reserve_gap",
    },
    reserve: {
      status: run.reserve_gap == null ? "setup_incomplete" : Number(run.reserve_gap) <= 0 ? "on_track" : "reserve_gap",
      reserve: {
        currentReserve: run.current_reserve == null ? null : round2(run.current_reserve),
        recommendedReserve: round2(run.recommended_reserve),
        reserveGap: run.reserve_gap == null ? null : round2(run.reserve_gap),
      },
    },
    confidence: {
      score: Number(run.confidence_score || 0),
      level: run.confidence_level || "unavailable",
      status: run.confidence_status || null,
      estimateReady: run.estimate_ready === true,
      reserveReady: run.reserve_ready === true,
      factors: run.confidence_factors || [],
      penalties: run.confidence_penalties || [],
      blockers: run.confidence_blockers || [],
      methodologyVersion: run.confidence_methodology_version || null,
    },
    warnings: run.warnings || [],
    missingInputs: run.missing_inputs || [],
    unsupportedItems: [],
    supportedButDeferred: [],
    assumptions: run.assumptions || [],
    components: [],
  };
}
