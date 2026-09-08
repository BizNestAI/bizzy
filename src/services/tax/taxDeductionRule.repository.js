// /src/services/tax/taxDeductionRule.repository.js
import { TAX_ENTITY_TYPES, TAX_JURISDICTIONS, TAX_RULE_SUPPORT_LEVELS, normalizeEntityType, normalizeTaxYear } from "./taxDomain.js";
import { taxConfigurationError, validationError } from "./taxErrors.js";
import { validateDeductionRuleShape } from "./rules/deductionRuleSchemas.js";
import { normalizeQboGlAccountKey } from "./taxQboGlNormalizer.js";

export async function listDeductionRules({
  supabase,
  businessId,
  taxYear,
  jurisdiction = TAX_JURISDICTIONS.FEDERAL,
  entityType,
  asOfDate,
  includeInactive = false,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const year = normalizeTaxYear(taxYear);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "taxYear" });

  let query = supabase.from("tax_deduction_rules").select("*").eq("tax_year", year).eq("jurisdiction", jurisdiction);
  if (!includeInactive) query = query.eq("is_active", true);
  const { data, error } = await query;
  if (error) throw taxConfigurationError("tax_deduction_rules_query_failed", "Could not load tax deduction rules.");

  const normalizedEntity = normalizeEntityType(entityType);
  const rows = (data || [])
    .filter((row) => row.business_id == null || String(row.business_id) === String(businessId))
    .filter((row) => normalizedEntity === TAX_ENTITY_TYPES.UNKNOWN || row.entity_type == null || row.entity_type === normalizedEntity)
    .map(validateDeductionRuleRow)
    .map(normalizeDeductionRule)
    .filter((row) => isEffective(row, asOfDate))
    .filter((row) => includeInactive || isRuleVerified(row));
  assertConsistentDeductionPercentUnits(rows);
  return rows;
}

export async function findMatchingDeductionRules({
  supabase,
  businessId,
  taxYear,
  transactionContext = {},
  entityType,
  jurisdiction = TAX_JURISDICTIONS.FEDERAL,
  asOfDate,
} = {}) {
  const rules = await listDeductionRules({ supabase, businessId, taxYear, jurisdiction, entityType, asOfDate });
  return evaluateDeductionRules({ rules, transactionContext, businessId });
}

export function selectBestDeductionRule({ globalRules = [], businessRules = [], transactionContext = {} } = {}) {
  return evaluateDeductionRules({ rules: [...businessRules, ...globalRules], transactionContext }).selected;
}

export function evaluateDeductionRules({ rules = [], transactionContext = {}, businessId } = {}) {
  const matched = (rules || [])
    .map(normalizeDeductionRule)
    .map(validateDeductionRuleRow)
    .filter((rule) => !businessId || rule.business_id == null || String(rule.business_id) === String(businessId))
    .filter((rule) => rule.is_active !== false)
    .filter((rule) => isEffective(rule, transactionContext.date))
    .filter((rule) => isRuleVerified(rule))
    .map((rule) => ({ rule, match: ruleMatchDetails(rule, transactionContext) }))
    .filter((item) => item.match.matched)
    .sort((a, b) => compareDeductionRules(a.rule, b.rule, transactionContext, a.match, b.match));
  const conflict = findTopRankConflict(matched, transactionContext);
  const selected = matched[0] || null;
  return {
    rules: matched.map((item) => attachMatch(item.rule, item.match)),
    selected: conflict ? null : selected ? attachMatch(selected.rule, selected.match) : null,
    conflict,
  };
}

export function validateDeductionRuleRow(row) {
  return validateDeductionRuleShape(row);
}

export function assertConsistentDeductionPercentUnits(rows = []) {
  const positive = (rows || [])
    .map((row) => Number(row.default_deductible_percent))
    .filter((value) => Number.isFinite(value) && value > 0);
  const fractionalLooking = positive.filter((value) => value > 0 && value < 1);
  const wholePercentConvention = positive.filter((value) => value >= 1);
  if (fractionalLooking.length && wholePercentConvention.length) {
    throw taxConfigurationError(
      "mixed_default_deductible_percent_units",
      "Tax deduction rule percentages must use one unit convention."
    );
  }
}

