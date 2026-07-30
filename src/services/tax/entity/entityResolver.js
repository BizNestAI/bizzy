// /src/services/tax/entity/entityResolver.js
import { TAX_ELECTIONS, TAX_ENTITY_TYPES, normalizeEntityType, normalizeTaxElection } from "../taxDomain.js";
import {
  ENTITY_BLOCKER_CODES,
  ENTITY_PATHS,
  ENTITY_SUPPORT_STATUSES,
  ENTITY_TAX_TREATMENTS,
  ENTITY_WARNING_CODES,
  entityBlocker,
  entityWarning,
} from "./entityDomain.js";

const UNSUPPORTED_ALIASES = new Map([
  ["partnership", { code: ENTITY_WARNING_CODES.PARTNERSHIP_UNSUPPORTED, label: "Partnerships are not supported by the MVP Entity Engine." }],
  ["multi_member_llc", { code: ENTITY_WARNING_CODES.MULTI_MEMBER_LLC_UNSUPPORTED, label: "Multi-member LLCs are not supported by the MVP Entity Engine." }],
  ["multi member llc", { code: ENTITY_WARNING_CODES.MULTI_MEMBER_LLC_UNSUPPORTED, label: "Multi-member LLCs are not supported by the MVP Entity Engine." }],
  ["c_corp", { code: ENTITY_WARNING_CODES.C_CORP_UNSUPPORTED, label: "C-Corps are not supported by the MVP Entity Engine." }],
  ["c-corp", { code: ENTITY_WARNING_CODES.C_CORP_UNSUPPORTED, label: "C-Corps are not supported by the MVP Entity Engine." }],
  ["c corp", { code: ENTITY_WARNING_CODES.C_CORP_UNSUPPORTED, label: "C-Corps are not supported by the MVP Entity Engine." }],
  ["nonprofit", { code: ENTITY_WARNING_CODES.UNSUPPORTED_ENTITY, label: "Nonprofits are not supported by the MVP Entity Engine." }],
  ["trust", { code: ENTITY_WARNING_CODES.UNSUPPORTED_ENTITY, label: "Trusts are not supported by the MVP Entity Engine." }],
  ["estate", { code: ENTITY_WARNING_CODES.UNSUPPORTED_ENTITY, label: "Estates are not supported by the MVP Entity Engine." }],
  ["other", { code: ENTITY_WARNING_CODES.UNSUPPORTED_ENTITY, label: "This entity type is not supported by the MVP Entity Engine." }],
]);

