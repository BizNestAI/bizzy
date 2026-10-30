import { VEHICLE_QUESTION_ANSWER_CONTRACT } from "./taxVehicleQuestionContract.js";

// User-facing questions are grouped by answer semantics. Classifier
// provenance, including rule version, deliberately remains on source rows.
export function buildTaxQuestionSemanticManifest({ row = {}, decisionType } = {}) {
  const taxCategory = normalizeTaxCategory(value(row.taxCategory, row.tax_category));
  const qboAccountId = text(value(row.qboAccountId, row.qbo_account_id, row.source_qbo_account_id, row.raw?.source_qbo_account_id, row.metadata?.source_qbo_account_id));
  const subject = semanticSubject({ row, decisionType, taxCategory, qboAccountId });
  const current = canonicalCurrentTreatment(decisionType, {
    taxCategory,
    taxTreatment: semantic(value(row.taxTreatment, row.tax_treatment, row.raw?.tax_treatment)),
    deductiblePercent: nullableNumber(value(row.deductiblePercent, row.deductible_percent, row.raw?.deductible_percent)),
    deductibilityStatus: text(value(row.deductibilityStatus, row.deductibility_status, row.raw?.deductibility_status)),
  });
  return {
    version: 1,
    decisionType: text(decisionType),
    normalizedTaxCategory: taxCategory,
    subject,
    answerContract: answerContract(decisionType, current),
    authorityContract: {
      actionableStatus: "needs_review",
      requiresReview: true,
      protectedAuthoritiesExcluded: ["customer", "bizzi_operator", "cpa"],
      explicitPersonalExceptionsPreserved: decisionType === "business_use_confirmation",
    },
  };
}

export function fingerprintTaxQuestionSemanticManifest(manifest) {
  return `tqsm-v1-${fnv1a64(stableJson(manifest))}`;
}

export function buildTaxQuestionIdentity({ businessId, taxYear, row = {}, decisionType } = {}) {
  const manifest = buildTaxQuestionSemanticManifest({ row, decisionType });
  const semanticFingerprint = fingerprintTaxQuestionSemanticManifest(manifest);
  const qboAccountId = text(value(row.qboAccountId, row.qbo_account_id, row.source_qbo_account_id, row.raw?.source_qbo_account_id, row.metadata?.source_qbo_account_id)) || "unmapped";
  return {
    id: [`business:${text(businessId) || "unknown"}`, `year:${Number(taxYear) || "unknown"}`, `gl:${qboAccountId}`, `type:${text(decisionType) || "none"}`, `subject:${manifest.subject.kind}:${manifest.subject.key}`, `semantic:${semanticFingerprint}`].join("|"),
    manifest,
    semanticFingerprint,
  };
}

function answerContract(decisionType, current) {
  if (decisionType === "business_use_percent") return {
    schema: { required: ["businessUsePercent"], businessUsePercent: { type: "number", minimum: 0, maximum: 100 } },
    outcomes: { percentage: { taxCategory: current.taxCategory, taxTreatment: "business_use_allocation", deductiblePercent: "input", deductibilityStatus: "derived_from_percent" } },
    currentTreatment: current,
  };
  if (decisionType === "vehicle_method") return {
    ...VEHICLE_QUESTION_ANSWER_CONTRACT,
    currentTreatment: current,
  };
  return {
    schema: { required: ["answer"], answer: { enum: ["all_business", "some_personal", "not_sure"] }, personalExceptionIds: { type: "transaction_id_set", requiredWhen: "some_personal" } },
    outcomes: {
      all_business: confirmedTreatment(current),
      some_personal: { ...confirmedTreatment(current), exceptions: { treatment: "preserved_unchanged", excludedFromAccountDefaultApplication: true } },
      not_sure: { taxCategory: current.taxCategory, taxTreatment: "unchanged", deductiblePercent: "unchanged", deductibilityStatus: "needs_review" },
    },
  };
}

function confirmedTreatment(current) {
  const meals = current.taxCategory === "business_meals";
  const unresolvedStatus = ["", "needs_review", "not_yet_determined"].includes(text(current.deductibilityStatus).toLowerCase());
  return { taxCategory: current.taxCategory, taxTreatment: meals ? "business_meals_business_purpose_confirmed" : "business_purpose_confirmed", deductiblePercent: current.deductiblePercent == null ? (meals ? 50 : 100) : current.deductiblePercent, deductibilityStatus: unresolvedStatus ? (meals ? "partially_deductible" : "fully_deductible") : current.deductibilityStatus };
}

function canonicalCurrentTreatment(decisionType, current) {
  const status = text(current.deductibilityStatus).toLowerCase();
  const treatment = text(current.taxTreatment).toLowerCase();
  const unresolved = ["", "needs_review", "not_yet_determined"].includes(status);
  const placeholder = treatment === "needs_review"
    || (decisionType === "vehicle_method" && treatment === "vehicle_expense")
    || (decisionType === "business_use_percent" && treatment === "utilities_review");
  if (!unresolved || !placeholder) return current;
  return { ...current, taxTreatment: "needs_review", deductibilityStatus: "" };
}

function semanticSubject({ row, decisionType, taxCategory, qboAccountId }) {
  const metadata = row.metadata || row.raw?.metadata || {};
  const vehicle = text(value(row.vehicleId, row.vehicle_id, metadata.vehicle_id, metadata.vehicleId));
  const allocation = text(value(row.allocationSubject, row.allocation_subject, metadata.allocation_subject, metadata.allocationSubject));
  if (decisionType === "vehicle_method") return { kind: vehicle ? "vehicle" : "vehicle_gl", key: vehicle || qboAccountId || taxCategory };
  if (decisionType === "business_use_percent") return { kind: allocation ? "allocation" : "allocation_gl", key: allocation || qboAccountId || taxCategory };
  return { kind: "tax_category", key: taxCategory };
}

function normalizeTaxCategory(input) { return text(input).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }
function nullableNumber(input) { return input == null || input === "" ? null : Number(input); }
function text(input) { return input == null ? "" : String(input).trim(); }
function value(...values) { return values.find((item) => item != null && item !== ""); }
function semantic(input) { return input && typeof input === "object" ? input.type || input : input ?? null; }
function stableJson(input) { if (Array.isArray(input)) return `[${input.map(stableJson).join(",")}]`; if (input && typeof input === "object") return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${stableJson(input[key])}`).join(",")}}`; return JSON.stringify(input ?? null); }
function fnv1a64(input) { let hash = 0xcbf29ce484222325n; const prime = 0x100000001b3n; const mask = 0xffffffffffffffffn; for (let index = 0; index < input.length; index += 1) { hash ^= BigInt(input.charCodeAt(index)); hash = (hash * prime) & mask; } return hash.toString(16).padStart(16, "0"); }

export const __testables = { answerContract, canonicalCurrentTreatment, semanticSubject, stableJson };
