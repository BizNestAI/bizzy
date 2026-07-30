import { TAX_RECALCULATION_EVENT_TYPES as EVENTS } from "../taxRecalculationEventDomain.js";

const FIELD_EVENTS = {
  entity_type: EVENTS.TAX_ENTITY_CHANGED,
  tax_election: EVENTS.TAX_ELECTION_CHANGED,
  filing_status: EVENTS.TAX_FILING_STATUS_CHANGED,
  primary_tax_state: EVENTS.TAX_STATE_CHANGED,
  accounting_method: EVENTS.TAX_ACCOUNTING_METHOD_CHANGED,
};

export function taxProfileEvent({ changeType, businessId, taxYear, profileId, userId, before, after, changedFields = [], source = "tax_profile" } = {}) {
  const materialField = changedFields.find((field) => FIELD_EVENTS[field]);
  return {
    eventType: changeType === "tax_profile_created" ? EVENTS.TAX_PROFILE_CREATED : FIELD_EVENTS[materialField] || EVENTS.TAX_PROFILE_UPDATED,
    businessId,
    taxYear: taxYear ?? after?.tax_year ?? before?.tax_year,
    userId,
    source,
    sourceRecordId: profileId || after?.id || before?.id,
    sourceTable: "tax_profiles",
    changedFields,
    before,
    after,
  };
}
