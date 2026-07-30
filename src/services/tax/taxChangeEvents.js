/* global process */
// /src/services/tax/taxChangeEvents.js
import { handleTaxRecalculationEvent } from "./events/taxRecalculationTrigger.service.js";
import { TAX_RECALCULATION_EVENT_TYPES, isNonRecalculationEvent } from "./events/taxRecalculationEventDomain.js";

export const TAX_CHANGE_TYPES = Object.freeze({
  PROFILE_CREATED: "tax_profile_created",
  PROFILE_UPDATED: "tax_profile_updated",
  PROFILE_ARCHIVED: "tax_profile_archived",
  MEMORY_SET: "tax_memory_set",
  MEMORY_EXPIRED: "tax_memory_expired",
  CLASSIFICATION_OVERRIDDEN: "tax_classification_overridden",
  CLASSIFICATION_CONFIRMED: "tax_classification_confirmed",
  CLASSIFICATION_REJECTED: "tax_classification_rejected",
  CLASSIFICATION_EXCLUDED: "tax_classification_excluded",
  CLASSIFICATION_RESTORED: "tax_classification_restored",
  BUSINESS_RULE_CREATED: "tax_business_rule_created",
  PAYMENT_CREATED: "tax_payment_created",
  PAYMENT_UPDATED: "tax_payment_updated",
  PAYMENT_VOIDED: "tax_payment_voided",
  QBO_TRANSACTION_POSTED: "qbo_transaction_posted",
  QBO_TRANSACTION_VOIDED: "qbo_transaction_voided",
  RESERVE_ACCOUNT_CREATED: "tax_reserve_account_created",
  RESERVE_ACCOUNT_UPDATED: "tax_reserve_account_updated",
  RESERVE_ACCOUNT_PRIMARY_CHANGED: "tax_reserve_account_primary_changed",
  RESERVE_BALANCE_REFRESHED: "tax_reserve_balance_refreshed",
  CALCULATION_MATERIALLY_CHANGED: "tax_calculation_materially_changed",
});

let deps = {
  supabase: null,
  handleTaxRecalculationEvent,
};

export function __setTaxChangeEventTestDeps(next = {}) {
  deps = { ...deps, ...next };
}

export function emitTaxDataChanged({ businessId, taxYear, changeType, entityId, userId, metadata = {} } = {}) {
  if (!businessId || !changeType) return;
  try {
    if (process.env.NODE_ENV !== "production") {
      console.log("[tax-change]", { businessId, taxYear, changeType, entityId, userId });
    }
    if (changeType === TAX_CHANGE_TYPES.CALCULATION_MATERIALLY_CHANGED && process.env.NODE_ENV !== "test" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      import("../insights/contractorCfoTriggerService.js")
        .then((mod) => mod.triggerContractorCfoInsightsBestEffort?.({ businessId, trigger: "tax", force: false }))
        .catch((err) => console.warn("[tax-change] downstream signal failed", err?.message || err));
    }
    const eventType = mapChangeTypeToRecalculationEvent(changeType);
    if (!eventType || isNonRecalculationEvent(eventType)) return;
    if (process.env.NODE_ENV !== "test" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      getSupabaseForEvents().then((supabase) => deps.handleTaxRecalculationEvent?.({
        supabase,
        event: {
          eventType,
          businessId,
          taxYear,
          userId,
          source: "tax_change_event",
          sourceRecordId: entityId,
          sourceTable: sourceTableFor(eventType),
          correlationId: metadata.correlationId || entityId || null,
          changedFields: metadata.changedFields,
          before: metadata.before,
          after: metadata.after,
          materiality: metadata.materiality,
          metadata,
        },
      })).catch((err) => console.warn("[tax-change] recalculation enqueue failed", err?.message || err));
    }
  } catch (err) {
    console.warn("[tax-change] downstream signal failed", err?.message || err);
  }
}

async function getSupabaseForEvents() {
  if (deps.supabase) return deps.supabase;
  const mod = await import("../supabaseAdmin.js");
  return mod.supabase;
}

