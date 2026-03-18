import { supabase } from "../supabaseAdmin.js";
import { getQboEntityCache, normalizeCandidate, tokenOverlapScore } from "./qboEntityCache.js";

const GENERIC_STOPWORDS = ["payment", "transfer", "online", "thank", "fee", "interest", "check"];
const NON_COUNTERPARTY_PATTERNS = [
  /(CREDIT\s*C(?:ARD)?|CARD)\s*PAYMENT/i,
  /AUTOMATIC PAYMENT/i,
  /ONLINE PAYMENT/i,
  /PAYMENT\s+THANK YOU/i,
  /\bTHANK YOU\b/i,
  /\bAUTOPAY\b/i,
  /\bEPAY\b/i,
  /\bACH PAYMENT\b/i,
  /\bINTERNAL TRANSFER\b/i,
  /\bTRANSFER (TO|FROM)\b/i,
  /\bFROM SAVINGS\b/i,
  /\bTO CHECKING\b/i,
  /\bVENMO CASHOUT\b/i,
  /\bZELLE\b/i,
  /\bTRANSFER\b/i,
  /\bINTEREST\b/i,
  /\bBANK FEE\b/i,
  /\bMONTHLY FEE\b/i,
  /\bSERVICE FEE\b/i,
  /\bLOAN PAYMENT\b/i,
  /\bPRINCIPAL\b/i,
  /\bMORTGAGE\b/i,
];
const STRONG_NON_COUNTERPARTY_PATTERNS = [
  /CREDIT\s*C(?:ARD)?\s*PAYMENT/i,
  /PAYMENT\s+THANK YOU/i,
  /\bAUTOPAY\b/i,
  /\bINTERNAL TRANSFER\b/i,
  /\bACH PAYMENT\b/i,
  /\bLOAN PAYMENT\b/i,
];
const IDENTITY_RULES_NAME_ONLY = true;

function devLog(tag, payload) {
  if (process.env.NODE_ENV === "production") return;
  console.info("[payeeResolver]", tag, payload);
}

function nowIso() {
  return new Date().toISOString();
}

