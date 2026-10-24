import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";
import { buildMockTaxFixture } from "../../services/demo/mockTaxFixture.js";
import {
  TAX_WORKSPACE_DETAIL_TIMEOUT_MS,
  resolveScopedDeductionsRequestStatus,
  withBoundedWorkspaceRead,
} from "../../components/Tax/Deductions/deductionsRequestState.js";
import {
  confirmGroupedTaxDeductionDecision,
  bulkUpdateTaxClassifications,
  confirmTaxClassification,
  excludeTaxClassification,
  exportTaxDeductions,
  getTaxClassificationStatus,
  getTaxClassificationReviewSummary,
  getTaxClassifications,
  getTaxDeductionCategoryDetail,
  getGroupedTaxDeductionDecisionOperation,
  getTaxDeductionTransactionDetail,
  getTaxDeductionTransactions,
  getTaxWorkspace,
  getTaxPostedTransactions,
  overrideTaxClassification,
  prepareTaxClassifications,
  previewGroupedTaxDeductionDecision,
  previewTaxClassificationBackfill,
  rejectTaxClassification,
  restoreTaxClassification,
  runTaxClassification,
  saveTaxDeductionDecisionRule,
  sendTaxClassificationsToReview,
  setTaxProfileMemory,
  updateTaxDeductionDecisionRule,
} from "../../services/tax/taxApiClient.js";

