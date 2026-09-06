import { TAX_CLASSIFICATION_TRIGGER_SOURCES } from "./taxDomain.js";
import { getTaxProfile } from "./taxProfile.service.js";
import {
  markTaxClassificationStaleForTransaction,
  markMachineTaxClassificationsStaleForBusinessYear,
  neutralizeTaxClassificationForTransaction,
} from "./taxClassification.repository.js";
import { enqueueTaxClassificationRun } from "./taxClassificationRun.service.js";

const CLASSIFICATION_TRIGGER_EVENTS = Object.freeze({
  PROFILE_CREATED: "tax_profile_created",
  PROFILE_UPDATED: "tax_profile_updated",
  QBO_TRANSACTION_POSTED: "qbo_transaction_posted",
  QBO_TRANSACTION_UPDATED: "qbo_transaction_updated",
  QBO_TRANSACTION_VOIDED: "qbo_transaction_voided",
  QBO_TRANSACTION_DELETED: "qbo_transaction_deleted",
  QBO_TRANSACTION_REVERSED: "qbo_transaction_reversed",
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
    const queued = await enqueueTaxClassificationRun({
      supabase,
      businessId,
      taxYear,
      triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.PROFILE_CONTEXT_UPDATED,
      actorUserId: userId,
      sourceRecordId: entityId,
      metadata: { source: completedFromOnboarding ? "onboarding_profile_context_updated" : "tax_profile_context_updated" },
      now,
    });
    logClassificationTrigger({ businessId, taxYear, changeType, entityId, queued });
    return queued;
  }
  if (changeType === CLASSIFICATION_TRIGGER_EVENTS.QBO_TRANSACTION_POSTED) {
    const profile = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
    if (!hasClassificationContext(profile)) return { queued: false, outcome: "classification_context_missing" };
    const queued = await enqueueTaxClassificationRun({
      supabase,
      businessId,
      taxYear,
      triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.QBO_TRANSACTION_POSTED,
      actorUserId: userId,
      sourceRecordId: entityId,
      metadata: { source: "qbo_transaction_posted" },
      now,
    });
    logClassificationTrigger({ businessId, taxYear, changeType, entityId, queued });
    return queued;
  }
  if (changeType === CLASSIFICATION_TRIGGER_EVENTS.QBO_TRANSACTION_UPDATED) {
    const profile = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
    if (!hasClassificationContext(profile)) return { queued: false, outcome: "classification_context_missing" };
    const stale = entityId
      ? await markTaxClassificationStaleForTransaction({
          supabase,
          businessId,
          taxYear,
          transactionId: entityId,
          reason: "posted_bookkeeping_facts_changed",
          metadata,
          now,
        })
      : { changed: false };
    const queued = await enqueueTaxClassificationRun({
      supabase,
      businessId,
      taxYear,
      triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.QBO_TRANSACTION_POSTED,
      actorUserId: userId,
      sourceRecordId: entityId,
      metadata: { source: "qbo_transaction_updated", staleChanged: stale.changed === true },
      now,
    });
    logClassificationTrigger({ businessId, taxYear, changeType, entityId, queued, stale });
    return { ...queued, stale };
  }
  if (changeType === CLASSIFICATION_TRIGGER_EVENTS.QBO_TRANSACTION_VOIDED || changeType === CLASSIFICATION_TRIGGER_EVENTS.QBO_TRANSACTION_DELETED) {
    const neutralized = entityId
      ? await neutralizeTaxClassificationForTransaction({
          supabase,
          businessId,
          taxYear,
          transactionId: entityId,
          reason: changeType === CLASSIFICATION_TRIGGER_EVENTS.QBO_TRANSACTION_DELETED ? "qbo_transaction_deleted" : "qbo_transaction_voided",
          metadata,
          now,
        })
      : { changed: false };
    logClassificationTrigger({ businessId, taxYear, changeType, entityId, neutralized });
    return { queued: false, outcome: neutralized.changed ? "classification_neutralized" : "no_classification_to_neutralize", neutralized };
  }
  if (changeType === CLASSIFICATION_TRIGGER_EVENTS.QBO_TRANSACTION_REVERSED) {
    const profile = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
    if (!hasClassificationContext(profile)) return { queued: false, outcome: "classification_context_missing" };
    const queued = await enqueueTaxClassificationRun({
      supabase,
      businessId,
      taxYear,
      triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.QBO_TRANSACTION_POSTED,
      actorUserId: userId,
      sourceRecordId: entityId,
      metadata: { source: "qbo_transaction_reversed" },
      now,
    });
    logClassificationTrigger({ businessId, taxYear, changeType, entityId, queued });
    return queued;
  }
  if (changeType === CLASSIFICATION_TRIGGER_EVENTS.BUSINESS_RULE_CREATED) {
    const profile = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
    if (!hasClassificationContext(profile)) return { queued: false, outcome: "classification_context_missing" };
    const stale = await markMachineTaxClassificationsStaleForBusinessYear({
      supabase,
      businessId,
      taxYear,
      reason: "classification_rules_changed",
      sourceRecordId: entityId,
      now,
    });
    const queued = await enqueueTaxClassificationRun({
      supabase,
      businessId,
      taxYear,
      triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.RULES_CHANGED,
      actorUserId: userId,
      sourceRecordId: entityId,
      metadata: { source: "tax_rules_changed" },
      now,
    });
    logClassificationTrigger({ businessId, taxYear, changeType, entityId, queued, stale });
    return { ...queued, stale };
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

function logClassificationTrigger({ businessId, taxYear, changeType, entityId, queued = null, stale = null, neutralized = null }) {
  console.log("[tax-classification-trigger]", {
    businessId,
    taxYear,
    triggerSource: changeType,
    sourceRecordId: entityId || null,
    runId: queued?.run?.id || null,
    outcome: queued?.outcome || (neutralized?.changed ? "classification_neutralized" : null),
    affectedTransactionCount: resolveAffectedTransactionCount({ queued, stale, neutralized }),
  });
}

function resolveAffectedTransactionCount({ queued = null, stale = null, neutralized = null } = {}) {
  if (Number.isFinite(Number(queued?.run?.queued_count))) return Number(queued.run.queued_count);
  if (Number.isFinite(Number(queued?.unclassifiedCount))) return Number(queued.unclassifiedCount);
  if (Number.isFinite(Number(stale?.changed))) return Number(stale.changed);
  if (stale?.changed === true) return 1;
  if (Number.isFinite(Number(neutralized?.changed))) return Number(neutralized.changed);
  if (neutralized?.changed === true) return 1;
  return 0;
}