export function explainDeductionRuleMatch(rule, transactionContext = {}) {
  if (!rule) return "No deduction rule matched this transaction.";
  const scope = rule.scope === "business_override" || rule.business_id ? "business override" : "global";
  const details = rule.__match || ruleMatchDetails(rule, transactionContext);
  const reason = details.reasons?.length ? ` ${details.reasons.join("; ")}.` : "";
  const explanation = rule.explanation ? ` ${rule.explanation}` : "";
  return `Matched ${scope} rule ${rule.rule_code} at priority ${Number(rule.priority ?? 1000)}.${reason}${explanation}`;
}

function compareDeductionRules(a, b, ctx, aMatch = null, bMatch = null) {
  return compareDeductionRuleRank(a, b, ctx, aMatch, bMatch) ||
    stableRuleTieBreak(a, b);
}

function compareDeductionRuleRank(a, b, ctx, aMatch = null, bMatch = null) {
  const am = aMatch || ruleMatchDetails(a, ctx);
  const bm = bMatch || ruleMatchDetails(b, ctx);
  return (
    scopeRank(a) - scopeRank(b) ||
    bm.exactGlAliasRank - am.exactGlAliasRank ||
    Number(a.priority ?? 1000) - Number(b.priority ?? 1000) ||
    bm.specificity - am.specificity ||
    bm.conditionSpecificity - am.conditionSpecificity ||
    Date.parse(b.verified_at || 0) - Date.parse(a.verified_at || 0) ||
    String(b.version || "").localeCompare(String(a.version || ""), undefined, { numeric: true, sensitivity: "base" })
  );
}

function stableRuleTieBreak(a, b) {
  return String(a.rule_code || "").localeCompare(String(b.rule_code || ""), undefined, { numeric: true, sensitivity: "base" }) ||
    String(a.id || "").localeCompare(String(b.id || ""), undefined, { numeric: true, sensitivity: "base" });
}

function findTopRankConflict(matched, ctx) {
  if (matched.length < 2) return null;
  const top = matched[0];
  const tied = matched.filter((item) => compareDeductionRuleRank(top.rule, item.rule, ctx, top.match, item.match) === 0);
  const conflicts = tied.filter((item) => item === top || conflictsWithRule(top.rule, item.rule));
  if (conflicts.length < 2) return null;
  return {
    code: "conflicting_deduction_rules",
    ruleCodes: conflicts.map((item) => item.rule.rule_code).filter(Boolean),
    ruleIds: conflicts.map((item) => item.rule.id).filter(Boolean),
  };
}

function conflictsWithRule(a, b) {
  return String(a.tax_category || "") !== String(b.tax_category || "") ||
    String(a.deductibility_status || "") !== String(b.deductibility_status || "") ||
    Number(a.default_deductible_percent) !== Number(b.default_deductible_percent) ||
    JSON.stringify(a.treatment || {}) !== JSON.stringify(b.treatment || {});
}

function ruleMatches(rule, ctx) {
  return ruleMatchDetails(rule, ctx).matched;
}

function ruleMatchDetails(rule, ctx = {}) {
  const reasons = [];
  let spec = 0;
  if (rule.entity_type) {
    if (rule.entity_type !== ctx.entity_type) return noMatch();
    spec += 20;
    reasons.push(`entity_type=${rule.entity_type}`);
  }
  if (rule.bookkeeping_category) {
    if (!sameTaxGlText(rule.bookkeeping_category, ctx.bookkeeping_category || ctx.qbo_account_name || ctx.normalized_qbo_account_name)) return noMatch();
    spec += 40;
    reasons.push(`bookkeeping_category=${rule.bookkeeping_category}`);
  }
  if (rule.qbo_account_type) {
    if (!sameTaxGlText(rule.qbo_account_type, ctx.qbo_account_type || ctx.normalized_qbo_account_type)) return noMatch();
    spec += 20;
    reasons.push(`qbo_account_type=${rule.qbo_account_type}`);
  }
  if (rule.qbo_account_subtype) {
    if (!sameTaxGlText(rule.qbo_account_subtype, ctx.qbo_account_subtype || ctx.normalized_qbo_account_subtype)) return noMatch();
    spec += 30;
    reasons.push(`qbo_account_subtype=${rule.qbo_account_subtype}`);
  }
  const conditionMatch = matchConditions(rule.match_conditions, ctx);
  if (!conditionMatch.matched) return noMatch();
  return {
    matched: true,
    specificity: spec + conditionMatch.specificity,
    conditionSpecificity: conditionMatch.specificity,
    exactGlAliasRank: conditionMatch.exactGlAlias ? 1 : 0,
    reasons: [...reasons, ...conditionMatch.reasons],
  };
}

