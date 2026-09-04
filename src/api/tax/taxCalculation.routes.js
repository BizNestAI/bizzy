// /src/api/tax/taxCalculation.routes.js
import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import { runCanonicalTaxCalculation } from "../../services/tax/orchestrator/taxOrchestrator.js";
import { TAX_CALCULATION_TYPES, TAX_TRIGGER_SOURCES } from "../../services/tax/taxDomain.js";
import { notFoundError, validationError } from "../../services/tax/taxErrors.js";
import { compareTaxRuns } from "../../services/tax/runs/taxRunComparison.service.js";
import { getLatestTaxRun, getTaxRun, listTaxRuns } from "../../services/tax/runs/taxRun.repository.js";
import { getTaxCalculationWorkpaper } from "../../services/tax/workpaper/taxWorkpaper.service.js";
import { compareExplanationComponents } from "../../services/tax/explanations/taxExplanationDiff.js";
import { buildTaxCalculationSummary } from "../../services/tax/explanations/taxExplanationSummary.js";
import { toCanonicalTaxCalculationDto } from "../../services/tax/api/taxCalculationDto.js";
import { parseTaxApiIncludes, resolveTaxApiVersion } from "../../services/tax/api/taxApiVersion.js";
import { computeTaxProfileReadiness, getTaxProfile } from "../../services/tax/taxProfile.service.js";
import { buildTaxDeadlines } from "../../services/tax/payments/taxDeadlineEngine.js";
import { getTaxRuleConfig } from "../../services/tax/taxRuleConfig.repository.js";
import { getStateTaxRuleConfig } from "../../services/tax/stateTaxRule.repository.js";
import { FEDERAL_TAX_RULE_TYPES, STATE_TAX_RULE_TYPES } from "../../services/tax/taxRuleTypes.js";
import {
  countPostedTransactionsForTax,
  countReviewRequiredTaxClassifications,
  countUnclassifiedPostedTransactions,
} from "../../services/tax/taxPostedTransaction.repository.js";
import { assertTaxBusinessAccess, getAuthenticatedUserId } from "./taxRouteUtils.js";
import { optionalDate, optionalEnum, optionalTaxYear, requireUuid, validateBusinessIdInput, validatePagination } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.post("/calculations", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const body = req.body || {};
    const apiVersion = resolveTaxApiVersion(req);
    const include = parseTaxApiIncludes(body.include ?? req.query?.include);
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(body.year ?? body.taxYear, new Date().getFullYear());
    const asOfDate = optionalDate(body.asOfDate, "asOfDate");
    const calculationType = optionalEnum(body.calculationType, Object.values(TAX_CALCULATION_TYPES), "calculationType") || TAX_CALCULATION_TYPES.FULL_ESTIMATE;
    const triggerSource = optionalEnum(body.triggerSource, Object.values(TAX_TRIGGER_SOURCES), "triggerSource") || TAX_TRIGGER_SOURCES.MANUAL;
    const data = await runCanonicalTaxCalculation({
      supabase,
      businessId,
      taxYear,
      asOfDate,
      calculationType,
      projectionMethod: body.projectionMethod || "blended",
      projectionScenario: body.projectionScenario || "base",
      manualOverrides: body.manualOverrides || null,
      triggerSource,
      force: body.force === true,
      requestId: body.idempotencyKey || req.headers?.["x-request-id"] || null,
      completionType: body.completionType || null,
      userId: getAuthenticatedUserId(req),
      persistRun: body.persistRun !== false,
    });
    return sendTaxSuccess(res, toCanonicalTaxCalculationDto({ canonicalResult: data, include, apiVersion }));
  } catch (err) {
    return sendTaxError(res, err, "tax_calculation_failed");
  }
});

router.get("/calculations", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = req.query?.year || req.query?.taxYear ? optionalTaxYear(req.query?.year ?? req.query?.taxYear, new Date().getFullYear()) : null;
    const pagination = validatePagination({ limit: req.query?.limit || 50, offset: req.query?.offset || 0 });
    const rows = await listTaxRuns({
      supabase,
      businessId,
      taxYear,
      status: req.query?.status || null,
      calculationType: req.query?.calculationType || null,
      triggerSource: req.query?.triggerSource || null,
      limit: pagination.limit,
      offset: pagination.offset,
    });
    return sendTaxSuccess(res, { rows, pagination: { limit: pagination.limit || 50, offset: pagination.offset || 0, count: rows.length } });
  } catch (err) {
    return sendTaxError(res, err, "tax_calculations_list_failed");
  }
});

