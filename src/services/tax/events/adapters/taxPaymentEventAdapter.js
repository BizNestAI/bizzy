import { TAX_RECALCULATION_EVENT_TYPES as EVENTS } from "../taxRecalculationEventDomain.js";

const MAP = {
  tax_payment_created: EVENTS.TAX_PAYMENT_CREATED,
  tax_payment_updated: EVENTS.TAX_PAYMENT_UPDATED,
  tax_payment_voided: EVENTS.TAX_PAYMENT_VOIDED,
};

export function taxPaymentEvent({ changeType, businessId, taxYear, paymentId, userId, before, after } = {}) {
  return {
    eventType: MAP[changeType] || EVENTS.TAX_PAYMENT_UPDATED,
    businessId,
    taxYear: taxYear ?? after?.tax_year ?? before?.tax_year,
    userId,
    source: "tax_payment",
    sourceRecordId: paymentId || after?.id || before?.id,
    sourceTable: "tax_payments",
    changedFields: changedFields(before, after),
    before,
    after,
    materiality: { amount: Math.abs(Number(after?.amount ?? before?.amount ?? 0)) || null },
  };
}

function changedFields(before = {}, after = {}) {
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter((field) => before?.[field] !== after?.[field]);
}
