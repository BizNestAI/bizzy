import { TAX_RECALCULATION_EVENT_TYPES as EVENTS } from "../taxRecalculationEventDomain.js";

export function taxMemoryEvent({ changeType, businessId, taxYear, memoryKey, recordId, userId, before, after } = {}) {
  const eventType = changeType === "tax_memory_expired"
    ? EVENTS.TAX_MEMORY_EXPIRED
    : before
      ? EVENTS.TAX_MEMORY_UPDATED
      : EVENTS.TAX_MEMORY_CREATED;
  return {
    eventType,
    businessId,
    taxYear,
    userId,
    source: "tax_memory",
    sourceRecordId: recordId || memoryKey,
    sourceTable: "tax_profile_memory",
    changedFields: ["value_json", "effective_from", "effective_to"],
    before,
    after,
    metadata: { memoryKey },
  };
}
