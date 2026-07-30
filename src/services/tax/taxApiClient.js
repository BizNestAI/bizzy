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

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 50;
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
    body: compact({ businessId, year, source }),
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function createTaxProfile({ businessId, year, profile = {}, signal } = {}) {
  requireBusinessId(businessId);
  const result = unwrap(await request(`/api/tax/profile?${query({ businessId, year })}`, {
    method: "POST",
    body: { ...profile, businessId, year },
    signal,
  }));
  clearBusinessCache(businessId);
  return result;
}

export async function updateTaxProfile({ businessId, year, patch = {}, signal } = {}) {
  requireBusinessId(businessId);
  const result = unwrap(await request(`/api/tax/profile?${query({ businessId, year })}`, {
    method: "PATCH",
    body: { ...patch, businessId, year },
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

export async function getTaxDeductionsOverview({ businessId, year, asOfDate, signal } = {}) {
  requireBusinessId(businessId);
  return unwrap(await cachedGet(`/api/tax/deductions/overview?${query({ businessId, year, asOfDate })}`, { signal }));
}

export async function getTaxDeductionTransactions({ businessId, year, asOfDate, filters = {}, limit, offset, signal } = {}) {
  requireBusinessId(businessId);
  return unwrap(await cachedGet(`/api/tax/deductions/transactions?${query({ businessId, year, asOfDate, limit, offset, ...filters })}`, { signal }));
}

export async function getTaxPostedTransactions({ businessId, year, dateFrom, dateTo, accountId, qboAccountId, direction, search, limit, offset, signal } = {}) {
  requireBusinessId(businessId);
  return unwrap(await cachedGet(`/api/tax/transactions/posted?${query({ businessId, year, dateFrom, dateTo, accountId, qboAccountId, direction, search, limit, offset })}`, { signal }));
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

export async function bulkUpdateTaxClassifications({ businessId, year, transactionIds = [], changes = {}, reason, signal } = {}) {
  requireBusinessId(businessId);
  if (!Array.isArray(transactionIds) || !transactionIds.length) throw new Error("transactionIds are required");
  const result = unwrap(await request(`/api/tax/classifications/bulk-update?${query({ businessId, year })}`, {
    method: "POST",
    body: { businessId, year, transactionIds, changes, reason },
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
    if (!signal && inflight.has(cacheKey)) return inflight.get(cacheKey);
  }
  const promise = request(path, { method: "GET", signal }).then((value) => {
    cache.set(cacheKey, { ts: Date.now(), value });
    trimCache();
    return value;
  }).finally(() => inflight.delete(cacheKey));
  if (!signal) inflight.set(cacheKey, promise);
  return promise;
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

function key(prefix, serializedParams) {
  return `${prefix}:${serializedParams}`;
}

function unwrap(payload) {
  return payload?.ok === true && "data" in payload ? payload.data : payload;
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
  getTaxDeductionTransactions,
  getTaxPostedTransactions,
  getTaxDeductionTransactionDetail,
  getTaxDeductionCategoryDetail,
  getTaxClassificationHistory,
  runTaxClassification,
  confirmTaxClassification,
  rejectTaxClassification,
  overrideTaxClassification,
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
