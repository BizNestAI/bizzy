import { TAX_TRIGGER_SOURCES } from "../taxDomain.js";
import {
  TAX_RECALCULATION_EVENT_TYPES as EVENTS,
  TAX_RECALCULATION_OUTCOMES,
  TAX_RECALCULATION_PRIORITIES,
  isNonRecalculationEvent,
  isSupportedTaxRecalculationEvent,
} from "./taxRecalculationEventDomain.js";

const IMMEDIATE = new Set([
  EVENTS.TAX_PROFILE_CREATED,
  EVENTS.TAX_ENTITY_CHANGED,
  EVENTS.TAX_ELECTION_CHANGED,
  EVENTS.TAX_FILING_STATUS_CHANGED,
  EVENTS.TAX_STATE_CHANGED,
  EVENTS.TAX_ACCOUNTING_METHOD_CHANGED,
  EVENTS.TAX_PAYMENT_CREATED,
  EVENTS.TAX_PAYMENT_VOIDED,
  EVENTS.FEDERAL_TAX_RULE_PUBLISHED,
  EVENTS.FEDERAL_TAX_RULE_UPDATED,
  EVENTS.STATE_TAX_RULE_PUBLISHED,
  EVENTS.STATE_TAX_RULE_UPDATED,
  EVENTS.TAX_DEDUCTION_RULE_PUBLISHED,
  EVENTS.TAX_DEDUCTION_RULE_UPDATED,
  EVENTS.MANUAL_TAX_RECALCULATION_REQUESTED,
  EVENTS.TAX_YEAR_ROLLOVER,
  EVENTS.TAX_ENGINE_VERSION_CHANGED,
]);

const SHORT_DEBOUNCE = new Set([
  EVENTS.QBO_TRANSACTION_POSTED,
  EVENTS.QBO_TRANSACTION_VOIDED,
  EVENTS.QBO_TRANSACTION_FAILED_THEN_RESOLVED,
  EVENTS.POSTED_TRANSACTION_ARCHIVED,
  EVENTS.POSTED_TRANSACTION_RESTORED,
  EVENTS.TRANSACTION_CLASSIFIED,
  EVENTS.TRANSACTION_CLASSIFICATION_CONFIRMED,
  EVENTS.TRANSACTION_CLASSIFICATION_OVERRIDDEN,
  EVENTS.TRANSACTION_CLASSIFICATION_EXCLUDED,
  EVENTS.TRANSACTION_CLASSIFICATION_RESTORED,
  EVENTS.BULK_TAX_CLASSIFICATION_CHANGED,
  EVENTS.TAX_PROFILE_UPDATED,
  EVENTS.TAX_MEMORY_CREATED,
  EVENTS.TAX_MEMORY_UPDATED,
  EVENTS.TAX_MEMORY_EXPIRED,
  EVENTS.TAX_PAYMENT_UPDATED,
  EVENTS.TAX_RESERVE_ACCOUNT_CREATED,
  EVENTS.TAX_RESERVE_ACCOUNT_UPDATED,
  EVENTS.TAX_RESERVE_ACCOUNT_PRIMARY_CHANGED,
]);

const LONG_DEBOUNCE = new Set([
  EVENTS.CASHFLOW_FORECAST_UPDATED,
  EVENTS.FINANCIAL_SOURCE_SYNC_COMPLETED,
  EVENTS.QBO_SYNC_COMPLETED,
  EVENTS.PLAID_SYNC_COMPLETED,
  EVENTS.SOURCE_DATA_RECONCILIATION_CHANGED,
]);

const RESERVE_ONLY_OR_LOW = new Set([
  EVENTS.TAX_RESERVE_BALANCE_REFRESHED,
]);

const COSMETIC_FIELDS = new Set(["notes", "memo", "description", "display_name", "metadata", "updated_at", "last_viewed_at"]);
const PROFILE_MATERIAL_FIELDS = new Set(["entity_type", "tax_election", "filing_status", "primary_tax_state", "accounting_method", "safe_harbor_method", "prior_year_total_tax", "prior_year_agi", "owner_w2_wages_ytd", "federal_withholding_ytd", "state_withholding_ytd"]);

export function evaluateTaxRecalculationPolicy(event, { force = false, now = new Date() } = {}) {
  if (!event?.eventType || isNonRecalculationEvent(event.eventType)) {
    return skip(TAX_RECALCULATION_OUTCOMES.SKIP_UNSUPPORTED, "Event does not trigger recalculation.");
  }
  if (!isSupportedTaxRecalculationEvent(event.eventType)) {
    return skip(TAX_RECALCULATION_OUTCOMES.SKIP_UNSUPPORTED, "Unsupported event type.");
  }
  if (force || event.eventType === EVENTS.MANUAL_TAX_RECALCULATION_REQUESTED) {
    return decision(TAX_RECALCULATION_OUTCOMES.RECALCULATE_NOW, 0, TAX_RECALCULATION_PRIORITIES.CRITICAL, TAX_TRIGGER_SOURCES.MANUAL);
  }
  if (hasIdenticalBeforeAfter(event)) {
    return skip(TAX_RECALCULATION_OUTCOMES.SKIP_IMMATERIAL, "Before and after values are identical.");
  }
  if (isCosmeticOnly(event)) {
    return skip(TAX_RECALCULATION_OUTCOMES.SKIP_IMMATERIAL, "Only cosmetic fields changed.");
  }
  if (IMMEDIATE.has(event.eventType)) {
    return decision(TAX_RECALCULATION_OUTCOMES.RECALCULATE_NOW, 0, elevate(event.triggerPriority, TAX_RECALCULATION_PRIORITIES.HIGH), triggerSourceFor(event));
  }
  if (SHORT_DEBOUNCE.has(event.eventType)) {
    return decision(TAX_RECALCULATION_OUTCOMES.DEBOUNCE, 60, event.triggerPriority, triggerSourceFor(event));
  }
  if (LONG_DEBOUNCE.has(event.eventType)) {
    return decision(TAX_RECALCULATION_OUTCOMES.DEBOUNCE, 600, event.triggerPriority, triggerSourceFor(event));
  }
  if (RESERVE_ONLY_OR_LOW.has(event.eventType)) {
    const amount = Math.abs(Number(event.materiality?.amount || 0));
    if (amount <= 0 && !changedAny(event, ["manual_balance", "current_balance", "is_primary"])) {
      return skip(TAX_RECALCULATION_OUTCOMES.SKIP_IMMATERIAL, "Reserve refresh did not change relevant values.");
    }
    return decision(TAX_RECALCULATION_OUTCOMES.QUEUE, 300, TAX_RECALCULATION_PRIORITIES.LOW, TAX_TRIGGER_SOURCES.SYSTEM);
  }
  return decision(TAX_RECALCULATION_OUTCOMES.QUEUE, 120, event.triggerPriority, TAX_TRIGGER_SOURCES.SYSTEM);

  function decision(outcome, delaySeconds, priority, triggerSource) {
    const processAfter = new Date(now.getTime() + delaySeconds * 1000).toISOString();
    return { outcome, shouldQueue: true, processAfter, debounceSeconds: delaySeconds, priority, triggerSource };
  }
}

