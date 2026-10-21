import authenticatedFetch from "../api/authenticatedFetch.js";
import { normalizeTaxOverview } from "./normalizeTaxOverview.js";

export const TAX_API_VERSION = "2026-01";

const ALLOWED_INCLUDES = new Set([
  "components",
  "explanations",
  "confidenceFactors",
  "ruleSupport",
  "paymentDetails",
  "reserveHistory",
  "deductions",
  "deadlines",
]);

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 50;
const TAX_DETAIL_PAGE_LIMIT = 200;
const cache = new Map();
const inflight = new Map();

export function clearTaxApiCache(predicate = null) {
  if (!predicate) {
    cache.clear();
    inflight.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (predicate(key)) cache.delete(key);
  }
  for (const key of inflight.keys()) {
    if (predicate(key)) inflight.delete(key);
  }
}

export async function getTaxOverview({
  businessId,
  year,
  asOfDate,
  refresh = false,
  include = [],
  apiVersion = TAX_API_VERSION,
  signal,
} = {}) {
  requireBusinessId(businessId);
  const params = taxQuery({ businessId, year, asOfDate, refresh, include, apiVersion });
  const cacheKey = key("overview", params);
  const payload = await cachedGet(`/api/tax/overview?${params}`, { signal, cacheKey, bypassCache: refresh });
  const { data, contractWarnings } = normalizeTaxOverview(payload);
  if (contractWarnings.length) data.contractWarnings = contractWarnings;
  return data;
}

export async function runTaxCalculation({
  businessId,
  year,
  asOfDate,
  calculationType,
  projectionMethod,
  projectionScenario,
  manualOverrides,
  triggerSource,
  force,
  include = [],
  signal,
} = {}) {
  requireBusinessId(businessId);
  const body = compact({
    businessId,
    year,
    asOfDate,
    calculationType,
    projectionMethod,
    projectionScenario,
    manualOverrides,
    triggerSource,
    force,
    include: normalizeInclude(include),
  });
  const payload = await request("/api/tax/calculations", { method: "POST", body, signal });
  clearBusinessCache(businessId);
  return payload?.data ?? payload;
}

export async function getTaxCalculation({ businessId, runId, include = [], signal } = {}) {
  requireBusinessId(businessId);
  requireValue(runId, "runId");
  const params = taxQuery({ businessId, include });
  return unwrap(await cachedGet(`/api/tax/calculations/${encodeURIComponent(runId)}?${params}`, { signal }));
}

export async function getLatestTaxCalculation({ businessId, year, refresh = false, include = [], signal } = {}) {
  requireBusinessId(businessId);
  const params = taxQuery({ businessId, year, refresh, include });
  return unwrap(await cachedGet(`/api/tax/calculations/latest?${params}`, { signal, bypassCache: refresh }));
}

