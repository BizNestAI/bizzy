import { TAX_CLASSIFICATION_TRIGGER_SOURCES } from "./taxDomain.js";
import { getTaxProfile } from "./taxProfile.service.js";
import { enqueueTaxClassificationRun } from "./taxClassificationRun.service.js";

const CLASSIFICATION_TRIGGER_EVENTS = Object.freeze({
  PROFILE_CREATED: "tax_profile_created",
  PROFILE_UPDATED: "tax_profile_updated",
  QBO_TRANSACTION_POSTED: "qbo_transaction_posted",
  BUSINESS_RULE_CREATED: "tax_business_rule_created",
});

export async function handleTaxClassificationEvent({ supabase, businessId, taxYear, changeType, entityId = null, userId = null, metadata = {}, now = new Date() } = {}) {
  if (!supabase || !businessId || !taxYear || !changeType) return { queued: false, outcome: "missing_context" };
  if (changeType === CLASSIFICATION_TRIGGER_EVENTS.PROFILE_CREATED || changeType === CLASSIFICATION_TRIGGER_EVENTS.PROFILE_UPDATED) {
    const afterProfile = metadata?.after || await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
    if (!hasClassificationContext(afterProfile)) return { queued: false, outcome: "classification_context_missing" };
    if (changeType === CLASSIFICATION_TRIGGER_EVENTS.PROFILE_UPDATED && !classificationContextChanged(metadata?.before, afterProfile)) {
      return { queued: false, outcome: "classification_context_unchanged" };
    }
    const completedFromOnboarding = String(metadata?.source || afterProfile?.source || "").toLowerCase() === "onboarding";
    return enqueueTaxClassificationRun({
      supabase,
      businessId,
      taxYear,
      triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.PROFILE_CONTEXT_UPDATED,
      actorUserId: userId,
      sourceRecordId: entityId,
      metadata: { source: completedFromOnboarding ? "onboarding_profile_context_updated" : "tax_profile_context_updated" },
      now,
    });
  }
  if (changeType === CLASSIFICATION_TRIGGER_EVENTS.QBO_TRANSACTION_POSTED) {
    return enqueueTaxClassificationRun({
      supabase,
      businessId,
      taxYear,
      triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.QBO_TRANSACTION_POSTED,
      actorUserId: userId,
      sourceRecordId: entityId,
      metadata: { source: "qbo_transaction_posted" },
      now,
    });
  }
  if (changeType === CLASSIFICATION_TRIGGER_EVENTS.BUSINESS_RULE_CREATED) {
    return enqueueTaxClassificationRun({
      supabase,
      businessId,
      taxYear,
      triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.RULES_CHANGED,
      actorUserId: userId,
      sourceRecordId: entityId,
      metadata: { source: "tax_rules_changed" },
      now,
    });
  }
  return { queued: false, outcome: "unsupported_classification_trigger" };
}

function hasClassificationContext(profile = {}) {
  if (!profile?.entity_type || ["unknown", "unsupported"].includes(String(profile.entity_type))) return false;
  return true;
}

function classificationContextChanged(before = {}, after = {}) {
  if (!before) return true;
  return ["entity_type", "tax_election", "primary_tax_state", "accounting_method"].some((field) => before?.[field] !== after?.[field]);
}