export function resolveEntityPath({ entityType, taxElection, profile = {}, memories = [] } = {}) {
  const rawEntityType = entityType ?? profile?.entity_type ?? profile?.entityType ?? null;
  const rawTaxElection = taxElection ?? profile?.tax_election ?? profile?.taxElection ?? null;
  const unsupported = detectUnsupported(rawEntityType);
  if (unsupported) {
    return buildUnsupported({ rawEntityType, rawTaxElection, unsupported });
  }

  const normalizedEntityType = normalizeEntityType(rawEntityType);
  const normalizedTaxElection = normalizeTaxElection(rawTaxElection);
  const diagnostics = {
    rawEntityType,
    rawTaxElection,
    normalizedEntityType,
    normalizedTaxElection,
    memoryKeysAvailable: Array.isArray(memories) ? memories.map((memory) => memory.memory_key).filter(Boolean) : [],
  };
  const warnings = [];
  const blockers = [];
  const conflicts = [];

  if (!rawEntityType || normalizedEntityType === TAX_ENTITY_TYPES.UNKNOWN) {
    blockers.push(entityBlocker(ENTITY_BLOCKER_CODES.MISSING_ENTITY_TYPE, "Confirm the business entity type before authoritative tax routing.", { field: "entity_type" }));
    warnings.push(entityWarning(ENTITY_WARNING_CODES.ENTITY_TYPE_UNKNOWN, "critical", "Entity type is unknown."));
    return result({
      entityType: TAX_ENTITY_TYPES.UNKNOWN,
      taxElection: normalizedTaxElection || TAX_ELECTIONS.UNKNOWN,
      entityPath: ENTITY_PATHS.UNKNOWN,
      taxTreatment: ENTITY_TAX_TREATMENTS.UNSUPPORTED,
      supportStatus: ENTITY_SUPPORT_STATUSES.UNKNOWN,
      warnings,
      blockers,
      conflicts,
      diagnostics,
    });
  }

  if (normalizedEntityType === TAX_ENTITY_TYPES.SOLE_PROPRIETOR) {
    if (normalizedTaxElection === TAX_ELECTIONS.S_CORP) {
      conflicts.push(conflict("sole_prop_s_corp_conflict", "critical", "entity_type", "A sole proprietor profile cannot also be marked as an S-Corp election.", "Update entity type or tax election."));
      blockers.push(entityBlocker(ENTITY_BLOCKER_CODES.INVALID_ENTITY_COMBINATION, "Entity type and tax election conflict.", { field: "tax_election" }));
    }
    return result({
      entityType: normalizedEntityType,
      taxElection: normalizedTaxElection || TAX_ELECTIONS.SOLE_PROPRIETOR,
      entityPath: conflicts.length ? ENTITY_PATHS.UNKNOWN : ENTITY_PATHS.SOLE_PROPRIETOR,
      taxTreatment: conflicts.length ? ENTITY_TAX_TREATMENTS.UNSUPPORTED : ENTITY_TAX_TREATMENTS.SCHEDULE_C_LIKE,
      supportStatus: conflicts.length ? ENTITY_SUPPORT_STATUSES.UNKNOWN : ENTITY_SUPPORT_STATUSES.SUPPORTED,
      warnings,
      blockers,
      conflicts,
      diagnostics,
    });
  }

  if (normalizedEntityType === TAX_ENTITY_TYPES.SINGLE_MEMBER_LLC) {
    if (!rawTaxElection || normalizedTaxElection === TAX_ELECTIONS.UNKNOWN) {
      blockers.push(entityBlocker(ENTITY_BLOCKER_CODES.MISSING_TAX_ELECTION, "A single-member LLC needs an explicit tax election before authoritative tax routing.", { field: "tax_election" }));
      warnings.push(entityWarning(ENTITY_WARNING_CODES.LLC_TAX_ELECTION_MISSING, "critical", "Confirm whether the single-member LLC is disregarded or elected S-Corp treatment."));
      return result({
        entityType: normalizedEntityType,
        taxElection: TAX_ELECTIONS.UNKNOWN,
        entityPath: ENTITY_PATHS.UNKNOWN,
        taxTreatment: ENTITY_TAX_TREATMENTS.UNSUPPORTED,
        supportStatus: ENTITY_SUPPORT_STATUSES.UNKNOWN,
        warnings,
        blockers,
        conflicts,
        diagnostics,
      });
    }
    if (normalizedTaxElection === TAX_ELECTIONS.DISREGARDED_ENTITY || normalizedTaxElection === TAX_ELECTIONS.SOLE_PROPRIETOR) {
      return result({
        entityType: normalizedEntityType,
        taxElection: TAX_ELECTIONS.DISREGARDED_ENTITY,
        entityPath: ENTITY_PATHS.SINGLE_MEMBER_LLC_DISREGARDED,
        taxTreatment: ENTITY_TAX_TREATMENTS.SCHEDULE_C_LIKE,
        supportStatus: ENTITY_SUPPORT_STATUSES.SUPPORTED,
        warnings,
        blockers,
        conflicts,
        diagnostics,
      });
    }
    if (normalizedTaxElection === TAX_ELECTIONS.S_CORP) {
      return result({
        entityType: normalizedEntityType,
        taxElection: TAX_ELECTIONS.S_CORP,
        entityPath: ENTITY_PATHS.S_CORPORATION,
        taxTreatment: ENTITY_TAX_TREATMENTS.PASS_THROUGH_S_CORP,
        supportStatus: ENTITY_SUPPORT_STATUSES.PARTIAL,
        warnings,
        blockers,
        conflicts,
        diagnostics,
      });
    }
  }

  if (normalizedEntityType === TAX_ENTITY_TYPES.S_CORP) {
    if (normalizedTaxElection && normalizedTaxElection !== TAX_ELECTIONS.UNKNOWN && normalizedTaxElection !== TAX_ELECTIONS.S_CORP) {
      conflicts.push(conflict("s_corp_election_conflict", "critical", "tax_election", "S-Corp entity type conflicts with the stored tax election.", "Confirm S-Corp election details."));
      blockers.push(entityBlocker(ENTITY_BLOCKER_CODES.INVALID_ENTITY_COMBINATION, "S-Corp entity type conflicts with tax election.", { field: "tax_election" }));
    } else if (!rawTaxElection || normalizedTaxElection === TAX_ELECTIONS.UNKNOWN) {
      warnings.push(entityWarning(ENTITY_WARNING_CODES.S_CORP_ELECTION_UNCONFIRMED, "high", "Confirm the S-Corp election before relying on S-Corp routing."));
    }
    return result({
      entityType: normalizedEntityType,
      taxElection: normalizedTaxElection === TAX_ELECTIONS.S_CORP ? TAX_ELECTIONS.S_CORP : TAX_ELECTIONS.UNKNOWN,
      entityPath: conflicts.length ? ENTITY_PATHS.UNKNOWN : ENTITY_PATHS.S_CORPORATION,
      taxTreatment: conflicts.length ? ENTITY_TAX_TREATMENTS.UNSUPPORTED : ENTITY_TAX_TREATMENTS.PASS_THROUGH_S_CORP,
      supportStatus: conflicts.length ? ENTITY_SUPPORT_STATUSES.UNKNOWN : ENTITY_SUPPORT_STATUSES.PARTIAL,
      warnings,
      blockers,
      conflicts,
      diagnostics,
    });
  }

  return buildUnsupported({ rawEntityType, rawTaxElection, unsupported: { code: ENTITY_WARNING_CODES.UNSUPPORTED_ENTITY, label: "This entity type is not supported by the MVP Entity Engine." } });
}

