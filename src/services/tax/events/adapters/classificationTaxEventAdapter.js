import { TAX_RECALCULATION_EVENT_TYPES as EVENTS } from "../taxRecalculationEventDomain.js";

const MAP = {
  tax_classification_confirmed: EVENTS.TRANSACTION_CLASSIFICATION_CONFIRMED,
  tax_classification_overridden: EVENTS.TRANSACTION_CLASSIFICATION_OVERRIDDEN,
  tax_classification_excluded: EVENTS.TRANSACTION_CLASSIFICATION_EXCLUDED,
  tax_classification_restored: EVENTS.TRANSACTION_CLASSIFICATION_RESTORED,
  tax_classification_rejected: EVENTS.TRANSACTION_CLASSIFIED,
  tax_business_rule_created: EVENTS.TAX_DEDUCTION_RULE_UPDATED,
};

export function classificationTaxEvent({ changeType, businessId, taxYear, transactionId, userId, before, after, reason, correlationId } = {}) {
  return {
    eventType: MAP[changeType] || EVENTS.TRANSACTION_CLASSIFIED,
    businessId,
    taxYear,
    userId,
    source: "tax_classification",
    sourceRecordId: transactionId,
    sourceTable: "transaction_tax_classifications",
    changedFields: changedFields(before, after),
    before,
    after,
    correlationId,
    materiality: {
      amount: Math.abs(Number(after?.book_amount ?? before?.book_amount ?? 0)) || null,
      transactionCount: 1,
      classificationBucketChanged: before?.deductibility_status !== after?.deductibility_status || before?.tax_category !== after?.tax_category,
    },
    metadata: { reason },
  };
}

function changedFields(before = {}, after = {}) {
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter((field) => before?.[field] !== after?.[field]);
}