export function useTaxDeductions({
  businessId,
  year = new Date().getFullYear(),
  asOfDate,
  filters = {},
  pagination = { limit: 50, offset: 0 },
  enabled = true,
} = {}) {
  const filterKey = useMemo(() => JSON.stringify(stableObject(filters)), [filters]);
  const paginationKey = useMemo(() => JSON.stringify(stableObject(pagination)), [pagination]);
  const initialCachedOverview = null;
  const [overview, setOverview] = useState(initialCachedOverview);
  const [workspaceProjection, setWorkspaceProjection] = useState(null);
  const [transactions, setTransactions] = useState(null);
  const [allTransactions, setAllTransactions] = useState(null);
  const [postedTransactions, setPostedTransactions] = useState(null);
  const [classificationCoverage, setClassificationCoverage] = useState(null);
  const [classificationJobStatus, setClassificationJobStatus] = useState(null);
  const [classificationRows, setClassificationRows] = useState(null);
  const [classificationReviewSummary, setClassificationReviewSummary] = useState(null);
  const [decisionRules, setDecisionRules] = useState([]);
  const startsWithLiveRequest = enabled && Boolean(businessId) && !shouldUseDemoData();
  const [loading, setLoading] = useState(startsWithLiveRequest && !initialCachedOverview);
  const [refreshing, setRefreshing] = useState(false);
  const [rebuildPending, setRebuildPending] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  const [error, setError] = useState(null);
  const [resourceErrors, setResourceErrors] = useState({});
  const [requestStatus, setRequestStatus] = useState({
    scopeKey: null,
    overview: "idle",
    matrix: "idle",
    classification: "idle",
  });
  const seq = useRef(0);
  const overviewRef = useRef(initialCachedOverview);
  const pollInFlight = useRef(false);
  const refreshInFlight = useRef(null);
  const questionsRetryInFlight = useRef(null);
  const isDemo = shouldUseDemoData();
  const scopeKey = `${businessId || ""}:${year || ""}:${asOfDate || ""}:${enabled ? "enabled" : "disabled"}`;
  const requestEnabled = enabled && Boolean(businessId);
  const scopedRequestStatus = resolveScopedDeductionsRequestStatus({ requestStatus, scopeKey, enabled: requestEnabled });
  const shouldPollClassification = isActiveClassificationStatus(
    classificationJobStatus?.status || classificationCoverage?.jobStatus?.status || classificationCoverage?.classificationStatus
  );

  useEffect(() => {
    overviewRef.current = overview;
  }, [overview]);

  // A completed grouped decision changes one bounded category/account scope,
  // but the question summary is a cross-workspace authority. Refresh just that
  // summary after the command is confirmed; do not optimistically clear other
  // question groups or replace the annual matrix with mixed-age resources.
  const refreshAuthoritativeQuestionSummary = useCallback(async ({ signal } = {}) => {
    if (isDemo || !businessId) return { status: "not_applicable", summary: null };
    const request = seq.current;
    try {
      const summary = await getTaxClassificationReviewSummary({ businessId, year, refresh: true, signal });
      if (request !== seq.current) return { status: "superseded", summary: null };
      setClassificationReviewSummary(summary);
      setResourceErrors((current) => ({ ...(current || {}), classificationReviewSummary: null }));
      return { status: "updated", summary };
    } catch (summaryError) {
      // The committed command remains authoritative even when this read-only
      // refresh is unavailable. Keep the prior summary visible and clearly
      // mark it stale instead of hiding unrelated questions.
      if (request === seq.current) {
        setResourceErrors((current) => ({ ...(current || {}), classificationReviewSummary: summaryError }));
      }
      return { status: "stale", summary: null };
    }
  }, [businessId, isDemo, year]);

  useEffect(() => {
    if (isDemo) return;
    seq.current += 1;
    const cached = null;
    setOverview(cached);
    setWorkspaceProjection(null);
    setTransactions(null);
    setAllTransactions(null);
    setPostedTransactions(null);
    setClassificationCoverage(null);
    setClassificationJobStatus(null);
    setClassificationRows(null);
    setClassificationReviewSummary(null);
    setDecisionRules([]);
    setRequestStatus({
      scopeKey,
      overview: enabled && businessId ? "loading" : "idle",
      matrix: enabled && businessId ? "loading" : "idle",
      classification: enabled && businessId ? "loading" : "idle",
    });
    setLoading(Boolean(enabled && businessId && !cached));
    setError(null);
    setRefreshError(null);
    setRebuildPending(false);
  }, [scopeKey, isDemo, businessId, year, asOfDate, enabled]);

  const load = useCallback(async ({ signal, refresh = false } = {}) => {
    if (isDemo) {
      const fixture = buildMockTaxFixture({ year });
      setOverview(fixture.deductions);
      setTransactions(fixture.deductionTransactions);
      setAllTransactions(fixture.deductionTransactions);
      setPostedTransactions(fixture.deductionTransactions);
      setClassificationCoverage(fixture.deductions?.coverage || null);
      setClassificationJobStatus(fixture.deductions?.coverage?.jobStatus || null);
      setClassificationRows(fixture.deductionTransactions);
      setClassificationReviewSummary(null);
      setDecisionRules([]);
      setRequestStatus({ scopeKey, overview: "success", matrix: "success", classification: "success" });
      setLoading(false);
      setError(null);
      setResourceErrors({});
      return { overview: fixture.deductions, transactions: fixture.deductionTransactions };
    }
    if (!enabled || !businessId) return null;
    const request = ++seq.current;
    const hasVerifiedWorkspace = Boolean(overviewRef.current);
    // A verified cached overview is useful immediately. Revalidation and detail
    // hydration must not hide it or replace its headline values with row-derived
    // placeholders.
    if (!overviewRef.current) setLoading(true);
    if (!refresh || !hasVerifiedWorkspace) {
      setRequestStatus({ scopeKey, overview: "loading", matrix: "loading", classification: "loading" });
    }
    setError(null);
    setResourceErrors({});
    try {
      const overviewPromise = settle(getTaxWorkspace({ businessId, year, refresh, signal }));
      const overviewResult = await overviewPromise;
      if (request === seq.current) {
        if (overviewResult.status === "fulfilled") {
          const workspace = overviewResult.value?.projection;
          const compatibleOverview = overviewFromWorkspace(workspace);
          setWorkspaceProjection(workspace);
          setRebuildPending(overviewResult.value?.state === "refreshing");
          // Initial loads may expose a verified summary while optional details
          // settle. A refresh keeps the prior completed workspace intact until
          // its replacement matrix succeeds, preventing mixed generations.
          setOverview(compatibleOverview);
          setRequestStatus((current) => ({ ...current, scopeKey, overview: "success", matrix: "success", classification: "success" }));
          if (refresh) setLastRefreshedAt(workspace?.refreshedAt || workspace?.generatedAt || new Date().toISOString());
        } else if (overviewResult.reason?.code !== "request_aborted") {
          setRequestStatus((current) => ({ ...current, scopeKey, overview: "error" }));
          if (!overviewRef.current) setError(overviewResult.reason);
        }
        setLoading(false);
      }
      const primaryError = overviewResult.status === "rejected" ? overviewResult.reason : null;
      if (request === seq.current && refresh) setRefreshError(primaryError);
      return {
        overview: overviewResult.status === "fulfilled" ? overviewFromWorkspace(overviewResult.value?.projection) : null,
        transactions: null,
        allTransactions: null,
        postedTransactions: null,
        classificationCoverage: null,
        classificationRows: null,
        classificationReviewSummary: null,
        decisionRules: null,
      };
    } catch (err) {
      if (err?.code !== "request_aborted" && request === seq.current) setError(err);
      if (refresh && err?.code !== "request_aborted" && request === seq.current) setRefreshError(err);
      return null;
    } finally {
      if (request === seq.current) setLoading(false);
    }
  }, [businessId, year, enabled, isDemo, scopeKey]);

  const loadSecondaryDetails = useCallback(async ({ signal, refresh = false } = {}) => {
    if (isDemo || !enabled || !businessId) return null;
    const request = seq.current;
    const parsedFilters = filterKey ? JSON.parse(filterKey) : {};
    const parsedPagination = paginationKey ? JSON.parse(paginationKey) : {};
    const [transactionsResult, postedTransactionsResult, classificationRowsResult] = await Promise.allSettled([
      getTaxDeductionTransactions({
        businessId,
        year,
        asOfDate,
        filters: parsedFilters,
        limit: parsedPagination.limit,
        offset: parsedPagination.offset,
        refresh,
        signal,
      }),
      fetchAllPostedTransactions({ businessId, year, refresh, signal }),
      getTaxClassifications({ businessId, year, limit: 200, offset: 0, refresh, signal }),
    ]);
    if (request !== seq.current) return null;
    if (transactionsResult.status === "fulfilled") setTransactions(withTaxSnapshot(transactionsResult.value, request));
    if (postedTransactionsResult.status === "fulfilled") setPostedTransactions(withTaxSnapshot(postedTransactionsResult.value, request));
    if (classificationRowsResult.status === "fulfilled") setClassificationRows(withTaxSnapshot(classificationRowsResult.value, request));
    const errors = collectResourceErrors({
      transactions: transactionsResult,
      postedTransactions: postedTransactionsResult,
      classificationRows: classificationRowsResult,
    });
    if (Object.keys(errors).length) {
      setResourceErrors((current) => ({ ...current, ...errors }));
      setRefreshError(Object.values(errors)[0] || null);
    }
    return {
      transactions: valueOrNull(transactionsResult),
      postedTransactions: valueOrNull(postedTransactionsResult),
      classificationRows: valueOrNull(classificationRowsResult),
    };
  }, [businessId, year, asOfDate, filterKey, paginationKey, enabled, isDemo]);

  const retryQuestions = useCallback(({ signal } = {}) => {
    if (questionsRetryInFlight.current) return questionsRetryInFlight.current;
    if (isDemo || !enabled || !businessId) return Promise.resolve(null);
    const request = seq.current;
    setRequestStatus((current) => ({ ...current, scopeKey, matrix: "loading" }));
    setResourceErrors((current) => ({ ...(current || {}), allTransactions: null }));
    const parsedFilters = filterKey ? JSON.parse(filterKey) : {};
    const operation = withBoundedWorkspaceRead(
      (workspaceSignal) => fetchAllDeductionTransactions({
        businessId,
        year,
        asOfDate,
        filters: parsedFilters,
        refresh: true,
        signal: workspaceSignal,
      }),
      { signal, timeoutMs: TAX_WORKSPACE_DETAIL_TIMEOUT_MS, timeoutCode: "tax_deductions_questions_timeout" }
    ).then((value) => {
      if (request !== seq.current) return null;
      setAllTransactions(withTaxSnapshot(value, request));
      setRequestStatus((current) => ({ ...current, scopeKey, matrix: "success" }));
      return value;
    }).catch((questionsError) => {
      if (request === seq.current && questionsError?.code !== "request_aborted") {
        setResourceErrors((current) => ({ ...(current || {}), allTransactions: questionsError }));
        setRequestStatus((current) => ({ ...current, scopeKey, matrix: "error" }));
      }
      return null;
    }).finally(() => {
      if (questionsRetryInFlight.current === operation) questionsRetryInFlight.current = null;
    });
    questionsRetryInFlight.current = operation;
    return operation;
  }, [asOfDate, businessId, enabled, filterKey, isDemo, scopeKey, year]);

  useEffect(() => {
    const controller = new AbortController();
    const hasSavedOverview = Boolean(overviewRef.current);
    if (hasSavedOverview) setRefreshing(true);
    // The verified overview and every optional detail population start together.
    // No transaction-row request is allowed to gate first overview paint.
    Promise.resolve(load({ signal: controller.signal, refresh: hasSavedOverview })).finally(() => {
      if (!controller.signal.aborted && hasSavedOverview) setRefreshing(false);
    });
    return () => controller.abort();
  }, [asOfDate, businessId, load, year]);

  useEffect(() => {
    if (isDemo || !enabled || !businessId || !shouldPollClassification) return undefined;
    let cancelled = false;
    let timer = null;
    let delayMs = Math.max(1000, Number(classificationJobStatus?.pollAfterMs || classificationCoverage?.jobStatus?.pollAfterMs || 2000));
    const poll = async () => {
      if (cancelled) return;
      if (pollInFlight.current) {
        timer = setTimeout(poll, delayMs);
        return;
      }
      pollInFlight.current = true;
      try {
        const status = await getTaxClassificationStatus({ businessId, year });
        if (cancelled) return;
        setClassificationJobStatus(status || null);
        setClassificationCoverage((current) => ({
          ...(current || {}),
          jobStatus: status || null,
          classificationStatus: mapJobStatusToLifecycle(status?.status, current?.classificationStatus),
          processingCount: status?.status === "processing" ? Number(status.remaining || 0) : 0,
          remainingCount: Number(status?.remaining || 0),
          failedCount: Number(status?.failed ?? current?.failedCount ?? 0),
          lastRunAt: status?.completedAt || status?.failedAt || status?.heartbeatAt || status?.queuedAt || current?.lastRunAt || null,
        }));
        if (isTerminalJobStatus(status?.status)) {
          await load({ refresh: true });
          await loadSecondaryDetails({ refresh: true });
          return;
        }
        delayMs = Math.min(8000, Math.max(delayMs + 1000, Number(status?.pollAfterMs || 2000)));
      } catch {
        delayMs = Math.min(10000, delayMs + 2000);
      } finally {
        pollInFlight.current = false;
      }
      if (!cancelled) timer = setTimeout(poll, delayMs);
    };
    timer = setTimeout(poll, delayMs);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [businessId, classificationCoverage?.jobStatus?.pollAfterMs, classificationJobStatus?.pollAfterMs, enabled, isDemo, load, loadSecondaryDetails, shouldPollClassification, year]);

  return {
    overview,
    workspaceProjection,
    transactions,
    allTransactions,
    postedTransactions,
    classificationCoverage,
    classificationJobStatus,
    classificationRows,
    classificationReviewSummary,
    decisionRules,
    loading,
    error,
    resourceErrors,
    sectionStatus: {
      overview: scopedRequestStatus.overview,
      matrix: scopedRequestStatus.matrix,
      classification: scopedRequestStatus.classification,
    },
    refreshing,
    rebuildPending,
    refreshError,
    lastRefreshedAt,
    isDemo,
    refetch: load,
    retryTransactionDetails: (options = {}) => loadSecondaryDetails({ ...options, refresh: true }),
    retryQuestions,
    refresh: (options = {}) => {
      if (refreshInFlight.current) return refreshInFlight.current;
      setRefreshing(true);
      setRefreshError(null);
      const operation = load({ ...options, refresh: true })
        .catch((err) => {
          setRefreshError(err);
          throw err;
        })
        .finally(() => {
          refreshInFlight.current = null;
          setRefreshing(false);
        });
      refreshInFlight.current = operation;
      return operation;
    },
    getTransactionDetail: (transactionId, options = {}) =>
      getTaxDeductionTransactionDetail({ businessId, year, transactionId, ...options }),
    getCategoryDetail: (taxCategory, options = {}) =>
      getTaxDeductionCategoryDetail({ businessId, year, asOfDate, taxCategory, ...options }),
    confirmClassification: async (transactionId, options = {}) => {
      const result = await confirmTaxClassification({ businessId, year, transactionId, ...options });
      await load();
      return result;
    },
    rejectClassification: async (transactionId, options = {}) => {
      const result = await rejectTaxClassification({ businessId, year, transactionId, ...options });
      await load();
      return result;
    },
    overrideClassification: async (transactionId, changes = {}, options = {}) => {
      const result = await overrideTaxClassification({ businessId, year, transactionId, changes, ...options });
      await load();
      return result;
    },
    saveDeductionDecisionRule: async ({ transactionId, changes = {}, decisionType, ...options } = {}) => {
      const result = await saveTaxDeductionDecisionRule({ businessId, year, transactionId, changes, decisionType, ...options });
      await load();
      return result;
    },
    // A deduction default can intentionally cover more than one QBO GL account
    // (for example Electric, Internet, and Water/Sewer under Utilities). Keep
    // the persisted rules GL-scoped so the rule engine remains precise, but
    // reload once after the grouped setup flow completes.
    saveDeductionDecisionRules: async ({ rules = [], ...options } = {}) => {
      const requestedRules = Array.isArray(rules)
        ? rules.filter((rule) => rule?.transactionId)
        : [];
      const attempts = await Promise.allSettled(requestedRules.map((rule) => saveTaxDeductionDecisionRule({
        businessId,
        year,
        transactionId: rule.transactionId,
        changes: rule.changes || {},
        decisionType: rule.decisionType,
        ...options,
      })));
      await load();
      const saved = attempts
        .filter((attempt) => attempt.status === "fulfilled")
        .map((attempt) => attempt.value);
      const failed = attempts
        .filter((attempt) => attempt.status === "rejected")
        .map((attempt) => attempt.reason);
      return { requested: requestedRules.length, saved, failed };
    },
    updateDeductionDecisionRule: async ({ ruleId, changes = {}, decisionType, ...options } = {}) => {
      const result = await updateTaxDeductionDecisionRule({ businessId, year, ruleId, changes, decisionType, ...options });
      await load();
      return result;
    },
    excludeClassification: async (transactionId, options = {}) => {
      const result = await excludeTaxClassification({ businessId, year, transactionId, ...options });
      await load();
      return result;
    },
    restoreClassification: async (transactionId, options = {}) => {
      const result = await restoreTaxClassification({ businessId, year, transactionId, ...options });
      await load();
      return result;
    },
    assignTaxClassification: async (transactionId, changes = {}, options = {}) => {
      if (isDemo) {
        const updatePage = (page) => updateDemoDeductionPage(page, transactionId, changes);
        setTransactions(updatePage);
        setAllTransactions(updatePage);
        setPostedTransactions(updatePage);
        return { classification: buildDemoClassificationResult(transactionId, changes) };
      }
      await runTaxClassification({ businessId, year, transactionIds: [transactionId], force: false, ...options });
      const result = await overrideTaxClassification({
        businessId,
        year,
        transactionId,
        changes: {
          ...changes,
          reason: changes.reason || "Assigned from Deductions review.",
        },
        ...options,
      });
      await load();
      return result;
    },
    bulkUpdateClassifications: async (transactionIds, changes = {}, options = {}) => {
      const result = await bulkUpdateTaxClassifications({ businessId, year, transactionIds, changes, ...options });
      if (options.skipReload !== true) await load();
      return result;
    },
    previewGroupedDeductionDecision: ({ groupId, signal } = {}) =>
      previewGroupedTaxDeductionDecision({ businessId, year, groupId, signal }),
    confirmGroupedDeductionDecision: async ({ previewId, idempotencyKey, answer, businessUsePercent, personalExceptionIds, signal } = {}) => {
      const result = await confirmGroupedTaxDeductionDecision({ businessId, year, previewId, idempotencyKey, answer, businessUsePercent, personalExceptionIds, signal });
      applyGroupedDecisionResult({ result, setTransactions, setAllTransactions, setClassificationRows, setDecisionRules });
      const questionSummary = await refreshAuthoritativeQuestionSummary({ signal });
      return { ...result, questionSummary };
    },
    getGroupedDeductionDecisionOperation: async ({ idempotencyKey, signal } = {}) => {
      const operation = await getGroupedTaxDeductionDecisionOperation({ businessId, year, idempotencyKey, signal });
      if (operation?.status === "completed" && operation?.result) {
        applyGroupedDecisionResult({
          result: operation.result,
          setTransactions,
          setAllTransactions,
          setClassificationRows,
          setDecisionRules,
        });
        await refreshAuthoritativeQuestionSummary({ signal });
      }
      return operation;
    },
    sendClassificationsToTaxReview: async (transactionIds, options = {}) => {
      const result = await sendTaxClassificationsToReview({ businessId, year, transactionIds, ...options });
      if (options.skipReload !== true) await load();
      return result;
    },
    setProfileMemory: async ({ memoryKey, value, source = "user", confidenceScore = 100, effectiveFrom, notes, metadata, signal } = {}) => {
      const result = await setTaxProfileMemory({
        businessId,
        memoryKey,
        value,
        source,
        confidenceScore,
        effectiveFrom,
        notes,
        metadata,
        signal,
      });
      await load();
      return result;
    },
    previewClassificationBackfill: (options = {}) =>
      previewTaxClassificationBackfill({ businessId, year, ...options }),
    prepareDeductions: async (options = {}) => {
      const result = await prepareTaxClassifications({ businessId, year, ...options });
      const job = result?.job || result;
      setClassificationJobStatus(job || null);
      setClassificationCoverage((current) => ({
        ...(current || {}),
        jobStatus: job || null,
        classificationStatus: mapJobStatusToLifecycle(job?.status, current?.classificationStatus),
        processingCount: job?.status === "processing" ? Number(job.remaining || 0) : 0,
        remainingCount: Number(job?.remaining || 0),
        failedCount: Number(job?.failed ?? current?.failedCount ?? 0),
      }));
      return result;
    },
    exportDeductions: (options = {}) => exportTaxDeductions({ businessId, year, asOfDate, filters: filterKey ? JSON.parse(filterKey) : {}, ...options }),
  };
}

// This intentionally accepts both the normal deductions DTO and the
// classification-list DTO. Both represent the same stable transaction ID, but
// their casing differs at the API boundary.
export function patchTaxPageWithGroupedDecision(page, classifications = []) {
  if (!page || !Array.isArray(page.rows) || !Array.isArray(classifications) || !classifications.length) return page;
  const byTransactionId = new Map(
    classifications
      .filter((classification) => classification && typeof classification === "object")
      .map((classification) => [String(classification.transaction_id || classification.transactionId || ""), classification])
      .filter(([transactionId]) => transactionId)
  );
  if (!byTransactionId.size) return page;
  return {
    ...page,
    rows: page.rows.map((row) => {
      const transactionId = stableTaxRowId(row);
      const classification = transactionId ? byTransactionId.get(transactionId) : null;
      return classification ? patchTaxRowWithClassification(row, classification) : row;
    }),
  };
}

function applyGroupedDecisionResult({ result, setTransactions, setAllTransactions, setClassificationRows, setDecisionRules }) {
  const classifications = Array.isArray(result?.classifications) ? result.classifications : [];
  if (!classifications.length) return;
  const patchPage = (page) => patchTaxPageWithGroupedDecision(page, classifications);
  setTransactions(patchPage);
  setAllTransactions(patchPage);
  setClassificationRows(patchPage);
  if (result?.rule && typeof result.rule === "object") {
    setDecisionRules((current) => upsertGroupedDecisionRule(current, result.rule));
  }
}

function patchTaxRowWithClassification(row = {}, classification = {}) {
  const metadata = {
    ...(row?.metadata && typeof row.metadata === "object" ? row.metadata : {}),
    ...(classification.metadata && typeof classification.metadata === "object" ? classification.metadata : {}),
  };
  const taxTreatment = classification.tax_treatment ?? classification.taxTreatment ?? row.taxTreatment ?? row.tax_treatment ?? null;
  const classificationStatus = classification.classification_status ?? classification.classificationStatus ?? row.classificationStatus ?? row.classification_status ?? null;
  const source = classification.source ?? row.source ?? row.source_type ?? null;
  const updatedAt = classification.updated_at ?? classification.updatedAt ?? row.updatedAt ?? row.updated_at ?? null;
  const taxCategory = classification.tax_category ?? classification.taxCategory ?? row.taxCategory ?? row.tax_category ?? null;
  const deductibilityStatus = classification.deductibility_status ?? classification.deductibilityStatus ?? row.deductibilityStatus ?? row.deductibility_status ?? null;
  const deductiblePercent = classification.deductible_percent ?? classification.deductiblePercent ?? row.deductiblePercent ?? row.deductible_percent ?? null;
  const deductibleAmount = classification.deductible_amount ?? classification.deductibleAmount ?? row.deductibleAmount ?? row.deductible_amount ?? null;
  const nondeductibleAmount = classification.nondeductible_amount ?? classification.nondeductibleAmount ?? row.nondeductibleAmount ?? row.nondeductible_amount ?? null;
  const capitalizableAmount = classification.capitalizable_amount ?? classification.capitalizableAmount ?? row.capitalizableAmount ?? row.capitalizable_amount ?? null;
  const requiresReview = classification.requires_review ?? classification.requiresReview ?? row.requiresReview ?? row.requires_review ?? false;
  const userOverride = classification.user_override ?? classification.userOverride ?? row.userOverride ?? row.user_override ?? false;
  const cpaOverride = classification.cpa_override ?? classification.cpaOverride ?? row.cpaOverride ?? row.cpa_override ?? false;
  return {
    ...row,
    taxCategory,
    tax_category: taxCategory,
    taxTreatment,
    tax_treatment: taxTreatment,
    deductibilityStatus,
    deductibility_status: deductibilityStatus,
    deductiblePercent,
    deductible_percent: deductiblePercent,
    deductibleAmount,
    deductible_amount: deductibleAmount,
    nondeductibleAmount,
    nondeductible_amount: nondeductibleAmount,
    capitalizableAmount,
    capitalizable_amount: capitalizableAmount,
    classificationStatus,
    classification_status: classificationStatus,
    status: classificationStatus || row.status,
    confidenceScore: classification.confidence_score ?? classification.confidenceScore ?? row.confidenceScore ?? row.confidence_score ?? null,
    confidence_score: classification.confidence_score ?? classification.confidenceScore ?? row.confidence_score ?? row.confidenceScore ?? null,
    confidenceLevel: classification.confidence_level ?? classification.confidenceLevel ?? row.confidenceLevel ?? row.confidence_level ?? null,
    confidence_level: classification.confidence_level ?? classification.confidenceLevel ?? row.confidence_level ?? row.confidenceLevel ?? null,
    requiresReview: requiresReview === true,
    requires_review: requiresReview === true,
    userOverride: userOverride === true,
    user_override: userOverride === true,
    cpaOverride: cpaOverride === true,
    cpa_override: cpaOverride === true,
    source,
    source_type: source,
    reason: classification.reason ?? row.reason ?? null,
    updatedAt,
    updated_at: updatedAt,
    metadata,
    override: {
      ...(row?.override && typeof row.override === "object" ? row.override : {}),
      hasOverride: userOverride === true || cpaOverride === true,
      source,
      lastChangedAt: updatedAt,
    },
  };
}

function stableTaxRowId(row = {}) {
  const value = row?.transactionId ?? row?.transaction_id ?? row?.id ?? row?.raw?.transactionId ?? row?.raw?.transaction_id ?? row?.raw?.id;
  return value == null || value === "" ? null : String(value);
}

function upsertGroupedDecisionRule(rules, rule) {
  const current = Array.isArray(rules) ? rules : [];
  const accountKey = String(rule.accountKey || rule.accountName || "").trim().toLowerCase();
  const withoutPrevious = current.filter((currentRule) => {
    const currentKey = String(currentRule?.accountKey || currentRule?.accountName || "").trim().toLowerCase();
    return currentKey !== accountKey;
  });
  return [...withoutPrevious, rule].sort((a, b) => String(a?.accountName || "").localeCompare(String(b?.accountName || "")));
}

function isActiveClassificationStatus(status) {
  return ["queued", "processing", "delayed", "stalled", "classification_queued", "classifying"].includes(status);
}

function isTerminalJobStatus(status) {
  return ["completed", "completed_with_review", "failed"].includes(status);
}

function mapJobStatusToLifecycle(status, fallback = null) {
  if (status === "queued") return "classification_queued";
  if (status === "delayed") return "classification_queued";
  if (status === "processing") return "classifying";
  if (status === "stalled") return "classifying";
  if (status === "completed") return "classification_complete";
  if (status === "completed_with_review") return "classification_review_required";
  if (status === "failed") return "classification_failed";
  return fallback;
}

async function fetchAllDeductionTransactions({ businessId, year, asOfDate, filters, refresh = false, signal }) {
  const limit = 200;
  const rows = [];
  let latestPage = null;
  for (let offset = 0; ; offset += limit) {
    const page = await withBoundedReadRetry(
      () => getTaxDeductionTransactions({ businessId, year, asOfDate, filters, limit, offset, refresh, signal }),
      { signal }
    );
    const pageRows = Array.isArray(page?.rows) ? page.rows : [];
    rows.push(...pageRows);
    latestPage = page;
    if (!page?.pagination?.hasMore || !pageRows.length) break;
  }
  return {
    ...(latestPage || {}),
    rows,
    pagination: {
      ...(latestPage?.pagination || {}),
      limit,
      offset: 0,
      returned: rows.length,
      total: latestPage?.pagination?.total ?? rows.length,
      hasMore: false,
    },
  };
}

export async function withBoundedReadRetry(operation, { signal, delayMs = 150 } = {}) {
  try {
    return await operation();
  } catch (error) {
    if (signal?.aborted || error?.code === "request_aborted" || error?.retryable !== true) throw error;
    await abortableDelay(delayMs, signal);
    return operation();
  }
}

function abortableDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error("Request aborted."), { code: "request_aborted" }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Request aborted."), { code: "request_aborted" }));
    }, { once: true });
  });
}

