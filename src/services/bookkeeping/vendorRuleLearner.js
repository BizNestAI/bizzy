import { NORMALIZATION_VERSION, normalizeMerchantIdentity } from "./merchantNormalization.js";
import { validateVendorRuleMatchConditions } from "./vendorRuleMatchConditions.js";

const LANDMINE_TYPES = new Set(["transfer_internal", "cc_payment", "owner_draw", "owner_contribution", "refund", "payroll", "peer_to_peer_transfer"]);
const GENERIC_IDENTITY_TOKENS = new Set(["payment", "purchase", "online", "mobile", "store", "thank", "you", "thank you", "card", "debit", "credit", "pmt", "ach"]);
export const BUSINESS_MERCHANT_RULE_SOURCE = "business_merchant_rule";
export const BUSINESS_MERCHANT_RULE_VERSION = "business_merchant_rule_v1";

export function normalizeText(str = "") {
  return String(str || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function buildMemoForLearning(tx = {}) {
  return normalizeText([tx.name, tx.merchant_name, tx.counterparty_name].filter(Boolean).join(" "));
}

export function cleanMemoForPrefix(memo = "") {
  return normalizeMerchantIdentity(memo).normalized;
}

export function computeMemoPrefixForLearning(tx = {}, N = 20) {
  const memo = buildMemoForLearning(tx);
  const cleanedMemo = cleanMemoForPrefix(memo);
  const prefix = (cleanedMemo || "").slice(0, N);
  return { prefix };
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

function stringifyRuleNotes(notes = {}) {
  return JSON.stringify(notes);
}

function isSpecificIdentity(value = "") {
  const normalized = String(value || "").trim();
  if (normalized.length < 5) return false;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  if (tokens.every((token) => GENERIC_IDENTITY_TOKENS.has(token))) return false;
  if (tokens.length === 1 && GENERIC_IDENTITY_TOKENS.has(tokens[0])) return false;
  return true;
}

export function buildAuthorizedMerchantRuleIdentity(bankTxn = {}) {
  const merchantEntityId = bankTxn.merchant_entity_id || bankTxn.merchant_id || null;
  if (merchantEntityId) {
    return {
      match_type: "merchant_entity_id",
      match_value: merchantEntityId,
      match_specificity: "exact_provider_merchant_id",
      normalized_merchant: null,
      normalized_descriptor: null,
      normalization_version: NORMALIZATION_VERSION,
    };
  }

  const merchantIdentity = normalizeMerchantIdentity(bankTxn.merchant_name || bankTxn.counterparty_name || "");
  if (isSpecificIdentity(merchantIdentity.normalized)) {
    return {
      match_type: "memo_prefix",
      match_value: merchantIdentity.normalized,
      match_specificity: "exact_normalized_merchant",
      normalized_merchant: merchantIdentity.normalized,
      normalized_descriptor: null,
      normalization_version: merchantIdentity.normalization_version,
    };
  }

  const descriptorIdentity = normalizeMerchantIdentity([bankTxn.name, bankTxn.merchant_name, bankTxn.counterparty_name].filter(Boolean).join(" "));
  if (isSpecificIdentity(descriptorIdentity.normalized)) {
    return {
      match_type: "memo_prefix",
      match_value: descriptorIdentity.normalized,
      match_specificity: "exact_descriptor_fingerprint",
      normalized_merchant: merchantIdentity.normalized || null,
      normalized_descriptor: descriptorIdentity.normalized,
      normalization_version: descriptorIdentity.normalization_version,
    };
  }

  const memo = computeMemoPrefixForLearning(bankTxn, 80).prefix;
  if (isSpecificIdentity(memo) && memo.length >= 10) {
    return {
      match_type: "memo_prefix",
      match_value: memo,
      match_specificity: "memo_fingerprint",
      normalized_merchant: merchantIdentity.normalized || null,
      normalized_descriptor: descriptorIdentity.normalized || null,
      normalization_version: NORMALIZATION_VERSION,
    };
  }

  return null;
}

export function canonicalTxnDirection(tx = {}) {
  const dirRaw = tx.direction || tx.Direction || null;
  const direction = typeof dirRaw === "string" ? dirRaw.toUpperCase() : dirRaw;
  if (direction === "INFLOW" || direction === "OUTFLOW") return direction;
  const amt = Number(tx.amount || 0);
  if (amt > 0) return "INFLOW";
  if (amt < 0) return "OUTFLOW";
  return "UNKNOWN";
}

export function looksLikeTaxonomyLandmineMemo(tx = {}) {
  const memo = normalizeText([tx.name, tx.merchant_name, tx.counterparty_name].filter(Boolean).join(" "));
  const pfcPrimary = (tx.personal_finance_category?.primary || "").toUpperCase();
  const primary = (tx.category_primary || "").toUpperCase();
  const transferHit =
    memo.includes("transfer") ||
    memo.includes("xfer") ||
    memo.includes("internal transfer") ||
    memo.includes("online transfer") ||
    memo.includes("bank transfer") ||
    memo.includes("ach transfer") ||
    pfcPrimary.startsWith("TRANSFER") ||
    primary.startsWith("TRANSFER");
  const ccHit =
    memo.includes("credit card payment") ||
    memo.includes("card payment") ||
    ((memo.includes("payment") || memo.includes("card") || memo.includes("credit")) && memo.includes("thank you")) ||
    memo.includes("autopay") ||
    memo.includes("auto pay") ||
    memo.includes("online payment") ||
    memo.includes("automatic payment");
  const refundHit =
    memo.includes("refund") ||
    memo.includes("chargeback") ||
    memo.includes("reversal") ||
    memo.includes("credit reversal") ||
    memo.includes("returned");
  const payrollHit =
    memo.includes("payroll") ||
    memo.includes("direct deposit") ||
    memo.includes("salary") ||
    memo.includes("wages") ||
    memo.includes("transtech");
  const p2pHit =
    memo.includes("zelle") ||
    memo.includes("venmo") ||
    memo.includes("cash app") ||
    memo.includes("cashapp") ||
    memo.includes("payment id");
  const ownerHit =
    memo.includes("owner draw") ||
    memo.includes("owner distribution") ||
    memo.includes("owner contribution") ||
    memo.includes("capital contribution") ||
    memo.includes("transfer to personal") ||
    memo.includes("to personal") ||
    memo.includes("to myself") ||
    memo.includes("venmo cashout") ||
    memo.includes("paypal transfer");
  return transferHit || ccHit || refundHit || ownerHit || payrollHit || p2pHit;
}

function authorityForActor(actor = null) {
  const type = String(actor?.role || actor?.type || actor?.actorType || actor || "").toLowerCase();
  if (type.includes("bookkeeper")) return "bookkeeper_confirmed";
  if (type.includes("admin")) return "admin_confirmed";
  return "user_confirmed";
}

export async function learnVendorRuleFromTransaction({
  businessId,
  bankTxn,
  finalAccountId,
  finalAccountName,
  taxonomyType,
  options = {},
  db = null,
}) {
  if (!db) {
    const { supabase } = await import("../supabaseAdmin.js");
    db = supabase;
  }
  if (!businessId || !bankTxn || !finalAccountId) return { ok: true, skipped: true, reason: "missing_inputs" };
  if (options?.onlyThisTransaction === true || options?.learnReusableRule === false) {
    return { ok: true, skipped: true, reason: "one_time_decision" };
  }
  if (taxonomyType && LANDMINE_TYPES.has(taxonomyType)) return { ok: true, skipped: true, reason: "taxonomy_landmine" };
  if (looksLikeTaxonomyLandmineMemo(bankTxn)) return { ok: true, skipped: true, reason: "memo_landmine" };
  const opts = options || {};
  const matchConditionsValidation = validateVendorRuleMatchConditions(opts.matchConditions ?? opts.match_conditions ?? null);
  if (!matchConditionsValidation.ok) {
    return { ok: false, error: matchConditionsValidation.reason || "invalid_match_conditions" };
  }

  const direction = canonicalTxnDirection(bankTxn);
  if (direction === "UNKNOWN") return { ok: true, skipped: true, reason: "unknown_direction" };
  if (direction === "INFLOW" && (bankTxn.qbo_entity_type || "").toLowerCase() !== "customer") {
    return { ok: true, skipped: true, reason: "inflow_not_customer" };
  }
  const hasVendorSignal =
    bankTxn.counterparty_name || bankTxn.merchant_name || bankTxn.qbo_entity_id || bankTxn.merchant_entity_id;
  if (opts.learnedFrom === "check" && !hasVendorSignal) {
    return { ok: true, skipped: true, reason: "no_vendor_signal_for_check" };
  }

  const identity = buildAuthorizedMerchantRuleIdentity(bankTxn);
  if (!identity) return { ok: true, skipped: true, reason: "identity_too_weak" };
  const merchantEntityId = bankTxn.merchant_entity_id || bankTxn.merchant_id || null;
  const normalizedMerchant = normalizeMerchantIdentity(bankTxn.merchant_name || bankTxn.counterparty_name || bankTxn.name || "");
  const prefix = identity.match_value;
  if (opts.learnedFrom === "universal_hint" && !merchantEntityId) {
    if (!prefix || prefix.length < 10) {
      return { ok: true, skipped: true, reason: "universal_hint_identity_too_weak" };
    }
  }
  const counterpartyName = bankTxn.counterparty_name || bankTxn.merchant_name || bankTxn.name || "Unknown";
  const qboEntityType = bankTxn.qbo_entity_type || null;
  const qboEntityId = bankTxn.qbo_entity_id || null;
  const basePayload = {
    business_id: businessId,
    counterparty_name: counterpartyName,
    qbo_entity_type: bankTxn.qbo_entity_type || null,
    qbo_entity_id: bankTxn.qbo_entity_id || null,
    default_qbo_account_id: finalAccountId,
    default_qbo_account_name: finalAccountName,
    direction_hint: direction,
    last_used_at: new Date().toISOString(),
    rule_kind: "category_default",
    source: BUSINESS_MERCHANT_RULE_SOURCE,
    match_conditions: matchConditionsValidation.normalized,
  };

  const buildNotes = (existingNotes = null) => {
    const existing = parseRuleNotes(existingNotes);
    return stringifyRuleNotes({
      ...existing,
      source_type: BUSINESS_MERCHANT_RULE_SOURCE,
      authority: opts.authority || authorityForActor(opts.actor),
      source_transaction_id: bankTxn.id || bankTxn.transaction_id || bankTxn.plaid_transaction_id || null,
      actor_id: opts.actor?.id || opts.actor?.userId || opts.actorId || null,
      actor_type: opts.actor?.role || opts.actor?.type || opts.actorType || null,
      selected_qbo_account_id: finalAccountId,
      selected_qbo_account_name: finalAccountName || null,
      normalized_merchant: identity.normalized_merchant || normalizedMerchant.normalized || null,
      normalized_descriptor: identity.normalized_descriptor || null,
      normalized_fingerprint: identity.match_value,
      match_specificity: identity.match_specificity,
      normalization_version: identity.normalization_version || NORMALIZATION_VERSION,
      rule_version: BUSINESS_MERCHANT_RULE_VERSION,
      state: "active",
      superseded_at: null,
      learned_from: opts.learnedFrom || existing.learned_from || "manual_decision",
      created_at: existing.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  };

  let match_type = identity.match_type;
  let match_value = identity.match_value;
  if (!merchantEntityId && opts.allowQboEntityFallback && qboEntityType && qboEntityId) {
    const { data: qboRules, error: qboErr } = await db
      .from("vendor_rules")
      .select("id,match_type,match_value,usage_count,notes,counterparty_confidence,confidence")
      .eq("business_id", businessId)
      .eq("qbo_entity_type", qboEntityType)
      .eq("qbo_entity_id", qboEntityId)
      .eq("rule_kind", "category_default")
      .order("usage_count", { ascending: false })
      .order("last_used_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(5);
    if (qboErr) return { ok: false, error: qboErr?.message || "qbo_entity_select_failed" };
    const pref = (mt) => {
      if (mt === "merchant_entity_id") return 0;
      if (mt === "memo_prefix") return 1;
      return 2;
    };
    const candidate = (qboRules || [])
      .sort((a, b) => {
        const pa = pref(a.match_type);
        const pb = pref(b.match_type);
        if (pa !== pb) return pa - pb;
        return (b.usage_count || 0) - (a.usage_count || 0);
      })[0];
    if (candidate?.id) {
      const usage_count = (candidate.usage_count || 0) + 1;
      const confidence = candidate.confidence === "high" ? "high" : "medium";
      const payload = {
        ...basePayload,
        usage_count,
        confidence,
        counterparty_confidence: candidate.counterparty_confidence || "medium",
        notes: buildNotes(candidate.notes || null),
        rule_kind: "category_default",
      };
      const { error: updErr, data: updData } = await db
        .from("vendor_rules")
        .update(payload)
        .eq("id", candidate.id)
        .select("id,match_type,match_value")
        .maybeSingle();
      if (updErr) return { ok: false, error: updErr?.message || "qbo_entity_update_failed" };
      return { ok: true, rule: updData || { id: candidate.id, match_type: candidate.match_type, match_value: candidate.match_value } };
    }
  }
  if (!match_type || !match_value) {
    return { ok: true, skipped: true, reason: "no_identity" };
  }

  const { data: existingRows, error: selErr } = await db
    .from("vendor_rules")
    .select("id,usage_count,notes,counterparty_confidence,confidence,default_qbo_account_id,default_qbo_account_name,rule_kind,source,direction_hint,match_conditions,updated_at")
    .eq("business_id", businessId)
    .eq("match_type", match_type)
    .eq("match_value", match_value)
    .order("rule_kind", { ascending: true })
    .order("updated_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(5);
  if (selErr) {
    return { ok: false, error: selErr?.message || "select_failed" };
  }
  const compatibleRows = (existingRows || []).filter((row) => {
    const rowDirection = String(row.direction_hint || direction || "").toUpperCase();
    const directionCompatible = !rowDirection || rowDirection === "UNKNOWN" || rowDirection === direction;
    const accountCompatible =
      !row.default_qbo_account_id || String(row.default_qbo_account_id) === String(finalAccountId);
    const existingConditions = validateVendorRuleMatchConditions(row.match_conditions);
    const conditionsCompatible =
      existingConditions.ok &&
      JSON.stringify(existingConditions.normalized) === JSON.stringify(matchConditionsValidation.normalized);
    return directionCompatible && accountCompatible && conditionsCompatible;
  });
  const duplicateCategoryDefaults = compatibleRows.filter((row) => row.rule_kind === "category_default");
  if (duplicateCategoryDefaults.length > 1) {
    return { ok: false, error: "duplicate_compatible_vendor_rules_require_review" };
  }
  const incompatibleCategoryDefault = (existingRows || []).find((row) =>
    row.rule_kind === "category_default" &&
    row.default_qbo_account_id &&
    String(row.default_qbo_account_id) !== String(finalAccountId)
  );
  if (incompatibleCategoryDefault) {
    return { ok: false, error: "incompatible_existing_vendor_rule_requires_correction" };
  }
  const existing = duplicateCategoryDefaults[0] || compatibleRows.find((row) => row.rule_kind === "identity") || compatibleRows[0] || null;
  const usage_count = (existing?.usage_count || 0) + 1;
  const counterparty_confidence = existing?.counterparty_confidence || (merchantEntityId ? "high" : "medium");
  const inferredConfidence = merchantEntityId || identity.match_specificity !== "broad_fuzzy_alias" ? "high" : "medium";
  const confidence = existing?.confidence === "high" ? "high" : inferredConfidence;

  if (existing?.id) {
    const existingNotes = parseRuleNotes(existing.notes || null);
    const payload = {
      ...basePayload,
      usage_count,
      counterparty_confidence,
      confidence,
      notes: buildNotes(existing?.notes || null),
      rule_kind: "category_default",
    };
    if (existing.default_qbo_account_id && String(existing.default_qbo_account_id) !== String(finalAccountId)) {
      payload.notes = stringifyRuleNotes({
        ...parseRuleNotes(payload.notes),
        previous_rule: {
          default_qbo_account_id: existing.default_qbo_account_id,
          default_qbo_account_name: existing.default_qbo_account_name || null,
          confidence: existing.confidence || null,
          notes: existingNotes,
          superseded_at: new Date().toISOString(),
        },
      });
    }
    const { error: updErr, data: updData } = await db
      .from("vendor_rules")
      .update(payload)
      .eq("id", existing.id)
      .select("id,match_type,match_value")
      .maybeSingle();
    if (updErr) return { ok: false, error: updErr?.message || "update_failed" };
    return { ok: true, rule: updData || { id: existing.id, match_type, match_value } };
  }

  const insertPayload = {
    ...basePayload,
    match_type,
    match_value,
    usage_count,
    counterparty_confidence,
    confidence,
    notes: buildNotes(null),
  };
  const { data: insData, error: insErr } = await db
    .from("vendor_rules")
    .insert(insertPayload)
    .select("id,match_type,match_value")
    .maybeSingle();
  if (insErr) return { ok: false, error: insErr?.message || "insert_failed" };
  return { ok: true, rule: insData };
}
