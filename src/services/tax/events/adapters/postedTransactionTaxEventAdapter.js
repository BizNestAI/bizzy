import { TAX_RECALCULATION_EVENT_TYPES as EVENTS } from "../taxRecalculationEventDomain.js";

export function postedTransactionTaxEvent({ eventType = EVENTS.QBO_TRANSACTION_POSTED, businessId, taxYear, transactionId, userId, amount, before, after, source = "posted_transaction" } = {}) {
  return {
    eventType,
    businessId,
    taxYear,
    userId,
    source,
    sourceRecordId: transactionId,
    sourceTable: "qbo_posted_transactions",
    changedFields: ["amount", "status"],
    before,
    after,
    materiality: { amount: Math.abs(Number(amount ?? after?.amount ?? before?.amount ?? 0)) || null, transactionCount: 1 },
  };
}