function buildUnsupported({ rawEntityType, rawTaxElection, unsupported }) {
  const entityType = normalizeEntityType(rawEntityType);
  return result({
    entityType,
    taxElection: normalizeTaxElection(rawTaxElection),
    entityPath: ENTITY_PATHS.UNSUPPORTED,
    taxTreatment: ENTITY_TAX_TREATMENTS.UNSUPPORTED,
    supportStatus: ENTITY_SUPPORT_STATUSES.UNSUPPORTED,
    warnings: [entityWarning(unsupported.code, "critical", unsupported.label)],
    blockers: [entityBlocker(ENTITY_BLOCKER_CODES.UNSUPPORTED_ENTITY_TYPE, unsupported.label, { field: "entity_type" })],
    conflicts: [],
    diagnostics: { rawEntityType, rawTaxElection, normalizedEntityType: entityType, normalizedTaxElection: normalizeTaxElection(rawTaxElection) },
  });
}

function detectUnsupported(value) {
  if (value == null || value === "") return null;
  return UNSUPPORTED_ALIASES.get(String(value).trim().toLowerCase()) || null;
}

function result(payload) {
  return {
    ...payload,
    isSupported: payload.supportStatus === ENTITY_SUPPORT_STATUSES.SUPPORTED || payload.supportStatus === ENTITY_SUPPORT_STATUSES.PARTIAL,
  };
}

function conflict(code, severity, field, message, suggestedAction) {
  return { code, severity, field, message, suggestedAction };
}