export function mapChangeTypeToRecalculationEvent(changeType) {
  const map = {
    [TAX_CHANGE_TYPES.PROFILE_CREATED]: TAX_RECALCULATION_EVENT_TYPES.TAX_PROFILE_CREATED,
    [TAX_CHANGE_TYPES.PROFILE_UPDATED]: TAX_RECALCULATION_EVENT_TYPES.TAX_PROFILE_UPDATED,
    [TAX_CHANGE_TYPES.MEMORY_SET]: TAX_RECALCULATION_EVENT_TYPES.TAX_MEMORY_UPDATED,
    [TAX_CHANGE_TYPES.MEMORY_EXPIRED]: TAX_RECALCULATION_EVENT_TYPES.TAX_MEMORY_EXPIRED,
    [TAX_CHANGE_TYPES.CLASSIFICATION_OVERRIDDEN]: TAX_RECALCULATION_EVENT_TYPES.TRANSACTION_CLASSIFICATION_OVERRIDDEN,
    [TAX_CHANGE_TYPES.CLASSIFICATION_CONFIRMED]: TAX_RECALCULATION_EVENT_TYPES.TRANSACTION_CLASSIFICATION_CONFIRMED,
    [TAX_CHANGE_TYPES.CLASSIFICATION_REJECTED]: TAX_RECALCULATION_EVENT_TYPES.TRANSACTION_CLASSIFIED,
    [TAX_CHANGE_TYPES.CLASSIFICATION_EXCLUDED]: TAX_RECALCULATION_EVENT_TYPES.TRANSACTION_CLASSIFICATION_EXCLUDED,
    [TAX_CHANGE_TYPES.CLASSIFICATION_RESTORED]: TAX_RECALCULATION_EVENT_TYPES.TRANSACTION_CLASSIFICATION_RESTORED,
    [TAX_CHANGE_TYPES.BUSINESS_RULE_CREATED]: TAX_RECALCULATION_EVENT_TYPES.TAX_DEDUCTION_RULE_UPDATED,
    [TAX_CHANGE_TYPES.PAYMENT_CREATED]: TAX_RECALCULATION_EVENT_TYPES.TAX_PAYMENT_CREATED,
    [TAX_CHANGE_TYPES.PAYMENT_UPDATED]: TAX_RECALCULATION_EVENT_TYPES.TAX_PAYMENT_UPDATED,
    [TAX_CHANGE_TYPES.PAYMENT_VOIDED]: TAX_RECALCULATION_EVENT_TYPES.TAX_PAYMENT_VOIDED,
    [TAX_CHANGE_TYPES.QBO_TRANSACTION_POSTED]: TAX_RECALCULATION_EVENT_TYPES.QBO_TRANSACTION_POSTED,
    [TAX_CHANGE_TYPES.QBO_TRANSACTION_VOIDED]: TAX_RECALCULATION_EVENT_TYPES.QBO_TRANSACTION_VOIDED,
    [TAX_CHANGE_TYPES.RESERVE_ACCOUNT_CREATED]: TAX_RECALCULATION_EVENT_TYPES.TAX_RESERVE_ACCOUNT_CREATED,
    [TAX_CHANGE_TYPES.RESERVE_ACCOUNT_UPDATED]: TAX_RECALCULATION_EVENT_TYPES.TAX_RESERVE_ACCOUNT_UPDATED,
    [TAX_CHANGE_TYPES.RESERVE_ACCOUNT_PRIMARY_CHANGED]: TAX_RECALCULATION_EVENT_TYPES.TAX_RESERVE_ACCOUNT_PRIMARY_CHANGED,
    [TAX_CHANGE_TYPES.RESERVE_BALANCE_REFRESHED]: TAX_RECALCULATION_EVENT_TYPES.TAX_RESERVE_BALANCE_REFRESHED,
  };
  return map[changeType] || null;
}

function sourceTableFor(eventType) {
  if (String(eventType).includes("classification")) return "transaction_tax_classifications";
  if (String(eventType).includes("profile")) return "tax_profiles";
  if (String(eventType).includes("memory")) return "tax_profile_memory";
  if (String(eventType).includes("payment")) return "tax_payments";
  if (String(eventType).includes("reserve")) return "tax_reserve_accounts";
  if (String(eventType).startsWith("qbo_")) return "qbo_posted_transactions";
  if (String(eventType).includes("rule")) return "tax_deduction_rules";
  return null;
}