function cleanMemo(raw = "") {
  return (raw || "")
    .replace(/^(POS|DEBIT|CREDIT|ACH|ACH DEBIT|ACH CREDIT|SQ \*|VENMO PAYMENT|PP\*|PURCHASE)\s+/i, "")
    .replace(/\d{4,}/g, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMemoCandidate(name = "") {
  const cleaned = cleanMemo(name);
  if (!cleaned) return { candidate: null, cleanedMemo: "" };
  const tokens = cleaned.split(" ").filter(Boolean);
  if (!tokens.length) return { candidate: null, cleanedMemo: cleaned };
  const firstTwo = tokens.slice(0, 2).join(" ");
  const single = tokens[0];
  const candidate = firstTwo.length >= 4 ? firstTwo : single;
  const generic = GENERIC_STOPWORDS.some((w) =>
    (candidate || "").toLowerCase().includes(w)
  );
  if (generic) return { candidate: null, cleanedMemo: cleaned };
  return { candidate, cleanedMemo: cleaned };
}

function detectNonCounterparty(txn = {}) {
  const merchant = (txn.merchant_name || "").trim();
  const memo = `${txn.name || ""} ${merchant}`.trim();
  if (!memo) return null;
  const hasStrongMerchant = merchant && merchant.length > 3 && !/payment|transfer|fee|interest/i.test(merchant);
  if (hasStrongMerchant) {
    const strongHit = STRONG_NON_COUNTERPARTY_PATTERNS.some((re) => re.test(memo));
    if (!strongHit) return null;
  }
  const isMatch = NON_COUNTERPARTY_PATTERNS.some((re) => re.test(memo));
  if (!isMatch) return null;
  devLog("non_counterparty_hit", {
    txn_id: txn.id,
    plaid_transaction_id: txn.plaid_transaction_id,
    merchant_name: txn.merchant_name,
    name: txn.name,
    matched: "pattern",
  });
  return {
    isNonCounterparty: true,
    counterpartyName: null,
    confidence: "high",
    source: "memo_parse",
  };
}

async function fetchVendorRules(businessId) {
  const { data, error } = await supabase
    .from("vendor_rules")
    .select("*")
    .eq("business_id", businessId)
    .eq("rule_kind", "identity");
  if (error) {
    console.warn("[payeeResolver] vendor_rules fetch failed", error?.message || error);
    return [];
  }
  return data || [];
}

async function bumpRuleUsage(ruleId, currentCount = 0) {
  try {
    await supabase
      .from("vendor_rules")
      .update({ usage_count: (currentCount || 0) + 1, last_used_at: nowIso() })
      .eq("id", ruleId);
  } catch (err) {
    console.warn("[payeeResolver] bumpRuleUsage failed", err?.message || err);
  }
}

function matchRule(rules = [], txn = {}, cleanedMemo = "") {
  if (!rules.length) return null;
  const merchantEntityId = txn.merchant_entity_id || null;
  if (merchantEntityId) {
    const hit = rules.find(
      (r) =>
        r.match_type === "merchant_entity_id" &&
        String(r.match_value || "") === String(merchantEntityId)
    );
    if (hit) return hit;
  }
  if (cleanedMemo) {
    const memoPrefix = cleanedMemo.slice(0, 20).toLowerCase();
    const prefixHit = rules.find(
      (r) =>
        r.match_type === "memo_prefix" &&
        memoPrefix.startsWith(String(r.match_value || "").toLowerCase())
    );
    if (prefixHit) return prefixHit;
  }
  const regexRules = rules.filter((r) => r.match_type === "regex");
  for (const r of regexRules) {
    try {
      const re = new RegExp(r.match_value, "i");
      if (re.test(txn.name || "") || re.test(cleanedMemo || "")) return r;
    } catch {
      continue;
    }
  }
  return null;
}

async function upsertVendorRule({ businessId, match_type, match_value, counterparty_name, counterparty_confidence, qbo_entity_type = null, qbo_entity_id = null, source = "bizzi" }) {
  try {
    const { data: existing, error: selErr } = await supabase
      .from("vendor_rules")
      .select("id,rule_kind,counterparty_name,counterparty_confidence,qbo_entity_type,qbo_entity_id,usage_count,last_used_at")
      .eq("business_id", businessId)
      .eq("match_type", match_type)
      .eq("match_value", match_value)
      .maybeSingle();
    if (selErr) throw selErr;
    const row = existing || null;
    if (row && row.rule_kind === "category_default") {
      devLog("identity_rule_skip_conflict", { match_type, match_value, existing_kind: "category_default" });
      return { skipped: true, reason: "conflicts_with_category_default" };
    }

    const nextQboEntityType =
      IDENTITY_RULES_NAME_ONLY && row?.rule_kind === "identity"
        ? row.qbo_entity_type || null
        : qbo_entity_type || null;
    const nextQboEntityId =
      IDENTITY_RULES_NAME_ONLY && row?.rule_kind === "identity"
        ? row.qbo_entity_id || null
        : qbo_entity_id || null;

    await supabase
      .from("vendor_rules")
      .upsert(
        {
          business_id: businessId,
          match_type,
          match_value,
          counterparty_name,
          counterparty_confidence,
          qbo_entity_type: nextQboEntityType,
          qbo_entity_id: nextQboEntityId,
          source,
          rule_kind: "identity",
          updated_at: nowIso(),
        },
        { onConflict: "business_id,match_type,match_value" }
      );
    devLog("identity_rule_upserted", {
      match_type,
      match_value,
      counterparty_name,
      name_only: IDENTITY_RULES_NAME_ONLY,
    });
    return { ok: true };
  } catch (err) {
    console.warn("[payeeResolver] vendor_rule upsert failed", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

function chooseDirectionList(direction, entities) {
  const dir = (direction || "").toUpperCase();
  if (dir === "OUTFLOW") return entities.vendors || [];
  if (dir === "INFLOW") return entities.customers || [];
  return [...(entities.vendors || []), ...(entities.customers || [])];
}

function matchQboEntity(candidateName, direction, entities) {
  if (!candidateName) return null;
  const candidateNorm = normalizeCandidate(candidateName);
  if (!candidateNorm) return null;
  const candTokens = candidateNorm.split(" ").filter(Boolean);
  const pool = chooseDirectionList(direction, entities);
  let best = null;
  let bestScore = 0;

  for (const ent of pool) {
    const exact = ent.normalized === candidateNorm;
    const contains =
      ent.normalized.includes(candidateNorm) || candidateNorm.includes(ent.normalized);
    const overlap = tokenOverlapScore(candTokens, ent.tokens || []);
    const score = exact ? 1 : contains ? 0.85 : overlap;
    if (score > bestScore) {
      bestScore = score;
      best = ent;
    }
  }

  const dir = (direction || "").toUpperCase();
  const isVendor = dir === "OUTFLOW" || best?.entityType === "vendor";
  const isCustomer = dir === "INFLOW" || best?.entityType === "customer";

  if (bestScore >= 0.92 || (bestScore >= 0.85 && (isVendor || isCustomer))) {
    return {
      score: bestScore,
      qbo_entity_type: isVendor ? "vendor" : isCustomer ? "customer" : null,
      qbo_entity_id: best?.id || null,
      counterparty_name: best?.displayName || candidateName,
      confidence: bestScore >= 0.92 ? "high" : "medium",
      source: "qbo_match",
    };
  }
  return null;
}

function shouldCreateRule({ candidateName, direction }) {
  if (!candidateName || candidateName.length < 3) return false;
  const lower = candidateName.toLowerCase();
  if (!direction || direction === "UNKNOWN") return false;
  return !GENERIC_STOPWORDS.some((w) => lower.includes(w));
}

export async function resolvePayee({ businessId, txn }) {
  if (!businessId || !txn) return null;

  const nonCounterparty = detectNonCounterparty(txn);
  if (nonCounterparty) return nonCounterparty;

  let candidateName = null;
  let source = null;
  let confidence = null;

  if (txn.merchant_name) {
    candidateName = txn.merchant_name.trim();
    source = "plaid_merchant";
    confidence = "high";
  } else if (Array.isArray(txn.counterparties) && txn.counterparties.length) {
    const cp = txn.counterparties[0];
    if (cp?.name) {
      candidateName = cp.name.trim();
      source = "plaid_counterparty";
      confidence = "medium";
    }
  }

  const memoParsed = parseMemoCandidate(txn.name || "");
  const cleanedMemo = memoParsed.cleanedMemo;
  if (!candidateName && memoParsed.candidate) {
    candidateName = memoParsed.candidate;
    source = "memo_parse";
    confidence = "low";
  }
  if (!candidateName && !memoParsed.candidate) {
    devLog("no_payee_signal", { txn_id: txn.id, plaid_transaction_id: txn.plaid_transaction_id });
    return { counterpartyName: null, confidence: "low", source: "memo_parse" };
  }

  // Vendor rule hit
  const rules = await fetchVendorRules(businessId);
  const hit = matchRule(rules, txn, cleanedMemo);
  if (hit) {
    await bumpRuleUsage(hit.id, hit.usage_count);
    devLog("identity_rule_hit", {
      match_type: hit.match_type,
      match_value: hit.match_value,
      counterparty: hit.counterparty_name,
      qbo_entity_id: hit.qbo_entity_id,
    });
    return {
      counterpartyName: hit.counterparty_name,
      confidence: hit.counterparty_confidence || "medium",
      source: "rule",
      qbo_entity_type: hit.qbo_entity_type || null,
      qbo_entity_id: hit.qbo_entity_id || null,
    };
  }

  // QBO match
  const entities = await getQboEntityCache(businessId);
  const qboMatch = matchQboEntity(candidateName, txn.direction, entities);
  if (qboMatch) {
    devLog("qbo_match_hit", {
      candidateName,
      score: qboMatch.score,
      qbo_entity_type: qboMatch.qbo_entity_type,
      qbo_entity_id: qboMatch.qbo_entity_id,
    });
    return {
      counterpartyName: qboMatch.counterparty_name,
      confidence: qboMatch.confidence,
      source: qboMatch.source,
      qbo_entity_type: qboMatch.qbo_entity_type,
      qbo_entity_id: qboMatch.qbo_entity_id,
    };
  }

  // Local rule creation (no QBO match)
  if (shouldCreateRule({ candidateName, direction: txn.direction })) {
    const confidenceLevel = source === "plaid_merchant" ? "high" : "medium";
    if (txn.merchant_entity_id) {
      await upsertVendorRule({
        businessId,
        match_type: "merchant_entity_id",
        match_value: txn.merchant_entity_id,
        counterparty_name: candidateName,
        counterparty_confidence: confidenceLevel,
      });
      devLog("identity_rule_created", {
        match_type: "merchant_entity_id",
        match_value: txn.merchant_entity_id,
        counterparty_name: candidateName,
      });
    } else if (cleanedMemo) {
      const prefix = cleanedMemo.slice(0, 20);
      await upsertVendorRule({
        businessId,
        match_type: "memo_prefix",
        match_value: prefix,
        counterparty_name: candidateName,
        counterparty_confidence: confidenceLevel,
      });
      devLog("identity_rule_created", {
        match_type: "memo_prefix",
        match_value: prefix,
        counterparty_name: candidateName,
      });
    }
  }

  devLog("payee_fallback", {
    counterpartyName: candidateName,
    source,
    memoCandidate: memoParsed?.candidate || null,
  });
  return {
    counterpartyName: candidateName,
    confidence: confidence || "low",
    source: source || "memo_parse",
  };
}
