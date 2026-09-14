import { normalizeMerchantIdentity } from "./merchantNormalization.js";

export function signedAmountMinor(transaction = {}) {
  const signed = Number(transaction.signed_amount);
  if (Number.isFinite(signed) && signed !== 0) return Math.round(signed * 100);
  const amount = Number(transaction.amount);
  if (Number.isFinite(amount)) return Math.round(amount * 100);
  return null;
}

function normalizeConditionText(value = "") {
  return normalizeMerchantIdentity(value).normalized;
}

export function validateVendorRuleMatchConditions(conditions = null) {
  if (conditions == null) return { ok: true, normalized: null };
  if (!conditions || typeof conditions !== "object" || Array.isArray(conditions)) {
    return { ok: false, reason: "match_conditions_malformed" };
  }
  const allowedTop = new Set(["version", "amount", "description"]);
  for (const key of Object.keys(conditions)) {
    if (!allowedTop.has(key)) return { ok: false, reason: `unsupported_match_condition_${key}` };
  }
  if (conditions.version !== 1) return { ok: false, reason: "unsupported_match_conditions_version" };
  const normalized = { version: 1 };

  if (conditions.amount != null) {
    if (!conditions.amount || typeof conditions.amount !== "object" || Array.isArray(conditions.amount)) {
      return { ok: false, reason: "amount_condition_malformed" };
    }
    const allowedAmount = new Set(["exact_minor", "currency"]);
    for (const key of Object.keys(conditions.amount)) {
      if (!allowedAmount.has(key)) return { ok: false, reason: `unsupported_amount_condition_${key}` };
    }
    if (!Number.isInteger(conditions.amount.exact_minor)) return { ok: false, reason: "amount_exact_minor_must_be_integer" };
    if (conditions.amount.currency != null && String(conditions.amount.currency).toUpperCase() !== "USD") {
      return { ok: false, reason: "unsupported_amount_currency" };
    }
    normalized.amount = {
      exact_minor: conditions.amount.exact_minor,
      currency: "USD",
    };
  }

  if (conditions.description != null) {
    if (!conditions.description || typeof conditions.description !== "object" || Array.isArray(conditions.description)) {
      return { ok: false, reason: "description_condition_malformed" };
    }
    const allowedDescription = new Set(["include_any", "exclude_any"]);
    for (const key of Object.keys(conditions.description)) {
      if (!allowedDescription.has(key)) return { ok: false, reason: `unsupported_description_condition_${key}` };
    }
    const normalizeList = (values) => {
      if (values == null) return [];
      if (!Array.isArray(values)) return null;
      return values.map((value) => normalizeConditionText(value)).filter(Boolean);
    };
    const includeAny = normalizeList(conditions.description.include_any);
    const excludeAny = normalizeList(conditions.description.exclude_any);
    if (!includeAny || !excludeAny) return { ok: false, reason: "description_conditions_must_be_arrays" };
    normalized.description = {};
    if (includeAny.length) normalized.description.include_any = [...new Set(includeAny)];
    if (excludeAny.length) normalized.description.exclude_any = [...new Set(excludeAny)];
  }

  return { ok: true, normalized };
}

export function vendorRuleMatchConditionsPass(rule = {}, bankTransaction = {}, buildMemo = () => "") {
  const validation = validateVendorRuleMatchConditions(rule.match_conditions);
  if (!validation.ok) return { ok: false, reason: validation.reason };
  const conditions = validation.normalized;
  if (!conditions) return { ok: true, reason: "unconditional" };

  if (conditions.amount?.exact_minor != null) {
    const minor = signedAmountMinor(bankTransaction);
    if (minor !== conditions.amount.exact_minor) return { ok: false, reason: "amount_exact_minor_mismatch" };
  }

  if (conditions.description) {
    const normalizedMemo = normalizeConditionText(buildMemo(bankTransaction));
    const includes = conditions.description.include_any || [];
    if (includes.length && !includes.some((token) => normalizedMemo.includes(token))) {
      return { ok: false, reason: "description_include_missing" };
    }
    const excludes = conditions.description.exclude_any || [];
    if (excludes.some((token) => normalizedMemo.includes(token))) {
      return { ok: false, reason: "description_excluded" };
    }
  }

  return { ok: true, reason: "conditions_passed" };
}