async function fetchAllPostedTransactions({ businessId, year, refresh = false, signal }) {
  const limit = 200;
  const rows = [];
  let latestPage = null;
  for (let offset = 0; ; offset += limit) {
    const page = await getTaxPostedTransactions({ businessId, year, limit, offset, refresh, signal });
    const pageRows = Array.isArray(page?.rows) ? page.rows : [];
    rows.push(...pageRows);
    latestPage = page;
    if (!page?.pagination?.hasMore || !pageRows.length) break;
  }
  return {
    ...(latestPage || {}),
    rows,
    pagination: {
      ...(latestPage?.pagination || {}),
      limit,
      offset: 0,
      returned: rows.length,
      total: latestPage?.pagination?.total ?? rows.length,
      hasMore: false,
    },
  };
}

function valueOrNull(result) {
  return result?.status === "fulfilled" ? result.value : null;
}

function settle(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason })
  );
}

function collectResourceErrors(results = {}) {
  return Object.fromEntries(
    Object.entries(results)
      .filter(([, result]) => result?.status === "rejected" && result.reason?.code !== "request_aborted")
      .map(([keyName, result]) => [keyName, result.reason])
  );
}

function stableObject(value) {
  if (!value || typeof value !== "object") return {};
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = value[key];
    return acc;
  }, {});
}

