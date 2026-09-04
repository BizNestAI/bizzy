const TAX_LIFECYCLE_STATUSES = [
  "profile_required",
  "profile_draft",
  "profile_invalid",
  "classifications_required",
  "calculation_required",
  "calculating",
  "available",
  "stale",
  "calculation_failed",
  "insufficient_financial_data",
  "unsupported_entity",
  "unsupported_state",
];
const READINESS_STATUSES = new Set(["ready", "partial", "blocked", "setup_required", "unavailable", "unknown", ...TAX_LIFECYCLE_STATUSES]);
const RUN_STATUSES = new Set(["completed", "partial", "failed", "running", "superseded", "abandoned", "unknown", ...TAX_LIFECYCLE_STATUSES]);
const SAFE_HARBOR_STATUSES = new Set(["available", "partial", "unavailable", "unknown"]);
const RESERVE_STATUSES = new Set([
  "on_track",
  "slightly_behind",
  "reserve_gap",
  "critical_shortfall",
  "setup_incomplete",
  "unavailable",
  "unknown",
]);

export function normalizeTaxOverview(payload) {
  const contractWarnings = [];
  const source = unwrap(payload);
  const dto = isObject(source) ? { ...source } : {};
  if (!isObject(source)) contractWarnings.push("tax overview payload was not an object");

  const data = {
    ...dto,
    meta: normalizeMeta(dto.meta, contractWarnings),
    readiness: normalizeReadiness(dto.readiness, contractWarnings),
    summary: isObject(dto.summary) ? { ...dto.summary } : {},
    profile: dto.profile ?? null,
    actuals: dto.actuals ?? null,
    projection: dto.projection ?? null,
    federal: dto.federal ?? null,
    state: dto.state ?? null,
    payments: dto.payments ?? null,
    safeHarbor: normalizeSafeHarbor(dto.safeHarbor, contractWarnings),
    reserve: normalizeReserve(dto.reserve, contractWarnings),
    deadlines: arrayOrEmpty(dto.deadlines),
    confidence: normalizeConfidence(dto.confidence),
    warnings: arrayOrEmpty(dto.warnings),
    assumptions: arrayOrEmpty(dto.assumptions),
    unsupportedItems: arrayOrEmpty(dto.unsupportedItems),
    supportedButDeferred: arrayOrEmpty(dto.supportedButDeferred),
    explanationSummary: dto.explanationSummary ?? null,
    links: isObject(dto.links) ? { ...dto.links } : {},
  };

  if (isDev() && contractWarnings.length) {
    console.warn("[tax] canonical overview contract warnings", contractWarnings);
  }

  return { data, contractWarnings };
}

function unwrap(payload) {
  if (payload?.ok === true && "data" in payload) return payload.data;
  return payload?.data && payload?.meta == null ? payload.data : payload;
}

function normalizeMeta(meta, warnings) {
  const next = isObject(meta) ? { ...meta } : {};
  if (!isObject(meta)) warnings.push("meta missing or invalid");
  const status = next.status || "unknown";
  next.status = RUN_STATUSES.has(status) ? status : "unknown";
  return next;
}

function normalizeReadiness(readiness, warnings) {
  const next = isObject(readiness) ? { ...readiness } : {};
  if (!isObject(readiness)) warnings.push("readiness missing or invalid");
  const status = next.status || next.setupState?.status || "unknown";
  next.status = READINESS_STATUSES.has(status) ? status : "unknown";
  next.blockers = arrayOrEmpty(next.blockers);
  next.actions = arrayOrEmpty(next.actions);
  next.setupState = next.setupState ?? null;
  return next;
}

function normalizeSafeHarbor(safeHarbor, warnings) {
  if (safeHarbor == null) return null;
  if (!isObject(safeHarbor)) {
    warnings.push("safeHarbor invalid");
    return null;
  }
  const next = { ...safeHarbor };
  const status = next.status || next.combined?.status || "unknown";
  next.status = SAFE_HARBOR_STATUSES.has(status) ? status : "unknown";
  next.warnings = arrayOrEmpty(next.warnings);
  if (next.status === "unavailable") {
    preserveNull(next, ["requiredAnnual", "coveredAmount", "remainingAmount"]);
  }
  return next;
}

function normalizeReserve(reserve, warnings) {
  if (reserve == null) return null;
  if (!isObject(reserve)) {
    warnings.push("reserve invalid");
    return null;
  }
  const next = { ...reserve };
  const status = next.status || "unknown";
  next.status = RESERVE_STATUSES.has(status) ? status : "unknown";
  next.warnings = arrayOrEmpty(next.warnings);
  if (next.reserveBalance === undefined) next.reserveBalance = null;
  if (next.primaryAccount === undefined) next.primaryAccount = null;
  return next;
}

function normalizeConfidence(confidence) {
  if (confidence == null || !isObject(confidence)) return confidence ?? null;
  return {
    ...confidence,
    factors: arrayOrEmpty(confidence.factors),
    blockers: arrayOrEmpty(confidence.blockers),
    improvementActions: arrayOrEmpty(confidence.improvementActions),
  };
}

function preserveNull(target, keys) {
  for (const key of keys) {
    if (target[key] === undefined) target[key] = null;
  }
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isDev() {
  return (
    typeof import.meta !== "undefined" && import.meta.env?.DEV
  );
}

export default normalizeTaxOverview;