function matchConditions(conditions, ctx) {
  if (!conditions || !Object.keys(conditions).length) return { matched: true, specificity: 0, reasons: [], exactGlAlias: false };
  let specificityScore = 0;
  const reasons = [];
  let exactGlAlias = false;
  for (const [key, expected] of Object.entries(conditions)) {
    if (isNonMatchingMetadataKey(key)) continue;
    const result = matchCondition(key, expected, ctx);
    if (!result.matched) return { matched: false, specificity: 0, reasons: [] };
    specificityScore += result.specificity;
    if (result.exactGlAlias) exactGlAlias = true;
    if (result.reason) reasons.push(result.reason);
  }
  return { matched: true, specificity: specificityScore, reasons, exactGlAlias };
}

function matchCondition(key, expected, ctx) {
  const actual = ctx[key];
  if (key === "vendor_names") return matchAnyText(expected, [ctx.vendor, ctx.counterparty, ctx.merchant], "vendor");
  if (key === "merchant_regex") return matchRegex(expected, [ctx.merchant, ctx.vendor, ctx.counterparty], "merchant_regex");
  if (key === "description_regex") return matchRegex(expected, [ctx.description, ctx.memo], "description_regex");
  if (key === "minimum_amount" || key === "min_amount") return compareAmount(ctx.absolute_amount ?? Math.abs(Number(ctx.signed_amount || 0)), expected, ">=", key);
  if (key === "maximum_amount" || key === "max_amount") return compareAmount(ctx.absolute_amount ?? Math.abs(Number(ctx.signed_amount || 0)), expected, "<=", key);
  if (key === "entity_types") return matchArray(expected, ctx.entity_type, "entity_type");
  if (key === "taxonomy_types") return matchArray(expected, ctx.taxonomy_type, "taxonomy_type");
  if (key === "job_costing_tags") return matchArrayOverlap(expected, ctx.job_costing_tags, "job_costing_tags");
  if (key === "requires_employee") return matchBoolean(expected, ctx.has_employee || ctx.employee_id, "requires_employee");
  if (key === "requires_reimbursement") return matchBoolean(expected, ctx.is_reimbursement, "requires_reimbursement");
  if (key === "requires_inventory") return matchBoolean(expected, ctx.has_inventory || ctx.inventory_item_id, "requires_inventory");
  if (key === "assigned_job_required") return matchBoolean(expected, ctx.job_id || ctx.assigned_job_id, "assigned_job_required");
  if (key === "qbo_account_names") return matchAnyText(expected, [ctx.qbo_account_name], "qbo_account_name");
  if (key === "qbo_account_name_keys") {
    const result = matchArray(expected, ctx.normalized_qbo_account_name || normalizeQboGlAccountKey(ctx.qbo_account_name), "qbo_account_name_key");
    return result.matched ? { ...result, exactGlAlias: true, specificity: 80 } : result;
  }
  if (key === "qbo_account_subtype_keys") return matchArray(expected, ctx.normalized_qbo_account_subtype || normalizeQboGlAccountKey(ctx.qbo_account_subtype), "qbo_account_subtype_key");
  if (key === "direction") return matchArray(Array.isArray(expected) ? expected : [expected], ctx.direction, "direction");
  if (key === "merchant_entity_id") return matchScalar(expected, ctx.merchant_entity_id, key);
  if (key.endsWith("_regex")) return matchRegex(expected, [actual], key);
  if (Array.isArray(expected)) return matchArray(expected, actual, key);
  if (typeof expected === "string" && expected.startsWith("regex:")) return matchRegex(expected.slice(6), [actual], key);
  return matchScalar(expected, actual, key);
}