router.get("/calculations/latest", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const apiVersion = resolveTaxApiVersion(req);
    const include = parseTaxApiIncludes(req.query?.include);
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query?.year ?? req.query?.taxYear, new Date().getFullYear());
    optionalBoolean(req.query?.refresh, "refresh");
    optionalEnum(req.query?.calculationType, Object.values(TAX_CALCULATION_TYPES), "calculationType");
    const latest = await getLatestTaxRun({ supabase, businessId, taxYear });
    if (!latest) {
      return sendTaxSuccess(res, {
        data_status: "calculation_required",
        calculation: null,
        meta: { apiVersion, businessId, taxYear, status: "calculation_required", source: "persisted_read_only" },
        readiness: {
          status: "calculation_required",
          estimateReady: false,
          reserveReady: false,
          setupState: {
            code: "calculation_required",
            status: "action_needed",
            message: "A tax estimate has not been generated yet.",
            actions: ["generate_tax_estimate"],
          },
        },
      });
    }
    return sendTaxSuccess(res, toCanonicalTaxCalculationDto({ run: latest, include, apiVersion }));
  } catch (err) {
    return sendTaxError(res, err, "tax_calculation_latest_failed");
  }
});

router.get("/calculations/:runId/compare/:otherRunId", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const runId = requireUuid(req.params.runId, "runId");
    const otherRunId = requireUuid(req.params.otherRunId, "otherRunId");
    const current = await getTaxRun({ supabase, businessId, runId });
    const previous = await getTaxRun({ supabase, businessId, runId: otherRunId });
    if (!current || !previous) throw notFoundError("tax_calculation_not_found", "One or both tax calculations were not found.", { runId, otherRunId });
    return sendTaxSuccess(res, compareTaxRuns({ previousRun: previous, currentRun: current }));
  } catch (err) {
    return sendTaxError(res, err, "tax_calculation_compare_failed");
  }
});

router.get("/calculations/:runId/explanation", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const runId = requireUuid(req.params.runId, "runId");
    const run = await getTaxRun({ supabase, businessId, runId });
    if (!run) throw notFoundError("tax_calculation_not_found", "Tax calculation was not found.", { runId });
    const components = filterComponents(await loadRunComponents({ supabase, businessId, runId }), req.query || {});
    const summary = buildTaxCalculationSummary({ canonicalResult: canonicalFromRun(run), components: components.map((row) => row.metadata || row) });
    return sendTaxSuccess(res, { run, summary, components });
  } catch (err) {
    return sendTaxError(res, err, "tax_calculation_explanation_failed");
  }
});

router.get("/calculations/:runId/explanation/:componentKey", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const runId = requireUuid(req.params.runId, "runId");
    const run = await getTaxRun({ supabase, businessId, runId });
    if (!run) throw notFoundError("tax_calculation_not_found", "Tax calculation was not found.", { runId });
    const componentKey = String(req.params.componentKey || "");
    const components = await loadRunComponents({ supabase, businessId, runId });
    const component = components.find((row) => row.component_key === componentKey || row.metadata?.componentKey === componentKey);
    if (!component) throw notFoundError("tax_calculation_component_not_found", "Tax calculation component was not found.", { runId, componentKey });
    return sendTaxSuccess(res, { run, component });
  } catch (err) {
    return sendTaxError(res, err, "tax_calculation_component_explanation_failed");
  }
});

