// /src/services/tax/confidence/taxSourceFreshness.js

const DEFAULT_THRESHOLDS_DAYS = Object.freeze({
  bankSync: 7,
  qboPosting: 7,
  classificationRun: 14,
  taxProfileReview: 180,
  forecast: 30,
  payments: 30,
  reserveBalance: 7,
});

export function evaluateTaxSourceFreshness({
  sourceFreshness = {},
  canonicalResult = null,
  asOfDate = null,
  thresholdsDays = DEFAULT_THRESHOLDS_DAYS,
} = {}) {
  const cutoff = Date.parse(`${asOfDate || canonicalResult?.meta?.asOfDate || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const sources = [
    source("bank_sync", sourceFreshness.lastBankSyncAt || sourceFreshness.bankSyncAt, thresholdsDays.bankSync, cutoff, true),
    source("qbo_posting", sourceFreshness.lastQboPostedAt || sourceFreshness.qboPostingAt, thresholdsDays.qboPosting, cutoff, true),
    source("classification_run", sourceFreshness.lastClassificationRunAt || sourceFreshness.classificationRunAt, thresholdsDays.classificationRun, cutoff, true),
    source("tax_profile_review", sourceFreshness.lastTaxProfileReviewAt || canonicalResult?.profile?.profile?.last_reviewed_at, thresholdsDays.taxProfileReview, cutoff, false),
    source("forecast", sourceFreshness.lastForecastAt || sourceFreshness.forecastUpdatedAt, thresholdsDays.forecast, cutoff, false),
    source("payments", sourceFreshness.lastPaymentUpdateAt || sourceFreshness.paymentsUpdatedAt, thresholdsDays.payments, cutoff, false),
    source("reserve_balance", sourceFreshness.lastReserveBalanceAt || sourceFreshness.reserveBalanceAt, thresholdsDays.reserveBalance, cutoff, false),
  ].filter(Boolean);
  const staleSources = sources.filter((row) => row.status === "stale" || row.status === "missing_critical");
  const critical = sources.filter((row) => row.critical);
  const freshnessScore = computeFreshnessScore(sources);
  return {
    sources,
    staleSources,
    oldestCriticalSource: oldest(critical),
    freshnessScore,
    warnings: staleSources.map((row) => ({
      code: row.status === "missing_critical" ? `${row.code}_missing` : `${row.code}_stale`,
      severity: row.critical ? "high" : "medium",
      message: `${row.label} is ${row.status === "missing_critical" ? "missing" : "stale"}.`,
      action: row.fixAction,
    })),
  };
}

function source(code, timestamp, thresholdDays, cutoffMs, critical) {
  const label = labelFor(code);
  if (!timestamp) {
    return {
      code,
      label,
      timestamp: null,
      ageDays: null,
      thresholdDays,
      critical,
      status: critical ? "missing_critical" : "unknown",
      fixAction: fixFor(code),
    };
  }
  const ms = Date.parse(timestamp);
  const ageDays = Number.isFinite(ms) ? Math.max(0, Math.floor((cutoffMs - ms) / 86400000)) : null;
  return {
    code,
    label,
    timestamp,
    ageDays,
    thresholdDays,
    critical,
    status: ageDays == null ? "unknown" : ageDays > thresholdDays ? "stale" : "fresh",
    fixAction: fixFor(code),
  };
}

function computeFreshnessScore(sources) {
  if (!sources.length) return 100;
  let total = 0;
  let weight = 0;
  for (const item of sources) {
    const w = item.critical ? 2 : 1;
    weight += w;
    if (item.status === "fresh") total += 100 * w;
    else if (item.status === "unknown") total += 70 * w;
    else if (item.status === "stale") total += 45 * w;
    else total += 20 * w;
  }
  return Math.round(total / Math.max(1, weight));
}

function oldest(sources) {
  return [...sources].filter((row) => row.ageDays != null).sort((a, b) => b.ageDays - a.ageDays)[0] || null;
}

function fixFor(code) {
  return ({
    bank_sync: "refresh_books",
    qbo_posting: "refresh_books",
    classification_run: "run_classification",
    tax_profile_review: "complete_tax_profile",
    forecast: "refresh_forecast",
    payments: "enter_tax_payments",
    reserve_balance: "connect_reserve_account",
  })[code] || "review_tax_inputs";
}

function labelFor(code) {
  return String(code).replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