export async function getTaxCalculationComponents({ businessId, runId, group, limit, offset, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(runId, "runId");
  const params = query({ businessId, group, limit, offset });
  return unwrap(await cachedGet(`/api/tax/calculations/${encodeURIComponent(runId)}/components?${params}`, { signal }));
}

export async function getTaxCalculationExplanation({ businessId, runId, group, changedOnly, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(runId, "runId");
  const params = query({ businessId, group, changedOnly });
  return unwrap(await cachedGet(`/api/tax/calculations/${encodeURIComponent(runId)}/explanation?${params}`, { signal }));
}

export async function getTaxCalculationConfidence({ businessId, runId, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(runId, "runId");
  const params = query({ businessId });
  return unwrap(await cachedGet(`/api/tax/calculations/${encodeURIComponent(runId)}/confidence?${params}`, { signal }));
}

export async function getTaxCalculationChanges({ businessId, runId, compareRunId, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(runId, "runId");
  const params = query({ businessId, otherRunId: compareRunId });
  return unwrap(await cachedGet(`/api/tax/calculations/${encodeURIComponent(runId)}/changes?${params}`, { signal }));
}

export async function getTaxCalculationWorkpaper({ businessId, year, runId, throughDate, section, signal } = {}) {
  requireBusinessId(businessId);
  const params = query({ businessId, year, tax_year: year, run_id: runId, through_date: throughDate, section });
  const path = runId
    ? `/api/tax/calculations/${encodeURIComponent(runId)}/workpaper?${query({ businessId, section })}`
    : `/api/tax/workpaper?${params}`;
  return unwrap(await cachedGet(path, { signal, cacheKey: key("workpaper", path) }));
}

export async function getTaxProfile({ businessId, year, signal } = {}) {
  requireBusinessId(businessId);
  return unwrap(await cachedGet(`/api/tax/profile?${query({ businessId, year })}`, { signal }));
}

export async function initializeTaxProfile({ businessId, year, source, signal } = {}) {
  requireBusinessId(businessId);
  const result = unwrap(await request(`/api/tax/profile/initialize?${query({ businessId, year })}`, {
    method: "POST",
    body: compact({ source }),
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function createTaxProfile({ businessId, year, profile = {}, signal } = {}) {
  requireBusinessId(businessId);
  const result = unwrap(await request(`/api/tax/profile?${query({ businessId, year })}`, {
    method: "POST",
    body: taxProfileMutableBody(profile),
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function updateTaxProfile({ businessId, year, patch = {}, signal } = {}) {
  requireBusinessId(businessId);
  const result = unwrap(await request(`/api/tax/profile?${query({ businessId, year })}`, {
    method: "PATCH",
    body: taxProfileMutableBody(patch),
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function getTaxProfileMemory({ businessId, memoryKey, asOfDate, includeHistory, signal } = {}) {
  requireBusinessId(businessId);
  return unwrap(await cachedGet(`/api/tax/profile-memory?${query({ businessId, memoryKey, asOfDate, includeHistory })}`, { signal }));
}

export async function setTaxProfileMemory({ businessId, memoryKey, value, source, confidenceScore, effectiveFrom, notes, metadata, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(memoryKey, "memoryKey");
  const result = unwrap(await request(`/api/tax/profile-memory?${query({ businessId })}`, {
    method: "POST",
    body: compact({ businessId, memoryKey, value, source, confidenceScore, effectiveFrom, notes, metadata }),
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function expireTaxProfileMemory({ businessId, memoryKey, effectiveTo, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(memoryKey, "memoryKey");
  const result = unwrap(await request(`/api/tax/profile-memory/${encodeURIComponent(memoryKey)}/expire?${query({ businessId })}`, {
    method: "POST",
    body: compact({ businessId, effectiveTo }),
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function getTaxDeductionsOverview({ businessId, year, asOfDate, refresh = false, signal } = {}) {
  requireBusinessId(businessId);
  const { path, cacheKey } = taxDeductionsOverviewPath({ businessId, year, asOfDate });
  return unwrap(await cachedGet(path, { signal, cacheKey, bypassCache: refresh }));
}

export function getCachedTaxDeductionsOverview({ businessId, year, asOfDate, allowStale = true } = {}) {
  if (!businessId) return null;
  const { cacheKey } = taxDeductionsOverviewPath({ businessId, year, asOfDate });
  return getCachedValue(cacheKey, { allowStale });
}

export async function prefetchTaxDeductionsOverviewBundle({ businessId, year, asOfDate } = {}) {
  requireBusinessId(businessId);
  const results = await Promise.allSettled([
    getTaxDeductionsOverview({ businessId, year, asOfDate }),
    prefetchTaxDeductionTransactionPages({ businessId, year, asOfDate }),
    getTaxClassificationCoverage({ businessId, year }),
    getTaxClassificationReviewSummary({ businessId, year }),
  ]);
  return {
    overview: valueOrNull(results[0]),
    transactionRows: valueOrNull(results[1]),
    classificationCoverage: valueOrNull(results[2]),
    classificationReviewSummary: valueOrNull(results[3]),
    errors: results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason),
  };
}

export async function prefetchTaxDeductionTransactionPages({ businessId, year, asOfDate, filters = {} } = {}) {
  requireBusinessId(businessId);
  const limit = TAX_DETAIL_PAGE_LIMIT;
  const rows = [];
  let latestPage = null;
  for (let offset = 0; ; offset += limit) {
    const page = await getTaxDeductionTransactions({ businessId, year, asOfDate, filters, limit, offset });
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

export async function getTaxDeductionTransactions({ businessId, year, asOfDate, filters = {}, limit, offset, refresh = false, signal } = {}) {
  requireBusinessId(businessId);
  const payload = await cachedGet(`/api/tax/deductions/transactions?${query({ businessId, year, asOfDate, limit: clampTaxDetailLimit(limit), offset, ...filters })}`, { signal, bypassCache: refresh });
  return normalizeTaxRowPage(unwrap(payload), {
    source: "deduction_transactions",
    requestId: taxRequestId(payload),
  });
}

export async function getTaxPostedTransactions({ businessId, year, dateFrom, dateTo, accountId, qboAccountId, direction, search, limit, offset, refresh = false, signal } = {}) {
  requireBusinessId(businessId);
  const payload = await cachedGet(`/api/tax/transactions/posted?${query({ businessId, year, dateFrom, dateTo, accountId, qboAccountId, direction, search, limit: clampTaxDetailLimit(limit), offset })}`, { signal, bypassCache: refresh });
  return normalizeTaxRowPage(unwrap(payload), {
    source: "posted_transactions",
    requestId: taxRequestId(payload),
  });
}

export async function getTaxDeductionTransactionDetail({ businessId, year, transactionId, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(transactionId, "transactionId");
  return unwrap(await cachedGet(`/api/tax/deductions/transactions/${encodeURIComponent(transactionId)}?${query({ businessId, year })}`, { signal }));
}

export async function getTaxDeductionCategoryDetail({ businessId, year, asOfDate, taxCategory, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(taxCategory, "taxCategory");
  return unwrap(await cachedGet(`/api/tax/deductions/categories/${encodeURIComponent(taxCategory)}?${query({ businessId, year, asOfDate })}`, { signal }));
}

export async function getTaxClassificationHistory({ businessId, year, transactionId, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(transactionId, "transactionId");
  return unwrap(await cachedGet(`/api/tax/classifications/${encodeURIComponent(transactionId)}/history?${query({ businessId, year })}`, { signal }));
}

export async function getTaxClassificationCoverage({ businessId, year, refresh = false, signal } = {}) {
  requireBusinessId(businessId);
  return unwrap(await cachedGet(`/api/tax/classifications/coverage?${query({ businessId, year })}`, { signal, bypassCache: refresh }));
}

export async function getTaxClassificationStatus({ businessId, year, signal } = {}) {
  requireBusinessId(businessId);
  return unwrap(await request(`/api/tax/classifications/status?${query({ businessId, year })}`, {
    method: "GET",
    signal,
  }));
}

export async function getTaxClassifications({
  businessId,
  year,
  status,
  deductibilityStatus,
  taxCategory,
  requiresReview,
  search,
  limit,
  offset,
  refresh = false,
  signal,
} = {}) {
  requireBusinessId(businessId);
  const payload = await cachedGet(`/api/tax/classifications?${query({
    businessId,
    year,
    status,
    deductibilityStatus,
    taxCategory,
    requiresReview,
    search,
    limit: clampTaxDetailLimit(limit),
    offset,
  })}`, { signal, bypassCache: refresh });
  return normalizeTaxRowPage(unwrap(payload), {
    source: "classifications",
    requestId: taxRequestId(payload),
  });
}

export async function getTaxClassificationReviewSummary({ businessId, year, refresh = false, signal } = {}) {
  requireBusinessId(businessId);
  return unwrap(await cachedGet(`/api/tax/classifications/review/summary?${query({ businessId, year })}`, { signal, bypassCache: refresh }));
}

export async function previewTaxClassificationBackfill({ businessId, year, limit, signal } = {}) {
  requireBusinessId(businessId);
  return unwrap(await request(`/api/tax/classifications/backfill/preview?${query({ businessId, year })}`, {
    method: "POST",
    body: compact({ limit }),
    signal,
  }));
}

export async function prepareTaxClassifications({ businessId, year, signal } = {}) {
  requireBusinessId(businessId);
  const result = unwrap(await request(`/api/tax/classifications/prepare?${query({ businessId, year })}`, {
    method: "POST",
    body: {},
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function runTaxClassification({ businessId, year, transactionIds = [], force = false, limit, cursor, signal } = {}) {
  requireBusinessId(businessId);
  const result = unwrap(await request(`/api/tax/classifications/run?${query({ businessId, year })}`, {
    method: "POST",
    body: compact({ businessId, year, transactionIds, force, limit, cursor }),
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function confirmTaxClassification({ businessId, year, transactionId, reason, expectedUpdatedAt, confirmationType = "user", signal } = {}) {
  requireBusinessId(businessId);
  requireValue(transactionId, "transactionId");
  const result = unwrap(await request(`/api/tax/classifications/${encodeURIComponent(transactionId)}/confirm?${query({ businessId, year })}`, {
    method: "POST",
    body: compact({ businessId, year, reason, expectedUpdatedAt, confirmationType }),
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function rejectTaxClassification({ businessId, year, transactionId, reason, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(transactionId, "transactionId");
  const result = unwrap(await request(`/api/tax/classifications/${encodeURIComponent(transactionId)}/reject?${query({ businessId, year })}`, {
    method: "POST",
    body: compact({ businessId, year, reason }),
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function overrideTaxClassification({ businessId, year, transactionId, changes = {}, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(transactionId, "transactionId");
  const result = unwrap(await request(`/api/tax/classifications/${encodeURIComponent(transactionId)}?${query({ businessId, year })}`, {
    method: "PATCH",
    body: { ...changes, businessId, year },
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function getTaxDeductionDecisionRules({ businessId, year, refresh = false, signal } = {}) {
  requireBusinessId(businessId);
  const params = query({ businessId, year });
  const response = await cachedGet(`/api/tax/deduction-decision-rules?${params}`, {
    signal,
    cacheKey: key("deduction-decision-rules", params),
    bypassCache: refresh,
  });
  const payload = unwrap(response);
  return normalizeTaxDecisionRules(payload?.rows, {
    requestId: taxRequestId(response) || taxRequestId(payload),
  });
}

export async function saveTaxDeductionDecisionRule({ businessId, year, transactionId, changes = {}, decisionType, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(transactionId, "transactionId");
  const result = unwrap(await request(`/api/tax/deduction-decision-rules?${query({ businessId, year })}`, {
    method: "POST",
    body: { businessId, year, transactionId, changes, decisionType },
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function applyGroupedTaxDeductionDecision({
  businessId,
  year,
  idempotencyKey,
  scope,
  scopeFingerprint,
  targetTransactionIds = [],
  expectedPopulationTransactionIds = [],
  changes = {},
  reason,
  signal,
} = {}) {
  requireBusinessId(businessId);
  requireValue(idempotencyKey, "idempotencyKey");
  if (!Array.isArray(targetTransactionIds) || !targetTransactionIds.length) throw new Error("targetTransactionIds are required");
  if (!Array.isArray(expectedPopulationTransactionIds) || !expectedPopulationTransactionIds.length) throw new Error("expectedPopulationTransactionIds are required");
  const path = `/api/tax/deduction-decisions/apply?${query({ businessId, year })}`;
  const requestOptions = {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: { businessId, year, idempotencyKey, scope, scopeFingerprint, targetTransactionIds, expectedPopulationTransactionIds, changes, reason },
    signal,
  };
  const commandRequest = withBoundedCommandSignal(signal, { timeoutMs: 20_000 });
  try {
    const result = unwrap(await request(path, { ...requestOptions, signal: commandRequest.signal }));
    clearBusinessCache(businessId);
    return result;
  } catch (caughtError) {
    const error = commandRequest.timedOut()
      ? Object.assign(new Error("The save is taking longer than expected."), {
        code: "command_timeout",
        status: null,
        requestId: caughtError?.requestId || null,
      })
      : caughtError;
    if (!isAmbiguousCommandFailure(error)) throw error;
    // Do not replay an unsafe mutation after a timeout/5xx. Its idempotency
    // record is the only authority for whether the prior request committed.
    const statusRequest = withBoundedCommandSignal(signal, { timeoutMs: 8_000 });
    try {
      const operation = await getGroupedTaxDeductionDecisionOperation({ businessId, year, idempotencyKey, signal: statusRequest.signal });
      if (operation?.status === "completed" && operation?.result) {
        clearBusinessCache(businessId);
        return operation.result;
      }
    } catch {
      // The dialog will present the bounded unknown-outcome state below.
    } finally {
      statusRequest.cleanup();
    }
    const unknown = new Error("We’re checking whether your decision was saved. Don’t submit it again yet.");
    unknown.code = "grouped_decision_outcome_unknown";
    unknown.status = error?.status || null;
    unknown.requestId = error?.requestId || null;
    unknown.idempotencyKey = idempotencyKey;
    unknown.outcomeUnknown = true;
    throw unknown;
  } finally {
    commandRequest.cleanup();
  }
}

export async function getGroupedTaxDeductionDecisionOperation({ businessId, year, idempotencyKey, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(idempotencyKey, "idempotencyKey");
  return unwrap(await request(`/api/tax/deduction-decisions/operations/${encodeURIComponent(idempotencyKey)}?${query({ businessId, year })}`, {
    method: "GET",
    signal,
  }));
}

export async function updateTaxDeductionDecisionRule({ businessId, year, ruleId, changes = {}, decisionType, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(ruleId, "ruleId");
  const result = unwrap(await request(`/api/tax/deduction-decision-rules/${encodeURIComponent(ruleId)}?${query({ businessId, year })}`, {
    method: "PATCH",
    body: { businessId, year, changes, decisionType },
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function excludeTaxClassification({ businessId, year, transactionId, reason, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(transactionId, "transactionId");
  requireValue(reason, "reason");
  const result = unwrap(await request(`/api/tax/classifications/${encodeURIComponent(transactionId)}/exclude?${query({ businessId, year })}`, {
    method: "POST",
    body: { businessId, year, reason },
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function restoreTaxClassification({ businessId, year, transactionId, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(transactionId, "transactionId");
  const result = unwrap(await request(`/api/tax/classifications/${encodeURIComponent(transactionId)}/restore?${query({ businessId, year })}`, {
    method: "POST",
    body: { businessId, year },
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function bulkUpdateTaxClassifications({ businessId, year, transactionIds = [], changes = {}, reason, allowUserConfirmedEdit = false, signal } = {}) {
  requireBusinessId(businessId);
  if (!Array.isArray(transactionIds) || !transactionIds.length) throw new Error("transactionIds are required");
  const result = unwrap(await request(`/api/tax/classifications/bulk-update?${query({ businessId, year })}`, {
    method: "POST",
    body: { businessId, year, transactionIds, changes, reason, allowUserConfirmedEdit },
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function sendTaxClassificationsToReview({ businessId, year, transactionIds = [], reasonCode, reasonNote, expectedUpdatedAtByTransactionId = {}, bookkeepingIssue = false, signal } = {}) {
  requireBusinessId(businessId);
  if (!Array.isArray(transactionIds) || !transactionIds.length) throw new Error("transactionIds are required");
  const result = unwrap(await request(`/api/tax/classifications/tax-review-hold?${query({ businessId, year })}`, {
    method: "POST",
    body: compact({ businessId, year, transactionIds, reasonCode, reasonNote, expectedUpdatedAtByTransactionId, bookkeepingIssue }),
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function exportTaxDeductions({ businessId, year, asOfDate, format = "summary_csv", filters = {}, signal } = {}) {
  requireBusinessId(businessId);
  return authenticatedFetch(`/api/tax/deductions/export?${query({ businessId, year, asOfDate, format, ...filters })}`, {
    method: "GET",
    responseType: "blob",
    signal,
  });
}

export async function getTaxReserve({ businessId, year, asOfDate, signal } = {}) {
  requireBusinessId(businessId);
  return unwrap(await cachedGet(`/api/tax/reserve?${query({ businessId, year, asOfDate })}`, { signal }));
}

export async function getTaxReserveAccounts({ businessId, includeInactive, signal } = {}) {
  requireBusinessId(businessId);
  return unwrap(await cachedGet(`/api/tax/reserve/accounts?${query({ businessId, includeInactive })}`, { signal }));
}

export async function createTaxReserveAccount({ businessId, account = {}, signal } = {}) {
  requireBusinessId(businessId);
  const result = unwrap(await request(`/api/tax/reserve/accounts?${query({ businessId })}`, {
    method: "POST",
    body: { ...account, businessId },
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function updateTaxReserveAccount({ businessId, accountId, patch = {}, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(accountId, "accountId");
  const result = unwrap(await request(`/api/tax/reserve/accounts/${encodeURIComponent(accountId)}?${query({ businessId })}`, {
    method: "PATCH",
    body: { ...patch, businessId },
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function setPrimaryTaxReserveAccount({ businessId, accountId, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(accountId, "accountId");
  const result = unwrap(await request(`/api/tax/reserve/accounts/${encodeURIComponent(accountId)}/set-primary?${query({ businessId })}`, {
    method: "POST",
    body: { businessId },
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function refreshTaxReserveAccount({ businessId, accountId, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(accountId, "accountId");
  const result = unwrap(await request(`/api/tax/reserve/accounts/${encodeURIComponent(accountId)}/refresh?${query({ businessId })}`, {
    method: "POST",
    body: { businessId },
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function deactivateTaxReserveAccount({ businessId, accountId, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(accountId, "accountId");
  const result = unwrap(await request(`/api/tax/reserve/accounts/${encodeURIComponent(accountId)}/deactivate?${query({ businessId })}`, {
    method: "POST",
    body: { businessId },
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function getTaxPayments({ businessId, year, jurisdiction, stateCode, paymentType, signal } = {}) {
  requireBusinessId(businessId);
  return unwrap(await cachedGet(`/api/tax/payments?${query({ businessId, year, jurisdiction, stateCode, paymentType })}`, { signal }));
}

export async function createTaxPayment({ businessId, year, payment = {}, idempotencyKey, signal } = {}) {
  requireBusinessId(businessId);
  const key = idempotencyKey || payment.idempotencyKey || payment.idempotency_key || null;
  const result = unwrap(await request(`/api/tax/payments?${query({ businessId, year })}`, {
    method: "POST",
    body: { ...payment, businessId, year, idempotencyKey: key },
    headers: key ? { "Idempotency-Key": key } : undefined,
    signal,
  }));
  clearBusinessCache(businessId);
  return result?.payment ? { ...result.payment, mutation: { created: result.created, reused: result.reused, duplicateCandidate: result.duplicateCandidate } } : result;
}

export async function updateTaxPayment({ businessId, year, paymentId, patch = {}, idempotencyKey, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(paymentId, "paymentId");
  const key = idempotencyKey || patch.idempotencyKey || patch.idempotency_key || null;
  const result = unwrap(await request(`/api/tax/payments/${encodeURIComponent(paymentId)}?${query({ businessId, year })}`, {
    method: "PATCH",
    body: { ...patch, businessId, year, idempotencyKey: key },
    headers: key ? { "Idempotency-Key": key } : undefined,
    signal,
  }));
  clearBusinessCache(businessId);
  return result?.payment ? { ...result.payment, mutation: { updated: result.updated, changed: result.changed } } : result;
}

export async function voidTaxPayment({ businessId, year, paymentId, reason, idempotencyKey, signal } = {}) {
  requireBusinessId(businessId);
  requireValue(paymentId, "paymentId");
  const result = unwrap(await request(`/api/tax/payments/${encodeURIComponent(paymentId)}/void?${query({ businessId, year })}`, {
    method: "POST",
    body: compact({ businessId, year, reason, hardDelete: false, idempotencyKey }),
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
    signal,
  }));
  clearBusinessCache(businessId);
  return result?.payment ? { ...result.payment, mutation: { voided: result.voided, reused: result.reused } } : result;
}

export async function getLegacyTaxLiability({ businessId, year, projectionOverride, signal } = {}) {
  requireBusinessId(businessId);
  return unwrap(await request("/api/tax/calculate-tax-liability", {
    method: "POST",
    body: compact({ businessId, year, projectionOverride }),
    signal,
  }));
}

export function adaptTaxOverviewForLegacyDashboard(dto) {
  if (!dto) return null;
  const trend = buildTrend(dto);
  const quarterly = buildQuarterlySchedule(dto);
  return {
    ...dto,
    meta: {
      ...(dto.meta || {}),
      source: dto.meta?.source || "canonical",
      year: dto.meta?.taxYear ?? dto.meta?.year ?? null,
      canonicalEndpoint: "/api/tax/overview",
    },
    summary: {
      ...(dto.summary || {}),
      annualEstimate: dto.summary?.projectedTotalTax ?? null,
      ytdEstimated: dto.liability?.ytdTaxGeneratedEstimate ?? null,
      ytdPaid: dto.summary?.taxPaidAndWithheldYtd ?? dto.payments?.totals?.totalPaidAndWithheld ?? dto.payments?.totalApplied ?? null,
      balanceDue: dto.summary?.remainingProjectedLiability ?? null,
      profitYTD: dto.summary?.taxableIncomeYtd ?? null,
      recommendedReserve: dto.summary?.recommendedReserve ?? null,
      reserveGap: dto.summary?.reserveGap ?? null,
    },
    safeHarbor: {
      ...(dto.safeHarbor || {}),
      method: dto.safeHarbor?.federal?.method ?? dto.safeHarbor?.combined?.method ?? null,
      requiredAnnual: dto.safeHarbor?.combined?.requiredAnnual ?? dto.safeHarbor?.federal?.requiredAnnual ?? null,
      coveredAmount: dto.safeHarbor?.combined?.coveredAmount ?? dto.safeHarbor?.federal?.coveredAmount ?? null,
      remainingAmount: dto.safeHarbor?.combined?.remainingAmount ?? dto.safeHarbor?.federal?.remainingAmount ?? null,
    },
    quarterly,
    trend,
    cashFlowOverlay: [],
    monthlySnapshot: {
      metrics: {
        profitYTD: dto.summary?.taxableIncomeYtd ?? null,
        taxableIncomeYTD: dto.summary?.taxableIncomeYtd ?? null,
        projectedTaxableIncome: dto.summary?.projectedTaxableIncome ?? null,
      },
    },
    canonical: dto,
    confidence: dto.confidence ?? null,
    warnings: dto.warnings || [],
    setupState: dto.readiness?.setupState || null,
  };
}

function buildQuarterlySchedule(dto) {
  const status = dto.safeHarbor?.status || dto.safeHarbor?.combined?.status || "unavailable";
  if (status === "unavailable") return [];
  const schedule = dto.safeHarbor?.federal?.quarterSchedule || dto.safeHarbor?.combined?.quarterSchedule || [];
  return (schedule || []).map((row) => ({
    quarter: row.quarter,
    due: row.due || row.dueDate || row.date || null,
    amount: nullableMoney(row.amount),
    paid: nullableMoney(row.paid),
    remaining: nullableMoney(row.remaining),
  }));
}

function buildTrend(dto) {
  const taxYear = dto.meta?.taxYear ?? dto.meta?.year;
  if (!taxYear) return [];
  const currentMonth = String(dto.meta?.asOfDate || "").slice(0, 7);
  const monthly = dto.projection?.projectedAnnual?.monthly || dto.projection?.actual?.monthly || dto.actuals?.monthly || {};
  const annualTotal = dto.summary?.projectedTotalTax;
  const perMonth = annualTotal == null ? null : nullableMoney(Number(annualTotal) / 12);

  return Array.from({ length: 12 }, (_, index) => {
    const month = `${taxYear}-${String(index + 1).padStart(2, "0")}`;
    const monthTaxableIncome = monthly?.[month]?.taxableBusinessIncome;
    const periodType = currentMonth
      ? month === currentMonth
        ? "current_partial"
        : month < currentMonth
          ? "actual"
          : "projected"
      : "projected";
    return {
      month,
      estTax: perMonth,
      actualTax: periodType !== "projected" && monthTaxableIncome != null ? perMonth : null,
      projectedTax: periodType === "projected" ? perMonth : null,
      periodType,
      isCurrent: month === currentMonth,
    };
  });
}

async function cachedGet(path, { signal, cacheKey = path, bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache) {
    const hit = cache.get(cacheKey);
    if (hit && now - hit.ts < CACHE_TTL_MS) return hit.value;
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);
  }
  const promise = request(path, { method: "GET", signal }).then((value) => {
    cache.set(cacheKey, { ts: Date.now(), value });
    trimCache();
    return value;
  }).finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, promise);
  return promise;
}

function getCachedValue(cacheKey, { allowStale = false } = {}) {
  const hit = cache.get(cacheKey);
  if (!hit) return null;
  const ageMs = Date.now() - hit.ts;
  if (!allowStale && ageMs >= CACHE_TTL_MS) return null;
  return {
    value: unwrap(hit.value),
    ageMs,
    stale: ageMs >= CACHE_TTL_MS,
    cacheKey,
  };
}

function taxDeductionsOverviewPath({ businessId, year, asOfDate } = {}) {
  const params = query({ businessId, year, asOfDate });
  return {
    path: `/api/tax/deductions/overview?${params}`,
    cacheKey: key("deductionsOverview", params),
  };
}

function request(path, options) {
  return authenticatedFetch(path, {
    ...options,
    headers: {
      "x-bizzi-tax-version": TAX_API_VERSION,
      ...(options?.headers || {}),
    },
  });
}

function isAmbiguousCommandFailure(error) {
  const status = Number(error?.status || 0);
  return error?.code === "network_error" || error?.code === "command_timeout" || status >= 500 || status === 408 || status === 429;
}

// A timeout is only a cue to reconcile the idempotency record. It never means
// the write failed and this client must never replay the command automatically.
function withBoundedCommandSignal(parentSignal, { timeoutMs = 20_000 } = {}) {
  if (typeof AbortController === "undefined") {
    return { signal: parentSignal, timedOut: () => false, cleanup: () => {} };
  }
  const controller = new AbortController();
  let didTimeOut = false;
  const abortForParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortForParent();
  else parentSignal?.addEventListener?.("abort", abortForParent, { once: true });
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.("abort", abortForParent);
    },
  };
}

function taxQuery(values) {
  const next = { ...values };
  next.include = normalizeInclude(values.include);
  if (!next.apiVersion) delete next.apiVersion;
  return query(next);
}

function normalizeInclude(include = []) {
  const list = Array.isArray(include)
    ? include
    : String(include || "").split(",");
  return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))]
    .filter((item) => {
      if (!ALLOWED_INCLUDES.has(item)) throw new Error(`Unsupported tax include: ${item}`);
      return true;
    })
    .sort();
}

function query(values = {}) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([keyName, value]) => {
    if (value == null || value === "" || value === false) return;
    if (Array.isArray(value)) {
      if (value.length) params.set(keyName, value.join(","));
    } else {
      params.set(keyName, String(value));
    }
  });
  return params.toString();
}

function taxProfileMutableBody(input = {}) {
  const allowed = new Set([
    "entity_type", "entityType", "tax_election", "taxElection", "filing_status", "filingStatus",
    "primary_tax_state", "primaryTaxState", "accounting_method", "accountingMethod",
    "safe_harbor_method", "safeHarborMethod", "source", "qbi_eligible",
    "self_employment_tax_applies", "prior_year_total_tax", "prior_year_agi",
    "owner_reasonable_salary", "owner_w2_wages_ytd", "federal_withholding_ytd",
    "state_withholding_ytd", "health_insurance_deduction_ytd", "retirement_contributions_ytd",
    "hsa_contributions_ytd", "reserve_buffer_percent", "confidence_score",
  ]);
  return Object.fromEntries(
    Object.entries(input || {}).filter(([field, value]) => allowed.has(field) && value !== undefined)
  );
}

function clampTaxDetailLimit(limit) {
  if (limit == null || limit === "") return limit;
  const n = Number(limit);
  if (!Number.isFinite(n)) return limit;
  return Math.min(Math.max(Math.trunc(n), 1), TAX_DETAIL_PAGE_LIMIT);
}

function key(prefix, serializedParams) {
  return `${prefix}:${serializedParams}`;
}

function unwrap(payload) {
  return payload?.ok === true && "data" in payload ? payload.data : payload;
}

// These Tax endpoints deliberately return incomplete bookkeeping evidence while
// a posted source row is waiting for classification. Keep that state visible to
// the UI instead of treating it as a valid tax treatment or dropping the row.
// This is also the single frontend boundary for malformed nullable list members.
const reportedTaxContractFallbacks = new Set();

export function normalizeTaxRowPage(payload, { source = "tax_rows", requestId = null } = {}) {
  const page = isTaxRecord(payload) ? payload : {};
  const rows = Array.isArray(page.rows) ? page.rows : [];
  const normalizedRows = rows.map((row, index) => normalizeTaxRecord(row, {
    source,
    requestId: requestId || taxRequestId(page),
    index,
  }));
  const unavailableRowCount = normalizedRows.filter((row) => row.taxDataUnavailable === true).length;
  return {
    ...page,
    rows: normalizedRows,
    pagination: isTaxRecord(page.pagination) ? { ...page.pagination } : page.pagination || null,
    taxDataQuality: unavailableRowCount > 0
      ? {
        ...(isTaxRecord(page.taxDataQuality) ? page.taxDataQuality : {}),
        unavailableRowCount,
      }
      : page.taxDataQuality,
  };
}

export function normalizeTaxDecisionRules(rows, { requestId = null } = {}) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    if (isTaxRecord(row)) return row;
    const reasonCode = "null_grouped_decision";
    logTaxContractFallback(reasonCode, { requestId, source: "deduction_decision_rules" });
    return {
      id: null,
      accountKey: `tax-rule-unavailable-${index}`,
      accountName: "Tax treatment unavailable",
      taxCategory: null,
      deductibilityStatus: null,
      deductiblePercent: null,
      taxTreatment: null,
      taxDataUnavailable: true,
      taxDataReasonCode: reasonCode,
      autoApplies: false,
    };
  });
}

export function normalizeTaxRecord(row, { source = "tax_rows", requestId = null, index = 0 } = {}) {
  if (!isTaxRecord(row)) {
    const reasonCode = "null_tax_record";
    logTaxContractFallback(reasonCode, { requestId, source });
    return unavailableTaxRecord({ reasonCode, source, index });
  }

  const classification = row.classification;
  if (classification === null) {
    const reasonCode = "null_transaction_tax_classification";
    logTaxContractFallback(reasonCode, { requestId, source });
    return unavailableTaxRecord({ row, reasonCode, source, index });
  }

  if (row.taxDataUnavailable === true) {
    logTaxContractFallback(row.taxDataReasonCode || "tax_treatment_unavailable", { requestId, source });
    return row;
  }

  if (isTaxRecord(classification)) {
    const hasCategory = firstDefined(row.taxCategory, row.tax_category, classification.taxCategory, classification.tax_category) != null;
    const hasTreatment = firstDefined(row.taxTreatment, row.tax_treatment, classification.taxTreatment, classification.tax_treatment) != null;
    if (!hasCategory || !hasTreatment) {
      const reasonCode = !hasCategory ? "missing_tax_category" : "missing_tax_treatment";
      logTaxContractFallback(reasonCode, { requestId, source });
      return unavailableTaxRecord({ row, reasonCode, source, index });
    }
  }

  return row;
}

function unavailableTaxRecord({ row = null, reasonCode, source, index }) {
  const sourceRow = isTaxRecord(row) ? row : {};
  return {
    ...sourceRow,
    // Keep nullable treatment fields null: a UI fallback must never invent a
    // tax category, percentage, or deduction amount.
    taxCategory: sourceRow.taxCategory ?? sourceRow.tax_category ?? null,
    taxTreatment: sourceRow.taxTreatment ?? sourceRow.tax_treatment ?? null,
    deductibilityStatus: sourceRow.deductibilityStatus ?? sourceRow.deductibility_status ?? null,
    classificationStatus: sourceRow.classificationStatus ?? sourceRow.classification_status ?? "unclassified",
    status: sourceRow.status ?? "unclassified",
    taxScopeDisposition: sourceRow.taxScopeDisposition ?? sourceRow.tax_scope_disposition ?? "incomplete_or_unresolved",
    taxDataUnavailable: true,
    taxDataReasonCode: reasonCode,
    taxDataSource: source,
    taxDataIndex: index,
  };
}

function taxRequestId(payload) {
  return sanitizeTaxRequestId(
    payload?.requestId
      ?? payload?.request_id
      ?? payload?.meta?.requestId
      ?? payload?.meta?.request_id
      ?? payload?.data?.requestId
      ?? payload?.data?.request_id
      ?? null
  );
}

function sanitizeTaxRequestId(value) {
  const text = String(value || "").trim();
  return text && /^[A-Za-z0-9._:-]{1,128}$/.test(text) ? text : null;
}

function logTaxContractFallback(reasonCode, { requestId = null, source = "tax_rows" } = {}) {
  const safeRequestId = sanitizeTaxRequestId(requestId);
  const key = `${reasonCode}:${source}:${safeRequestId || "none"}`;
  if (reportedTaxContractFallbacks.has(key)) return;
  reportedTaxContractFallbacks.add(key);
  // Do not include a transaction, amount, business, or provider payload here.
  console.warn("[TaxDataFallback]", { reasonCode, requestId: safeRequestId, source });
}

function firstDefined(...values) {
  return values.find((value) => value != null);
}

function isTaxRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function valueOrNull(result) {
  return result?.status === "fulfilled" ? result.value : null;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object || {}).filter(([, value]) => value !== undefined));
}

function requireBusinessId(businessId) {
  requireValue(businessId, "businessId");
}

function requireValue(value, field) {
  if (value == null || value === "") throw new Error(`${field} is required`);
}

function nullableMoney(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return null;
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function clearBusinessCache(businessId) {
  clearTaxApiCache((cacheKey) => cacheKey.includes(`businessId=${encodeURIComponent(businessId)}`));
}

function trimCache() {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const keys = [...cache.keys()].slice(0, cache.size - MAX_CACHE_ENTRIES);
  keys.forEach((cacheKey) => cache.delete(cacheKey));
}

export default {
  getTaxOverview,
  runTaxCalculation,
  getTaxCalculation,
  getLatestTaxCalculation,
  getTaxCalculationComponents,
  getTaxCalculationExplanation,
  getTaxCalculationConfidence,
  getTaxCalculationChanges,
  getTaxProfile,
  initializeTaxProfile,
  createTaxProfile,
  updateTaxProfile,
  getTaxProfileMemory,
  setTaxProfileMemory,
  expireTaxProfileMemory,
  getTaxDeductionsOverview,
  getCachedTaxDeductionsOverview,
  prefetchTaxDeductionsOverviewBundle,
  prefetchTaxDeductionTransactionPages,
  getTaxDeductionTransactions,
  getTaxPostedTransactions,
  getTaxDeductionTransactionDetail,
  getTaxDeductionCategoryDetail,
  getTaxClassificationHistory,
  getTaxClassificationCoverage,
  getTaxClassificationStatus,
  getTaxClassifications,
  getTaxClassificationReviewSummary,
  previewTaxClassificationBackfill,
  prepareTaxClassifications,
  runTaxClassification,
  confirmTaxClassification,
  rejectTaxClassification,
  overrideTaxClassification,
  getTaxDeductionDecisionRules,
  saveTaxDeductionDecisionRule,
  applyGroupedTaxDeductionDecision,
  getGroupedTaxDeductionDecisionOperation,
  updateTaxDeductionDecisionRule,
  sendTaxClassificationsToReview,
  excludeTaxClassification,
  restoreTaxClassification,
  bulkUpdateTaxClassifications,
  exportTaxDeductions,
  getTaxReserve,
  getTaxReserveAccounts,
  createTaxReserveAccount,
  updateTaxReserveAccount,
  setPrimaryTaxReserveAccount,
  refreshTaxReserveAccount,
  deactivateTaxReserveAccount,
  getTaxPayments,
  createTaxPayment,
  updateTaxPayment,
  voidTaxPayment,
  getLegacyTaxLiability,
  clearTaxApiCache,
};