router.get("/calculations/:runId/changes", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const runId = requireUuid(req.params.runId, "runId");
    const run = await getTaxRun({ supabase, businessId, runId });
    if (!run) throw notFoundError("tax_calculation_not_found", "Tax calculation was not found.", { runId });
    const previousRunId = req.query?.otherRunId ? requireUuid(req.query.otherRunId, "otherRunId") : await findPreviousRunId({ supabase, businessId, runId });
    const currentComponents = await loadRunComponents({ supabase, businessId, runId });
    const previousComponents = previousRunId ? await loadRunComponents({ supabase, businessId, runId: previousRunId }) : [];
    const diff = compareExplanationComponents({
      previousComponents: previousComponents.map((row) => row.metadata || row),
      currentComponents: currentComponents.map((row) => row.metadata || row),
    });
    return sendTaxSuccess(res, { run, previousRunId, diff });
  } catch (err) {
    return sendTaxError(res, err, "tax_calculation_changes_failed");
  }
});

router.get("/calculations/:runId/confidence", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const runId = requireUuid(req.params.runId, "runId");
    const run = await getTaxRun({ supabase, businessId, runId });
    if (!run) throw notFoundError("tax_calculation_not_found", "Tax calculation was not found.", { runId });
    return sendTaxSuccess(res, { runId, confidence: confidenceFromRun(run) });
  } catch (err) {
    return sendTaxError(res, err, "tax_calculation_confidence_failed");
  }
});

router.get("/calculations/:runId/components", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const runId = requireUuid(req.params.runId, "runId");
    const run = await getTaxRun({ supabase, businessId, runId });
    if (!run) throw notFoundError("tax_calculation_not_found", "Tax calculation was not found.", { runId });
    const { data, error } = await supabase
      .from("tax_calculation_components")
      .select("*")
      .eq("business_id", businessId)
      .eq("run_id", runId)
      .order("sort_order", { ascending: true });
    if (error) throw validationError("tax_calculation_components_unavailable", "Calculation components are unavailable.", { runId });
    return sendTaxSuccess(res, { run, components: data || [] });
  } catch (err) {
    return sendTaxError(res, err, "tax_calculation_components_failed");
  }
});

router.get("/calculations/:runId/workpaper", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const runId = requireUuid(req.params.runId, "runId");
    const data = await getTaxCalculationWorkpaper({
      supabase,
      businessId,
      runId,
      section: req.query?.section || null,
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_workpaper_failed");
  }
});

router.get("/workpaper", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query?.year ?? req.query?.taxYear ?? req.query?.tax_year, new Date().getFullYear());
    const runId = req.query?.runId || req.query?.run_id ? requireUuid(req.query?.runId ?? req.query?.run_id, "runId") : null;
    const throughDate = optionalDate(req.query?.throughDate ?? req.query?.through_date, "throughDate");
    const data = await getTaxCalculationWorkpaper({
      supabase,
      businessId,
      taxYear,
      runId,
      throughDate,
      section: req.query?.section || null,
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_workpaper_failed");
  }
});

router.get("/confidence/current", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query?.year ?? req.query?.taxYear, new Date().getFullYear());
    optionalBoolean(req.query?.refresh, "refresh");
    optionalEnum(req.query?.calculationType, Object.values(TAX_CALCULATION_TYPES), "calculationType");
    const latest = await getLatestTaxRun({ supabase, businessId, taxYear });
    if (!latest) {
      return sendTaxSuccess(res, {
        runId: null,
        confidence: { score: null, level: "unavailable", status: "calculation_required", estimateReady: false, reserveReady: false },
      }, { source: "persisted_read_only", data_status: "calculation_required" });
    }
    return sendTaxSuccess(res, { runId: latest.id, confidence: confidenceFromRun(latest) }, { source: "persisted" });
  } catch (err) {
    return sendTaxError(res, err, "tax_current_confidence_failed");
  }
});

router.get("/calculations/:runId", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const apiVersion = resolveTaxApiVersion(req);
    const include = parseTaxApiIncludes(req.query?.include);
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const runId = requireUuid(req.params.runId, "runId");
    const data = await getTaxRun({ supabase, businessId, runId });
    if (!data) throw notFoundError("tax_calculation_not_found", "Tax calculation was not found.", { runId });
    return sendTaxSuccess(res, toCanonicalTaxCalculationDto({ run: data, include, apiVersion }));
  } catch (err) {
    return sendTaxError(res, err, "tax_calculation_fetch_failed");
  }
});

