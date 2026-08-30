import { supabase } from "../supabaseAdmin.js";

const LANDMINE_TYPES = new Set(["transfer_internal", "cc_payment", "owner_draw", "owner_contribution", "refund", "payroll", "peer_to_peer_transfer"]);

export function normalizeText(str = "") {
  return String(str || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function buildMemoForLearning(tx = {}) {
  return normalizeText([tx.name, tx.merchant_name, tx.counterparty_name].filter(Boolean).join(" "));
}

export function cleanMemoForPrefix(memo = "") {
  return (memo || "")
    .replace(/^(POS|DEBIT|CREDIT|ACH|ACH DEBIT|ACH CREDIT|SQ \*|VENMO PAYMENT|PP\*|PURCHASE|PP \*|VENMO|PAYPAL)\s+/i, "")
    .replace(/\d{4,}/g, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function computeMemoPrefixForLearning(tx = {}, N = 20) {
  const memo = buildMemoForLearning(tx);
  const cleanedMemo = cleanMemoForPrefix(memo);
  const prefix = (cleanedMemo || "").slice(0, N);
  return { prefix };
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

export async function learnVendorRuleFromTransaction({ businessId, bankTxn, finalAccountId, finalAccountName, taxonomyType, options = {} }) {
  if (!businessId || !bankTxn || !finalAccountId) return { ok: true, skipped: true, reason: "missing_inputs" };
  if (taxonomyType && LANDMINE_TYPES.has(taxonomyType)) return { ok: true, skipped: true, reason: "taxonomy_landmine" };
  if (looksLikeTaxonomyLandmineMemo(bankTxn)) return { ok: true, skipped: true, reason: "memo_landmine" };
  const opts = options || {};

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

  const merchantEntityId = bankTxn.merchant_entity_id || null;
  const { prefix } = computeMemoPrefixForLearning(bankTxn, 20);
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
  };

  const appendLearnedFromNote = (notes) => {
    const from = opts.learnedFrom ? String(opts.learnedFrom) : null;
    if (!from) return notes || null;
    const marker = `learned_from: ${from}`;
    if (!notes) return marker;
    if (notes.includes(marker)) return notes;
    return `${notes} | ${marker}`;
  };

  let match_type = null;
  let match_value = null;
  if (merchantEntityId) {
    match_type = "merchant_entity_id";
    match_value = merchantEntityId;
  } else if (opts.allowQboEntityFallback && qboEntityType && qboEntityId) {
  const { data: qboRules, error: qboErr } = await supabase
    .from("vendor_rules")
    .select("id,match_type,match_value,usage_count,notes,counterparty_confidence,confidence")
    .eq("business_id", businessId)
    .eq("qbo_entity_type", qboEntityType)
    .eq("qbo_entity_id", qboEntityId)
    .eq("rule_kind", "category_default")
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
        notes: appendLearnedFromNote(candidate.notes || null),
        rule_kind: "category_default",
      };
      const { error: updErr, data: updData } = await supabase
        .from("vendor_rules")
        .update(payload)
        .eq("id", candidate.id)
        .select("id,match_type,match_value")
        .limit(1)
        .maybeSingle();
      if (updErr) return { ok: false, error: updErr?.message || "qbo_entity_update_failed" };
      return { ok: true, rule: updData || { id: candidate.id, match_type: candidate.match_type, match_value: candidate.match_value } };
    }
  }
  if (!match_type) {
    if (prefix) {
      if (prefix.length < 8) {
        return { ok: true, skipped: true, reason: "memo_prefix_too_short" };
      }
      match_type = "memo_prefix";
      match_value = prefix;
    } else {
      return { ok: true, skipped: true, reason: "no_identity" };
    }
  }

  const { data: existingRows, error: selErr } = await supabase
    .from("vendor_rules")
    .select("id,usage_count,notes,counterparty_confidence,confidence")
    .eq("business_id", businessId)
    .eq("match_type", match_type)
    .eq("match_value", match_value)
    .eq("rule_kind", "category_default")
    .limit(1);
  if (selErr) {
    return { ok: false, error: selErr?.message || "select_failed" };
  }
  const existing = existingRows?.[0] || null;
  const usage_count = (existing?.usage_count || 0) + 1;
  const counterparty_confidence = existing?.counterparty_confidence || (merchantEntityId ? "high" : "medium");
  const inferredConfidence = merchantEntityId ? "high" : "medium";
  const confidence = existing?.confidence === "high" ? "high" : inferredConfidence;

  if (existing?.id) {
    const payload = {
      ...basePayload,
      usage_count,
      counterparty_confidence,
      confidence,
      notes: appendLearnedFromNote(existing?.notes || null),
      rule_kind: "category_default",
    };
    const { error: updErr, data: updData } = await supabase
      .from("vendor_rules")
      .update(payload)
      .eq("id", existing.id)
      .select("id,match_type,match_value")
      .limit(1)
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
    notes: appendLearnedFromNote(null),
  };
  const { data: insData, error: insErr } = await supabase
    .from("vendor_rules")
    .insert(insertPayload)
    .select("id,match_type,match_value")
    .maybeSingle();
  if (insErr) return { ok: false, error: insErr?.message || "insert_failed" };
  return { ok: true, rule: insData };
}
