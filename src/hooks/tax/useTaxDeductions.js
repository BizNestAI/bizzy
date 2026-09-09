import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";
import { buildMockTaxFixture } from "../../services/demo/mockTaxFixture.js";
import {
  bulkUpdateTaxClassifications,
  confirmTaxClassification,
  excludeTaxClassification,
  exportTaxDeductions,
  getTaxClassificationCoverage,
  getTaxClassificationStatus,
  getTaxClassificationReviewSummary,
  getTaxClassifications,
  getTaxDeductionCategoryDetail,
  getTaxDeductionTransactionDetail,
  getTaxDeductionTransactions,
  getTaxDeductionsOverview,
  getTaxPostedTransactions,
  overrideTaxClassification,
  prepareTaxClassifications,
  previewTaxClassificationBackfill,
  rejectTaxClassification,
  restoreTaxClassification,
  runTaxClassification,
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
  const [overview, setOverview] = useState(null);
  const [transactions, setTransactions] = useState(null);
  const [allTransactions, setAllTransactions] = useState(null);
  const [postedTransactions, setPostedTransactions] = useState(null);
  const [classificationCoverage, setClassificationCoverage] = useState(null);
  const [classificationJobStatus, setClassificationJobStatus] = useState(null);
  const [classificationRows, setClassificationRows] = useState(null);
  const [classificationReviewSummary, setClassificationReviewSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  const [error, setError] = useState(null);
  const [resourceErrors, setResourceErrors] = useState({});
  const seq = useRef(0);
  const pollInFlight = useRef(false);
  const isDemo = shouldUseDemoData();
  const shouldPollClassification = isActiveClassificationStatus(
    classificationJobStatus?.status || classificationCoverage?.jobStatus?.status || classificationCoverage?.classificationStatus
  );

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
      setLoading(false);
      setError(null);
      setResourceErrors({});
      return { overview: fixture.deductions, transactions: fixture.deductionTransactions };
    }
    if (!enabled || !businessId) return null;
    const request = ++seq.current;
    setLoading(true);
    setError(null);
    setResourceErrors({});
    try {
      const parsedFilters = filterKey ? JSON.parse(filterKey) : {};
      const parsedPagination = paginationKey ? JSON.parse(paginationKey) : {};
      const [overviewResult, transactionsResult, allTransactionsResult, postedTransactionsResult, coverageResult, classificationRowsResult, reviewSummaryResult] = await Promise.allSettled([
        getTaxDeductionsOverview({ businessId, year, asOfDate, refresh, signal }),
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
        fetchAllDeductionTransactions({ businessId, year, asOfDate, filters: parsedFilters, refresh, signal }),
        fetchAllPostedTransactions({ businessId, year, refresh, signal }),
        getTaxClassificationCoverage({ businessId, year, refresh, signal }),
        getTaxClassifications({ businessId, year, limit: 200, offset: 0, refresh, signal }),
        getTaxClassificationReviewSummary({ businessId, year, refresh, signal }),
      ]);
      if (request === seq.current) {
        if (overviewResult.status === "fulfilled") setOverview(overviewResult.value);
        if (transactionsResult.status === "fulfilled") setTransactions(transactionsResult.value);
        if (allTransactionsResult.status === "fulfilled") setAllTransactions(allTransactionsResult.value);
        if (postedTransactionsResult.status === "fulfilled") setPostedTransactions(postedTransactionsResult.value);
        if (coverageResult.status === "fulfilled") {
          setClassificationCoverage(coverageResult.value);
          setClassificationJobStatus(coverageResult.value?.jobStatus || null);
        }
        if (classificationRowsResult.status === "fulfilled") setClassificationRows(classificationRowsResult.value);
        if (reviewSummaryResult.status === "fulfilled") setClassificationReviewSummary(reviewSummaryResult.value);
        const errors = collectResourceErrors({
          overview: overviewResult,
          transactions: transactionsResult,
          allTransactions: allTransactionsResult,
          postedTransactions: postedTransactionsResult,
          classificationCoverage: coverageResult,
          classificationRows: classificationRowsResult,
          classificationReviewSummary: reviewSummaryResult,
        });
        setResourceErrors(errors);
        setError(Object.values(errors)[0] || null);
        if (refresh && !Object.keys(errors).length) {
          setLastRefreshedAt(new Date().toISOString());
          setRefreshError(null);
        }
      }
      return {
        overview: valueOrNull(overviewResult),
        transactions: valueOrNull(transactionsResult),
        allTransactions: valueOrNull(allTransactionsResult),
        postedTransactions: valueOrNull(postedTransactionsResult),
        classificationCoverage: valueOrNull(coverageResult),
        classificationRows: valueOrNull(classificationRowsResult),
        classificationReviewSummary: valueOrNull(reviewSummaryResult),
      };
    } catch (err) {
      if (err?.code !== "request_aborted" && request === seq.current) setError(err);
      if (refresh && err?.code !== "request_aborted" && request === seq.current) setRefreshError(err);
      return null;
    } finally {
      if (request === seq.current) setLoading(false);
    }
  }, [businessId, year, asOfDate, filterKey, paginationKey, enabled, isDemo]);

  useEffect(() => {
    const controller = new AbortController();
    load({ signal: controller.signal });
    return () => controller.abort();
  }, [load]);

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
  }, [businessId, classificationCoverage?.jobStatus?.pollAfterMs, classificationJobStatus?.pollAfterMs, enabled, isDemo, load, shouldPollClassification, year]);

  return {
    overview,
    transactions,
    allTransactions,
    postedTransactions,
    classificationCoverage,
    classificationJobStatus,
    classificationRows,
    classificationReviewSummary,
    loading,
    error,
    resourceErrors,
    refreshing,
    refreshError,
    lastRefreshedAt,
    isDemo,
    refetch: load,
    refresh: async (options = {}) => {
      setRefreshing(true);
      setRefreshError(null);
      try {
        return await load({ ...options, refresh: true });
      } catch (err) {
        setRefreshError(err);
        throw err;
      } finally {
        setRefreshing(false);
      }
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
    const page = await getTaxDeductionTransactions({ businessId, year, asOfDate, filters, limit, offset, refresh, signal });
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