router.get("/overview", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const apiVersion = resolveTaxApiVersion(req);
    const include = parseTaxApiIncludes(req.query?.include);
    const isAdminView = req?.tenantContext?.mode === "admin_view";
    const businessId = isAdminView ? req.tenantContext.businessId : validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query?.year ?? req.query?.taxYear, new Date().getFullYear());
    const requestedAsOfDate = optionalDate(req.query?.asOfDate, "asOfDate");
    optionalBoolean(req.query?.refresh, "refresh");
    const latest = await getLatestTaxRun({ supabase, businessId, taxYear });
    if (!latest) {
      if (isAdminView) {
        return sendTaxSuccess(res, adminViewTaxUnavailableDto({ businessId, taxYear, apiVersion }));
      }
      return sendTaxSuccess(res, await taxOverviewLifecycleDto({ supabase, businessId, taxYear, requestedAsOfDate, apiVersion }));
    }
    if (requestedAsOfDate && String(latest.as_of_date || "") !== requestedAsOfDate) {
      const dto = toCanonicalTaxCalculationDto({ run: latest, include, apiVersion });
      dto.data.meta = { ...(dto.data.meta || {}), stale: true, requestedAsOfDate };
      dto.data.data_status = "stale";
      return sendTaxSuccess(res, dto.data);
    }
    const dto = toCanonicalTaxCalculationDto({ run: latest, include, apiVersion });
    dto.data.data_status = "available";
    return sendTaxSuccess(res, dto.data);
  } catch (err) {
    return sendTaxError(res, err, "tax_overview_failed");
  }
});

export default router;

function adminViewTaxUnavailableDto({ businessId, taxYear, apiVersion }) {
  return {
    ok: true,
    data: {
      meta: {
        apiVersion,
        businessId,
        taxYear,
        status: "unavailable",
        source: "admin_view_persisted_only",
        adminViewUnavailable: true,
      },
      readiness: {
        estimateReady: false,
        reserveReady: false,
        profileStatus: null,
        setupState: "unavailable",
        status: "unavailable",
      },
      summary: {},
      profile: null,
      actuals: null,
      projection: null,
      federal: null,
      state: null,
      payments: null,
      safeHarbor: null,
      reserve: null,
      deadlines: [],
      confidence: null,
      warnings: [],
      assumptions: [],
      unsupportedItems: [],
      supportedButDeferred: [],
      explanationSummary: null,
      links: {},
      admin_view_read_only_data_unavailable: true,
    },
  };
}

async function taxOverviewLifecycleDto({ supabase, businessId, taxYear, requestedAsOfDate, apiVersion }) {
  const profile = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
  const deadlineState = await buildReadOnlyDeadlineState({ supabase, businessId, taxYear, profile, requestedAsOfDate });
  let dataStatus = "profile_required";
  const postedCount = await countPostedTransactionsForTax({ supabase, businessId, taxYear });
  const unclassifiedCount = postedCount > 0
    ? await countUnclassifiedPostedTransactions({ supabase, businessId, taxYear })
    : 0;
  const reviewRequiredCount = postedCount > 0
    ? await countReviewRequiredTaxClassifications({ supabase, businessId, taxYear })
    : 0;
  const classifiedCount = Math.max(0, postedCount - unclassifiedCount);
  const financialDataReady = postedCount > 0;
  const taxClassificationReady = postedCount > 0 && unclassifiedCount === 0 && reviewRequiredCount === 0;

  if (profile) {
    const profileReadiness = computeTaxProfileReadiness(profile);
    if (profileReadiness.profile_complete !== true) {
      dataStatus = "profile_draft";
    } else {
      dataStatus = postedCount <= 0
        ? "insufficient_financial_data"
        : !taxClassificationReady
          ? "classifications_required"
          : "calculation_required";
    }
  }

  const readiness = computeTaxProfileReadiness(profile, { financialDataReady, taxClassificationReady });
  const message = lifecycleMessage(dataStatus);
  const classificationSummary = buildClassificationSummary({ postedCount, classifiedCount, unclassifiedCount, reviewRequiredCount });
  const surfaceReadiness = buildSurfaceReadiness({
    dataStatus,
    profile,
    readiness,
    classificationSummary,
    financialDataReady,
    taxClassificationReady,
    deadlineReadiness: deadlineState.readiness,
  });
  return {
    data_status: dataStatus,
    meta: {
      apiVersion,
      businessId,
      taxYear,
      asOfDate: requestedAsOfDate || null,
      status: dataStatus,
      source: "persisted_read_only",
      readOnly: true,
    },
    readiness: {
      status: dataStatus,
      estimateReady: false,
      reserveReady: false,
      profileStatus: readiness.profile_status,
      missingFields: readiness.missing_fields,
      validationErrors: readiness.validation_errors,
      blockers: readiness.blockers,
      setupState: {
        code: dataStatus,
        status: "action_needed",
        message,
        actions: lifecycleActions(dataStatus),
      },
      financialDataReady,
      taxClassificationReady,
      postedTransactionCount: postedCount,
      classifiedTransactionCount: classifiedCount,
      unclassifiedTransactionCount: unclassifiedCount,
      reviewRequiredTransactionCount: reviewRequiredCount,
    },
    classification_summary: classificationSummary,
    surface_readiness: surfaceReadiness,
    calculation: null,
    profile,
    missing_fields: readiness.missing_fields,
    message,
    summary: {},
    actuals: null,
    projection: null,
    federal: null,
    state: null,
    payments: null,
    safeHarbor: null,
    reserve: null,
    deadlines: deadlineState.deadlines,
    confidence: null,
    warnings: [],
    assumptions: [],
    unsupportedItems: [],
    supportedButDeferred: [],
    explanationSummary: null,
    links: {},
  };
}