export function isMaterialChangeComparison(comparison = {}) {
  return comparison.materialChange === true ||
    (comparison.changedWarnings || []).some((warning) => ["high", "critical", "fatal"].includes(warning.severity)) ||
    (comparison.resolvedWarnings || []).some((warning) => ["high", "critical", "fatal"].includes(warning.severity)) ||
    (comparison.newBlockers || []).length > 0;
}

export function compatibleForCoalescing(a, b) {
  if (!a || !b) return false;
  const bBusinessId = b.businessId || b.business_id;
  if (a.business_id !== bBusinessId || Number(a.tax_year) !== Number(b.taxYear || b.tax_year)) return false;
  return coalescingGroup(a.event_type) === coalescingGroup(b.eventType || b.event_type);
}

function skip(outcome, reason) {
  return { outcome, shouldQueue: false, reason, priority: TAX_RECALCULATION_PRIORITIES.LOW, triggerSource: TAX_TRIGGER_SOURCES.SYSTEM };
}

function triggerSourceFor(eventOrType) {
  const eventType = eventOrType?.eventType || eventOrType;
  const source = String(eventOrType?.source || "").toLowerCase();
  const schedulerJobType = String(eventOrType?.metadata?.schedulerJobType || "").toLowerCase();
  if (source === "tax_scheduler_daily" || schedulerJobType.startsWith("daily_tax_")) return TAX_TRIGGER_SOURCES.DAILY_CRON;
  if (source === "tax_scheduler_weekly" || schedulerJobType.startsWith("weekly_tax_")) return TAX_TRIGGER_SOURCES.WEEKLY_CRON;
  if (String(eventType).startsWith("qbo_")) return TAX_TRIGGER_SOURCES.QBO_SYNC;
  if (String(eventType).startsWith("plaid_")) return TAX_TRIGGER_SOURCES.PLAID_SYNC;
  if (String(eventType).includes("classification")) return TAX_TRIGGER_SOURCES.CLASSIFICATION_CHANGED;
  if (String(eventType).includes("profile") || String(eventType).includes("entity") || String(eventType).includes("election") || String(eventType).includes("memory")) return TAX_TRIGGER_SOURCES.TAX_PROFILE_CHANGED;
  if (String(eventType).includes("payment")) return TAX_TRIGGER_SOURCES.TAX_PAYMENT_CHANGED;
  if (String(eventType).includes("forecast")) return TAX_TRIGGER_SOURCES.FORECAST_CHANGED;
  if (String(eventType).includes("rule") || String(eventType).includes("engine")) return TAX_TRIGGER_SOURCES.ADMIN;
  return TAX_TRIGGER_SOURCES.SYSTEM;
}

function elevate(current, minimum) {
  const rank = { low: 1, normal: 2, high: 3, critical: 4 };
  return (rank[current] || 0) >= (rank[minimum] || 0) ? current : minimum;
}

function hasIdenticalBeforeAfter(event) {
  const before = event.before || {};
  const after = event.after || {};
  if (!Object.keys(before).length || !Object.keys(after).length) return false;
  return JSON.stringify(before) === JSON.stringify(after);
}

function isCosmeticOnly(event) {
  const fields = event.changedFields || [];
  if (!fields.length) return false;
  if (event.eventType === EVENTS.TAX_PROFILE_UPDATED && fields.some((field) => PROFILE_MATERIAL_FIELDS.has(field))) return false;
  return fields.every((field) => COSMETIC_FIELDS.has(field));
}

function changedAny(event, fields) {
  return fields.some((field) => (event.changedFields || []).includes(field));
}

function coalescingGroup(eventType) {
  if (String(eventType).includes("classification")) return "classification";
  if (String(eventType).includes("transaction") || String(eventType).startsWith("qbo_")) return "posted_transactions";
  if (String(eventType).includes("sync")) return "source_sync";
  if (String(eventType).includes("payment")) return "payments";
  if (String(eventType).includes("profile") || String(eventType).includes("memory") || String(eventType).includes("entity")) return "profile";
  if (String(eventType).includes("reserve")) return "reserve";
  if (String(eventType).includes("rule")) return "rules";
  return eventType;
}