function overviewFromWorkspace(workspace) {
  if (!workspace) return null;
  return {
    meta: {
      businessId: workspace.canonicalBusinessId,
      taxYear: workspace.taxYear,
      generatedAt: workspace.generatedAt,
      engineVersion: workspace.formulaVersion,
      source: "tax_workspace_projection",
    },
    projection: {
      projectionId: workspace.sourceFingerprint,
      projectionVersion: workspace.projectionVersion,
      canonicalBusinessId: workspace.canonicalBusinessId,
      taxYear: workspace.taxYear,
      refreshedAt: workspace.refreshedAt,
      generatedAt: workspace.generatedAt,
      completeness: workspace.completeness,
      estimatedDeductibleAmount: workspace.estimatedDeductibleAmount,
      evaluatedTransactionCount: workspace.evaluatedTransactionCount,
      matrixIncludedCount: workspace.matrixIncludedCount,
      outsideDeductionsCount: workspace.outsideDeductionsCount,
      questionsForYouGroupCount: workspace.questionGroupCount,
    },
    totals: { estimatedDeductibleAmount: workspace.estimatedDeductibleAmount },
    categories: workspace.matrix || [],
    warnings: workspace.warnings || [],
  };
}

// Primary classifications and posted-source rows are fetched independently.
// Tag both with the same request sequence so a background refresh cannot join
// fresh classifications to stale posted rows in the matrix.
function withTaxSnapshot(value, snapshotId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return { ...value, taxSnapshotId: snapshotId };
}