async function buildReadOnlyDeadlineState({ supabase, businessId, taxYear, profile, requestedAsOfDate }) {
  const profileReadiness = computeTaxProfileReadiness(profile);
  if (!profile) {
    return {
      deadlines: [],
      readiness: {
        status: "profile_required",
        ready: false,
        reason: "profile_required",
        message: "Complete your Tax Profile to show estimated-tax deadlines.",
        amountStatus: "estimated_payment_amount_pending",
      },
    };
  }
  if (profileReadiness.profile_complete !== true) {
    return {
      deadlines: [],
      readiness: {
        status: "profile_draft",
        ready: false,
        reason: "profile_draft",
        message: "Finish required Tax Profile fields to show estimated-tax deadlines.",
        amountStatus: "estimated_payment_amount_pending",
      },
    };
  }

  try {
    const [federalDueDateConfig, stateDueDateConfig] = await Promise.all([
      getTaxRuleConfig({
        supabase,
        taxYear,
        ruleType: FEDERAL_TAX_RULE_TYPES.ESTIMATED_TAX_DUE_DATES,
        filingStatus: profile.filing_status,
        entityType: profile.entity_type,
        asOfDate: requestedAsOfDate,
      }).catch(() => null),
      profile.primary_tax_state
        ? getStateTaxRuleConfig({
            supabase,
            taxYear,
            stateCode: profile.primary_tax_state,
            ruleType: STATE_TAX_RULE_TYPES.ESTIMATED_TAX_DUE_DATES,
            filingStatus: profile.filing_status,
            entityType: profile.entity_type,
            taxElection: profile.tax_election,
            asOfDate: requestedAsOfDate,
          }).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (!federalDueDateConfig && !stateDueDateConfig) {
      return {
        deadlines: [],
        readiness: {
          status: "rules_unavailable",
          ready: false,
          reason: "rules_unavailable",
          message: "Estimated-tax deadline rules are unavailable for this profile.",
          amountStatus: "estimated_payment_amount_pending",
        },
      };
    }
    const deadlines = buildTaxDeadlines({
      businessId,
      taxYear,
      federalDueDateConfig,
      stateDueDateConfig,
      entityContext: {
        entity: {
          entityPath: profile.entity_type || null,
          entityType: profile.entity_type || null,
          taxElection: profile.tax_election || null,
        },
      },
      asOfDate: requestedAsOfDate,
    });
    return {
      deadlines,
      readiness: {
        status: deadlines.length ? "available" : "rules_unavailable",
        ready: deadlines.length > 0,
        reason: deadlines.length ? null : "rules_unavailable",
        message: deadlines.length
          ? "Estimated-tax deadlines are available from the current tax rule set."
          : "Estimated-tax deadline rules are unavailable for this profile.",
        amountStatus: "estimated_payment_amount_pending",
      },
    };
  } catch {
    return {
      deadlines: [],
      readiness: {
        status: "rules_unavailable",
        ready: false,
        reason: "rules_unavailable",
        message: "Estimated-tax deadline rules are unavailable for this profile.",
        amountStatus: "estimated_payment_amount_pending",
      },
    };
  }
}

function buildClassificationSummary({ postedCount, classifiedCount, unclassifiedCount, reviewRequiredCount }) {
  const coverage = postedCount > 0 ? Math.round((classifiedCount / postedCount) * 10000) / 100 : null;
  return {
    posted_transaction_count: postedCount,
    classified_transaction_count: classifiedCount,
    unclassified_transaction_count: unclassifiedCount,
    review_required_transaction_count: reviewRequiredCount,
    excluded_transaction_count: null,
    auto_classified_transaction_count: null,
    processing_transaction_count: 0,
    failed_transaction_count: 0,
    classification_coverage_percent: coverage,
    postedTransactionCount: postedCount,
    classifiedTransactionCount: classifiedCount,
    unclassifiedTransactionCount: unclassifiedCount,
    reviewRequiredTransactionCount: reviewRequiredCount,
    autoClassifiedTransactionCount: null,
    processingTransactionCount: 0,
    failedTransactionCount: 0,
    classificationCoveragePercent: coverage,
    classificationStatus: postedCount > 0 && unclassifiedCount > 0 ? "classifications_required" : reviewRequiredCount > 0 ? "review_required" : postedCount > 0 ? "classifications_ready" : "no_posted_transactions",
  };
}

function buildSurfaceReadiness({
  dataStatus,
  profile,
  readiness,
  classificationSummary,
  financialDataReady,
  taxClassificationReady,
  deadlineReadiness,
}) {
  const profileStatus = readiness.profile_status;
  const postedCount = classificationSummary.posted_transaction_count;
  const unclassifiedCount = classificationSummary.unclassified_transaction_count;
  const reviewRequiredCount = classificationSummary.review_required_transaction_count;
  const classificationsMessage = classificationReadinessMessage({ postedCount, unclassifiedCount, reviewRequiredCount });
  const profileReadyClassificationMessage = "Your Tax Profile is complete. Bizzi is preparing the tax treatment of your posted QuickBooks transactions.";

  const profileBlocker = !profile
    ? "profile_required"
    : profileStatus !== "calculation_ready"
      ? "profile_draft"
      : null;
  const financialBlocker = !financialDataReady ? "insufficient_financial_data" : null;
  const classificationBlocker = financialDataReady && !taxClassificationReady ? "classifications_required" : null;
  const readinessReason = profileBlocker || financialBlocker || classificationBlocker || "calculation_required";

  return {
    chart: {
      status: dataStatus === "available" ? "available" : readinessReason,
      ready: false,
      reason: readinessReason,
      message: readinessReason === "calculation_required"
        ? "The tax trajectory will appear after the first completed tax calculation."
        : surfaceMessage(readinessReason, readinessReason === "classifications_required" ? profileReadyClassificationMessage : classificationsMessage),
    },
    liability: {
      status: dataStatus === "available" ? "available" : readinessReason,
      ready: false,
      reason: readinessReason,
      message: readinessReason === "calculation_required"
        ? "A completed tax calculation is required before estimated liability is available."
        : surfaceMessage(readinessReason, readinessReason === "classifications_required" ? profileReadyClassificationMessage : classificationsMessage),
    },
    deductions: {
      status: taxClassificationReady ? "available" : (financialDataReady ? "classifications_required" : "insufficient_financial_data"),
      ready: taxClassificationReady,
      reason: taxClassificationReady ? null : (financialDataReady ? "classifications_required" : "insufficient_financial_data"),
      message: taxClassificationReady
        ? "Deduction classification data is available."
        : classificationsMessage,
    },
    deadline: deadlineReadiness || {
      status: "unavailable",
      ready: false,
      reason: "unavailable",
      message: "Estimated-tax deadline status is unavailable.",
      amountStatus: "estimated_payment_amount_pending",
    },
  };
}

function classificationReadinessMessage({ postedCount, unclassifiedCount, reviewRequiredCount }) {
  if (postedCount <= 0) {
    return "Confirmed QuickBooks-posted transactions are required before deductible totals can be calculated.";
  }
  if (unclassifiedCount > 0) {
    return `${unclassifiedCount} posted QuickBooks transactions are awaiting tax classification before deductible totals can be calculated.`;
  }
  if (reviewRequiredCount > 0) {
    return `${reviewRequiredCount} tax classifications require review before deductible totals can be calculated.`;
  }
  return "Deductible totals require reviewed transaction tax classifications.";
}

function surfaceMessage(reason, classificationsMessage) {
  const messages = {
    profile_required: "Complete your Tax Profile to prepare an estimate.",
    profile_draft: "Your Tax Profile is saved as a draft.",
    insufficient_financial_data: "Confirmed QuickBooks-posted financial activity is required before an estimate can be calculated.",
    classifications_required: classificationsMessage,
    calculation_required: "A tax estimate has not been generated yet.",
  };
  return messages[reason] || lifecycleMessage(reason);
}

function lifecycleMessage(status) {
  const messages = {
    profile_required: "Complete your Tax Profile to prepare an estimate.",
    profile_draft: "Your Tax Profile is saved. Additional information is required before calculating.",
    insufficient_financial_data: "Confirmed QuickBooks-posted financial activity is required before an estimate can be calculated.",
    classifications_required: "Your Tax Profile is complete. Bizzi is preparing the tax treatment of your posted QuickBooks transactions.",
    calculation_required: "A tax estimate has not been generated yet.",
  };
  return messages[status] || "Tax setup is not ready for calculation.";
}

function lifecycleActions(status) {
  if (status === "profile_required" || status === "profile_draft") return ["complete_tax_profile"];
  if (status === "classifications_required") return ["review_tax_classifications"];
  if (status === "calculation_required") return ["generate_tax_estimate"];
  return [];
}

async function loadRunComponents({ supabase, businessId, runId }) {
  const { data, error } = await supabase
    .from("tax_calculation_components")
    .select("*")
    .eq("business_id", businessId)
    .eq("run_id", runId)
    .order("sort_order", { ascending: true });
  if (error) throw validationError("tax_calculation_components_unavailable", "Calculation components are unavailable.", { runId });
  return data || [];
}

function filterComponents(components, query) {
  return components.filter((row) => {
    const meta = row.metadata || {};
    if (query.group && meta.componentGroup !== query.group) return false;
    if (query.severity && meta.display?.severity !== query.severity) return false;
    if (query.componentType && row.component_type !== query.componentType && meta.componentType !== query.componentType) return false;
    if (String(query.changedOnly || "").toLowerCase() === "true" && !meta.metadata?.changed) return false;
    return true;
  });
}

async function findPreviousRunId({ supabase, businessId, runId }) {
  const { data } = await supabase
    .from("tax_calculation_run_links")
    .select("*")
    .eq("business_id", businessId)
    .eq("newer_run_id", runId)
    .limit(1)
    .maybeSingle();
  return data?.older_run_id || null;
}

function canonicalFromRun(run) {
  return {
    meta: { businessId: run.business_id, taxYear: run.tax_year },
    liability: { projectedTotalTax: run.estimated_total_tax },
    warnings: run.warnings || [],
    missingInputs: run.missing_inputs || [],
    safeHarbor: { combined: { status: run.safe_harbor_target == null ? "unavailable" : "available" } },
  };
}

function confidenceFromRun(run) {
  return {
    score: Number(run.confidence_score || 0),
    level: run.confidence_level || "unavailable",
    status: run.confidence_status || null,
    estimateReady: run.estimate_ready === true,
    reserveReady: run.reserve_ready === true,
    factors: run.confidence_factors || [],
    penalties: run.confidence_penalties || [],
    blockers: run.confidence_blockers || [],
    methodologyVersion: run.confidence_methodology_version || null,
    sourceFreshness: run.source_freshness || {},
    readiness: {
      estimateReady: run.estimate_ready === true,
      reserveReady: run.reserve_ready === true,
    },
  };
}

function optionalBoolean(value, field) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw validationError(`invalid_${field}`, `${field} must be true or false.`, { field });
}
