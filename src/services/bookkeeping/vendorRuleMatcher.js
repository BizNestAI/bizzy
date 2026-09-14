/* global process */
import { normalizeMerchantIdentity, normalizedMerchantKeys } from "./merchantNormalization.js";
import { BUSINESS_MERCHANT_RULE_SOURCE } from "./vendorRuleLearner.js";
import { signedAmountMinor, vendorRuleMatchConditionsPass } from "./vendorRuleMatchConditions.js";

export function normalizeText(str = "") {
  return String(str || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function buildMemo(tx = {}) {
  const parts = [tx.name, tx.merchant_name, tx.counterparty_name, tx.raw?.name].filter(Boolean);
  return normalizeText(parts.join(" "));
}

export function cleanMemoForPrefix(memo = "") {
  return normalizeMerchantIdentity(memo).normalized;
}

export function computeMemoPrefix(tx = {}, N = 20) {
  const memo = buildMemo(tx);
  const cleanedMemo = cleanMemoForPrefix(memo);
  const prefix = (cleanedMemo || "").slice(0, N);
  return { cleanedMemo, prefix };
}

function hasCategoryDefaults(rule) {
  return !!(rule && rule.default_qbo_account_id);
}

function parseRuleNotes(notes = "") {
  if (!notes || typeof notes !== "string") return {};
  try {
    const parsed = JSON.parse(notes);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isActiveRule(rule = {}) {
  const notes = parseRuleNotes(rule.notes);
  return notes.state !== "superseded" && notes.active !== false;
}

function directionMatches(rule = {}, bankTransaction = {}) {
  const hint = String(rule.direction_hint || "").toUpperCase();
  if (!hint || hint === "UNKNOWN") return true;
  const raw = String(bankTransaction.direction || "").toUpperCase();
  if (raw === "INFLOW" || raw === "OUTFLOW") return raw === hint;
  const minor = signedAmountMinor(bankTransaction);
  if (minor == null || minor === 0) return false;
  return hint === (minor < 0 ? "OUTFLOW" : "INFLOW");
}

function ruleSpecificity(rule = {}) {
  return parseRuleNotes(rule.notes).match_specificity || (rule.match_type === "merchant_entity_id" ? "exact_provider_merchant_id" : "broad_fuzzy_alias");
}

function devLog(businessId, bankTransaction, debug) {
  if (process.env.NODE_ENV === "production") return;
  const payload = {
    business_id: businessId,
    plaid_transaction_id: bankTransaction?.plaid_transaction_id || null,
    merchant_entity_id: bankTransaction?.merchant_entity_id || null,
    cleaned_memo: cleanMemoForPrefix(buildMemo(bankTransaction)),
    steps: debug?.steps || [],
  };
  console.info("[vendorRuleMatcher][debug]", payload);
}

function shapeRule(rule, match_reason, match_score) {
  if (!rule) return null;
  return {
    id: rule.id,
    match_type: rule.match_type,
    match_value: rule.match_value,
    counterparty_name: rule.counterparty_name,
    default_qbo_account_id: rule.default_qbo_account_id,
    default_qbo_account_name: rule.default_qbo_account_name,
    direction_hint: rule.direction_hint,
    confidence: rule.confidence,
    qbo_entity_type: rule.qbo_entity_type,
    qbo_entity_id: rule.qbo_entity_id,
    usage_count: rule.usage_count,
    last_used_at: rule.last_used_at,
    source: rule.source,
    source_type: parseRuleNotes(rule.notes).source_type || rule.source || null,
    authority: parseRuleNotes(rule.notes).authority || null,
    match_specificity: ruleSpecificity(rule),
    match_conditions: rule.match_conditions || null,
    match_reason,
    match_score,
  };
}

function ruleEligibleForTransaction(rule = {}, bankTransaction = {}) {
  if (!hasCategoryDefaults(rule)) return false;
  if (!isActiveRule(rule)) return false;
  if (!directionMatches(rule, bankTransaction)) return false;
  return vendorRuleMatchConditionsPass(rule, bankTransaction, buildMemo).ok === true;
}

export async function getVendorRuleForTransaction({ businessId, bankTransaction, db = null } = {}) {
  if (!businessId || !bankTransaction) return null;
  if (!db) {
    const { supabase } = await import("../supabaseAdmin.js");
    db = supabase;
  }
  const debug = { steps: [] };

  // 1) merchant_entity_id exact
  const merchantEntityId = bankTransaction.merchant_entity_id || null;
  if (merchantEntityId) {
    const { data: meRules, error: meErr } = await db
      .from("vendor_rules")
      .select("*")
      .eq("business_id", businessId)
      .eq("match_type", "merchant_entity_id")
      .eq("match_value", merchantEntityId)
      .eq("rule_kind", "category_default")
      .not("default_qbo_account_id", "is", null)
      .limit(1);
    debug.steps.push({ tier: "merchant_entity_id", returned: meRules?.length || 0, error: !!meErr });
    if (!meErr && meRules?.length) {
      const rule = meRules.find((candidate) => ruleEligibleForTransaction(candidate, bankTransaction));
      if (rule) return shapeRule(rule, "merchant_entity_id", 1000);
    }
  }

  // 2) memo_prefix
  const { cleanedMemo } = computeMemoPrefix(bankTransaction);
  const normalizedKeys = normalizedMerchantKeys(bankTransaction).keys;
  if (cleanedMemo) {
    const { data: prefixRules, error: mpErr } = await db
      .from("vendor_rules")
      .select("*")
      .eq("business_id", businessId)
      .eq("match_type", "memo_prefix")
      .eq("rule_kind", "category_default")
      .not("default_qbo_account_id", "is", null)
      .limit(500);
    debug.steps.push({ tier: "memo_prefix", returned: prefixRules?.length || 0, error: !!mpErr });
    if (!mpErr && prefixRules?.length) {
      let best = null;
      let bestLen = 0;
      for (const rule of prefixRules) {
        const ruleVal = cleanMemoForPrefix(rule.match_value || "");
        if (!ruleVal) continue;
        if (!isActiveRule(rule)) continue;
        const specificity = ruleSpecificity(rule);
        if (!directionMatches(rule, bankTransaction)) continue;
        if (vendorRuleMatchConditionsPass(rule, bankTransaction, buildMemo).ok !== true) continue;
        const exactAuthorized =
          rule.source === BUSINESS_MERCHANT_RULE_SOURCE &&
          ["exact_normalized_merchant", "exact_descriptor_fingerprint", "memo_fingerprint"].includes(specificity);
        const normalizedMatch = exactAuthorized
          ? normalizedKeys.some((key) => key === ruleVal) || cleanedMemo === ruleVal
          : normalizedKeys.some((key) => key === ruleVal || key.startsWith(ruleVal));
        if ((exactAuthorized ? normalizedMatch : (cleanedMemo.startsWith(ruleVal) || normalizedMatch)) && ruleVal.length > bestLen) {
          if (hasCategoryDefaults(rule)) {
            best = rule;
            bestLen = ruleVal.length;
          }
        }
      }
      if (best) {
        return shapeRule(best, "memo_prefix", 500 + bestLen);
      }
    }
  }

  // 3) regex
  const rawMemo = buildMemo(bankTransaction);
  const { data: regexRules, error: rxErr } = await db
    .from("vendor_rules")
    .select("*")
    .eq("business_id", businessId)
    .eq("match_type", "regex")
    .eq("rule_kind", "category_default")
    .not("default_qbo_account_id", "is", null)
    .limit(200);
  debug.steps.push({ tier: "regex", returned: regexRules?.length || 0, error: !!rxErr });
  if (!rxErr && regexRules?.length) {
    for (const rule of regexRules) {
      const pattern = rule.match_value;
      if (!pattern) continue;
      try {
        const re = new RegExp(pattern, "i");
        if (re.test(rawMemo) || re.test(cleanedMemo)) {
          if (ruleEligibleForTransaction(rule, bankTransaction)) {
            return shapeRule(rule, "regex", 300);
          }
        }
      } catch {
        continue;
      }
    }
  }

  // 4) QBO entity match
  if (bankTransaction.qbo_entity_type && bankTransaction.qbo_entity_id) {
    const { data: entityRules, error: entErr } = await db
      .from("vendor_rules")
      .select("*")
      .eq("business_id", businessId)
      .eq("qbo_entity_type", bankTransaction.qbo_entity_type)
      .eq("qbo_entity_id", bankTransaction.qbo_entity_id)
      .not("default_qbo_account_id", "is", null);
    debug.steps.push({ tier: "qbo_entity", returned: entityRules?.length || 0, error: !!entErr });
    if (!entErr && entityRules?.length) {
      const sorted = [...entityRules].filter((rule) => ruleEligibleForTransaction(rule, bankTransaction)).sort((a, b) => {
        const ua = a.usage_count || 0;
        const ub = b.usage_count || 0;
        if (ua !== ub) return ub - ua;
        const da = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
        const db = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
        return db - da;
      });
      const best = sorted[0];
      return shapeRule(best, "qbo_entity", 200 + (best.usage_count || 0));
    }
  }

  devLog(businessId, bankTransaction, { steps: [...debug.steps, { tier: "result", match: null, note: "no_category_match" }] });
  return null;
}
