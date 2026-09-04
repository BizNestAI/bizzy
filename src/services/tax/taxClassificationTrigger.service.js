import { TAX_CLASSIFICATION_TRIGGER_SOURCES } from "./taxDomain.js";
import { computeTaxProfileCompleteness, getTaxProfile } from "./taxProfile.service.js";
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
    const beforeComplete = computeTaxProfileCompleteness(metadata?.before || null).isCompleteForEstimate === true;
    const afterProfile = metadata?.after || await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
    const afterComplete = computeTaxProfileCompleteness(afterProfile).isCompleteForEstimate === true;
    if (!afterComplete || beforeComplete) return { queued: false, outcome: "profile_not_newly_complete" };
    const completedFromOnboarding = String(metadata?.source || afterProfile?.source || "").toLowerCase() === "onboarding";
    const triggerSource = completedFromOnboarding
      ? TAX_CLASSIFICATION_TRIGGER_SOURCES.ONBOARDING_PROFILE_COMPLETED
      : TAX_CLASSIFICATION_TRIGGER_SOURCES.PROFILE_COMPLETED;
    return enqueueTaxClassificationRun({
      supabase,
      businessId,
      taxYear,
      triggerSource,
      actorUserId: userId,
      sourceRecordId: entityId,
      metadata: { source: completedFromOnboarding ? "onboarding_profile_completed" : "tax_profile_completed" },
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