function updateDemoDeductionPage(page, transactionId, changes = {}) {
  if (!page || !Array.isArray(page.rows)) return page;
  const rows = page.rows.map((row) => {
    const rowId = row?.transactionId || row?.id;
    return String(rowId) === String(transactionId) ? applyDemoTaxClassification(row, changes) : row;
  });
  return { ...page, rows };
}

function applyDemoTaxClassification(row, changes = {}) {
  const taxCategory = changes.taxCategory || row.taxCategory || "unclassified";
  const deductibilityStatus = changes.deductibilityStatus || row.deductibilityStatus || "needs_review";
  const deductiblePercent = changes.deductiblePercent ?? row.deductiblePercent ?? null;
  const amount = row.absoluteAmount ?? Math.abs(Number(row.signedAmount || row.amount || 0));
  const deductibleAmount = deductiblePercent == null
    ? null
    : Math.round(Number(amount || 0) * Number(deductiblePercent)) / 100;
  const requiresReview = deductibilityStatus === "needs_review" || deductiblePercent == null;
  return {
    ...row,
    taxCategory,
    taxCategoryLabel: labelTaxCategory(taxCategory),
    deductibilityStatus,
    deductiblePercent,
    deductibleAmount,
    classificationStatus: requiresReview ? "needs_review" : "user_confirmed",
    status: requiresReview ? "needs_review" : "user_confirmed",
    statusLabel: requiresReview ? "Needs review" : "User confirmed",
    taxTreatment: changes.taxTreatment || row.taxTreatment || "ordinary_expense",
    taxTreatmentLabel: treatmentLabel(changes.taxTreatment || row.taxTreatment),
    requiresReview,
    confidenceScore: requiresReview ? Math.min(Number(row.confidenceScore || 60), 60) : 100,
    confidenceLevel: requiresReview ? "medium" : "high",
    source: "demo",
  };
}

function buildDemoClassificationResult(transactionId, changes = {}) {
  return {
    transactionId,
    taxCategory: changes.taxCategory || "unclassified",
    deductibilityStatus: changes.deductibilityStatus || "needs_review",
    deductiblePercent: changes.deductiblePercent ?? null,
    taxTreatment: changes.taxTreatment || "ordinary_expense",
    classificationStatus: changes.deductibilityStatus === "needs_review" ? "needs_review" : "user_confirmed",
    source: "demo",
  };
}

function labelTaxCategory(value) {
  return String(value || "unclassified")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Unclassified";
}

function treatmentLabel(value) {
  const normalized = String(value || "ordinary_expense").replace(/_/g, " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export default useTaxDeductions;