function matchAnyText(expected, actualValues, label) {
  const expectedValues = Array.isArray(expected) ? expected : [expected];
  const matched = expectedValues.some((value) => actualValues.some((actual) => textIncludes(actual, value)));
  return matched ? { matched: true, specificity: 8, reason: `${label} matched` } : noMatch();
}

function matchRegex(expected, actualValues, label) {
  const pattern = String(expected || "").replace(/^regex:/, "");
  if (!pattern) return noMatch();
  const regex = new RegExp(pattern, "i");
  const matched = actualValues.some((actual) => regex.test(String(actual || "")));
  return matched ? { matched: true, specificity: 10, reason: `${label} matched` } : noMatch();
}

function matchArray(expected, actual, label) {
  const set = new Set((Array.isArray(expected) ? expected : [expected]).map(normalizeComparable));
  const matched = set.has(normalizeComparable(actual));
  return matched ? { matched: true, specificity: 6, reason: `${label} matched` } : noMatch();
}

function matchArrayOverlap(expected, actual, label) {
  const expectedSet = new Set((Array.isArray(expected) ? expected : [expected]).map(normalizeComparable));
  const actualValues = Array.isArray(actual) ? actual : [actual];
  const matched = actualValues.some((value) => expectedSet.has(normalizeComparable(value)));
  return matched ? { matched: true, specificity: 6, reason: `${label} matched` } : noMatch();
}

function matchBoolean(expected, actual, label) {
  const expectedBool = expected === true || expected === "true";
  const actualBool = actual === true || Boolean(actual);
  return expectedBool === actualBool ? { matched: true, specificity: 4, reason: `${label}=${expectedBool}` } : noMatch();
}

function compareAmount(actual, expected, op, label) {
  const a = Number(actual);
  const e = Number(expected);
  if (!Number.isFinite(a) || !Number.isFinite(e)) return noMatch();
  const matched = op === ">=" ? a >= e : a <= e;
  return matched ? { matched: true, specificity: 5, reason: `${label} ${op} ${e}` } : noMatch();
}

function matchScalar(expected, actual, label) {
  const matched = normalizeComparable(expected) === normalizeComparable(actual);
  return matched ? { matched: true, specificity: 3, reason: `${label} matched` } : noMatch();
}

function scopeRank(rule) {
  return rule.scope === "business_override" || rule.business_id ? 0 : 1;
}

function normalizeDeductionRule(row) {
  return {
    ...row,
    scope: row.scope || (row.business_id ? "business_override" : "global"),
    support_level: row.support_level || (isRuleVerified(row) ? TAX_RULE_SUPPORT_LEVELS.VERIFIED : TAX_RULE_SUPPORT_LEVELS.UNVERIFIED),
  };
}

function isRuleVerified(row) {
  if (row.support_level) return row.support_level === TAX_RULE_SUPPORT_LEVELS.VERIFIED;
  if (row.scope === "business_override" || row.business_id) return Boolean(row.source_reference || row.verified_at);
  return Boolean(row.verified_at && (row.source_reference || row.source_url));
}

function attachMatch(rule, match) {
  return { ...rule, __match: match, exact_gl_alias_match: match.exactGlAliasRank > 0 };
}

function noMatch() {
  return { matched: false, specificity: 0, reason: null, reasons: [], exactGlAliasRank: 0 };
}

function isNonMatchingMetadataKey(key) {
  return [
    "state_adjustment_hook",
    "high_confidence",
    "medium_confidence",
    "needs_review",
    "notes",
  ].includes(key);
}

function textIncludes(actual, expected) {
  return normalizeComparable(actual).includes(normalizeComparable(expected));
}

function normalizeComparable(value) {
  return normalizeQboGlAccountKey(value);
}

function sameTaxGlText(a, b) {
  return normalizeQboGlAccountKey(a) === normalizeQboGlAccountKey(b);
}

function isEffective(row, asOfDate = new Date().toISOString().slice(0, 10)) {
  const date = String(asOfDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
  return (!row.effective_from || String(row.effective_from).slice(0, 10) <= date) &&
    (!row.effective_to || String(row.effective_to).slice(0, 10) >= date);
}

export const __testables = {
  ruleMatches,
  ruleMatchDetails,
  compareDeductionRules,
  compareDeductionRuleRank,
};
