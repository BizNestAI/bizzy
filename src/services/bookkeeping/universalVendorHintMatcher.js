import { UNIVERSAL_VENDOR_HINTS, normalizeVendorString } from "./universalVendorHints.js";

const devLog = (tag, payload) => {
  if (process.env.NODE_ENV !== "production") {
    console.info("[universalVendorHint]", tag, payload);
  }
};

const hintsExact = [];
const hintsStartsWith = [];
const hintsContains = [];
const hintsRegex = [];
const regexCompileErrors = new Set();
const GAS_STATION_SMALL_MEAL_LIMIT = Number(process.env.BOOKS_GAS_STATION_SMALL_MEAL_LIMIT || 20);

function indexHints() {
  UNIVERSAL_VENDOR_HINTS.forEach((hint) => {
    const m = hint?.match;
    if (!m?.type || !m?.value) return;
    const value = (m.value || "").toString();
    switch (m.type) {
      case "exact":
        hintsExact.push({ ...hint, match: { ...m, value } });
        break;
      case "startsWith":
        hintsStartsWith.push({ ...hint, match: { ...m, value } });
        break;
      case "contains":
        hintsContains.push({ ...hint, match: { ...m, value } });
        break;
      case "regex": {
        try {
          const compiled = new RegExp(value, "i");
          hintsRegex.push({ ...hint, match: { ...m, value }, _re: compiled });
        } catch (e) {
          if (!regexCompileErrors.has(hint.key)) {
            regexCompileErrors.add(hint.key);
            devLog("regex_compile_error", { key: hint.key, value });
          }
        }
        break;
      }
      default:
        break;
    }
  });
  hintsStartsWith.sort((a, b) => (b.match.value.length || 0) - (a.match.value.length || 0));
  hintsContains.sort((a, b) => (b.match.value.length || 0) - (a.match.value.length || 0));
}

indexHints();

function buildCandidateStrings(bankTxn = {}) {
  const parts = [
    bankTxn.counterparty_name,
    bankTxn.merchant_name,
    bankTxn.name,
    bankTxn?.raw?.name,
  ]
    .filter(Boolean)
    .map((p) => normalizeVendorString(p));
  return [...new Set(parts.filter((p) => p))];
}

function matchHint(candidates) {
  for (const candidate of candidates) {
    for (const hint of hintsExact) {
      if (candidate === hint.match.value) return { hint, candidate };
    }
    for (const hint of hintsStartsWith) {
      if (candidate.startsWith(hint.match.value)) return { hint, candidate };
    }
  }

  for (const candidate of candidates) {
    for (const hint of hintsContains) {
      if (candidate.includes(hint.match.value)) return { hint, candidate };
    }
  }

  for (const candidate of candidates) {
    for (const hint of hintsRegex) {
      if (hint._re?.test(candidate)) return { hint, candidate };
    }
  }
  return null;
}

function isFuelHint(hint) {
  return hint?.primary_intent === "fuel" || hint?.intents?.includes("fuel");
}

function isAmazonHint(hint) {
  return hint?.canonical === "Amazon" || hint?.canonical === "Amazon Marketplace";
}

function absoluteTransactionAmount(bankTxn = {}) {
  const rawAmount = bankTxn.amount ?? bankTxn.signed_amount ?? bankTxn.raw?.amount;
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount)) return 0;
  return Math.abs(amount);
}

function applyAmountSensitiveHintAdjustments({ hint, bankTxn }) {
  if (isAmazonHint(hint)) {
    const amount = absoluteTransactionAmount(bankTxn);
    const cents = Math.round(amount * 100);
    if (cents === 800 || cents === 899) {
      return {
        ...hint,
        intents: ["software", "materials"],
        primary_intent: "software",
        confidence: "medium",
        notes: "Amazon charge matches common subscription pricing; review if it was a purchase.",
      };
    }
  }

  if (!isFuelHint(hint)) return hint;

  const amount = absoluteTransactionAmount(bankTxn);
  if (amount <= 0 || amount > GAS_STATION_SMALL_MEAL_LIMIT) return hint;

  return {
    ...hint,
    intents: ["meals", "fuel"],
    primary_intent: "meals",
    confidence: "medium",
    notes: "Small gas station purchase; likely snacks/food, review if it was fuel.",
  };
}

export function getUniversalVendorHintForTransaction({ bankTxn }) {
  const candidates = buildCandidateStrings(bankTxn || {});
  if (!candidates.length) return null;

  const matched = matchHint(candidates);
  if (!matched) return null;

  const { candidate } = matched;
  const hint = applyAmountSensitiveHintAdjustments({ hint: matched.hint, bankTxn });
  const result = {
    ok: true,
    source: "universal_hint",
    canonical_vendor: hint.canonical,
    matched_rule_key: hint.key,
    primary_intent: hint.primary_intent,
    intents: hint.intents,
    confidence: hint.confidence || "medium",
    note: hint.notes || null,
    matched_value: candidate,
    match_type: hint.match?.type || null,
    match_value: hint.match?.value || null,
  };

  devLog("matched", {
    candidate,
    key: hint.key,
    match_type: hint.match?.type,
    match_value: hint.match?.value,
    primary_intent: hint.primary_intent,
    confidence: hint.confidence,
  });

  return result;
}
