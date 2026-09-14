const NORMALIZATION_VERSION = "merchant_normalization_v1";

const PROCESSOR_PREFIXES = [
  { pattern: /^(?:apl\s*pay|apple\s*pay)\s+/i, token: "apple_pay_prefix" },
  { pattern: /^(?:sq|square)\s*\*?\s+/i, token: "square_prefix" },
  { pattern: /^tst\s*\*?\s+/i, token: "toast_prefix" },
  { pattern: /^(?:pp|paypal)\s*\*?\s+/i, token: "paypal_prefix" },
  { pattern: /^(?:clover|stripe|cash\s*app|venmo)\s*\*?\s+/i, token: "processor_prefix" },
  { pattern: /^(?:pos|debit|credit|purchase|ach(?:\s+debit|\s+credit)?)\s+/i, token: "bank_network_prefix" },
];

const PHRASE_RULES = [
  { pattern: /\bpark\s*mobile(?:\s+cdot\s+pay)?\b/i, replace: "parkmobile", token: "parkmobile_variant" },
  { pattern: /\bctlp\s*\*?\s*short\s+stop(?:\s+vend(?:ing)?)?\b/i, replace: "short stop vending", token: "short_stop_processor" },
  { pattern: /\bapple\.?com\/?bill\b/i, replace: "apple", token: "apple_bill_suffix" },
  { pattern: /\bresume\s*\.?\s*io\b/i, replace: "resume io", token: "resume_io_variant" },
  { pattern: /\btran\s+fee\s+intuit\b/i, replace: "intuit transaction fee", token: "intuit_fee_variant" },
  { pattern: /\bdeposit\s+intuit\b/i, replace: "intuit deposit", token: "intuit_deposit_variant" },
  { pattern: /\bmicro\s*mart\b/i, replace: "micro mart", token: "micro_mart_variant" },
  { pattern: /\baplpay\s+/i, replace: "", token: "apple_pay_compact_prefix" },
];

const BUSINESS_SUFFIX_RE = /\b(?:llc|l\s*l\s*c|inc|incorporated|corp|corporation|co|company|ltd|limited)\b/g;
const BANK_NOISE_RE = /\b(?:ach|corp|debit|credit|optimi(?:st)?|payment|pmt|web|epay|online|card|crd|thank\s+you)\b/g;
const SAFE_LOCATION_SUFFIX_RE = /\b(?:al|ak|az|ar|ca|co|ct|dc|de|fl|ga|hi|ia|id|il|in|ks|ky|la|ma|md|me|mi|mn|mo|ms|mt|nc|nd|ne|nh|nj|nm|nv|ny|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|va|vt|wa|wi|wv|wy)\b$/;

function compactWhitespace(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function applyTrackedReplace(value, { pattern, replace, token }, evidence) {
  if (!pattern.test(value)) return value;
  evidence.removed_tokens.push(token);
  return value.replace(pattern, replace ?? "");
}

export function normalizeMerchantIdentity(input = "") {
  const raw = String(input || "");
  const evidence = {
    version: NORMALIZATION_VERSION,
    raw,
    removed_tokens: [],
    preserved_tokens: [],
  };
  let normalized = raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  for (const rule of PROCESSOR_PREFIXES) {
    normalized = applyTrackedReplace(normalized, rule, evidence);
  }
  for (const rule of PHRASE_RULES) {
    normalized = applyTrackedReplace(normalized, rule, evidence);
  }

  normalized = normalized.replace(/[#*./,;:()[\]{}'"`]+/g, " ");
  normalized = normalized.replace(/&/g, " and ");
  normalized = normalized.replace(/\b(?:x{2,}|\*{2,})\d+\b/g, " ");
  normalized = normalized.replace(/\b\d{4,}[a-z]*\b/g, () => {
    evidence.removed_tokens.push("numeric_terminal_or_store_id");
    return " ";
  });
  normalized = normalized.replace(BUSINESS_SUFFIX_RE, () => {
    evidence.removed_tokens.push("business_suffix");
    return " ";
  });
  normalized = normalized.replace(BANK_NOISE_RE, (match) => {
    evidence.removed_tokens.push(`bank_noise:${match.trim()}`);
    return " ";
  });
  normalized = normalized.replace(/\bvend(?:in|ing)?\b/g, () => {
    evidence.removed_tokens.push("vending_descriptor");
    return " ";
  });
  normalized = compactWhitespace(normalized.replace(/[^a-z0-9\s-]+/g, " "));
  normalized = normalized.replace(SAFE_LOCATION_SUFFIX_RE, () => {
    evidence.removed_tokens.push("state_suffix");
    return "";
  });
  normalized = compactWhitespace(normalized);

  if (normalized === "park mobile" || normalized === "parkmobile cdot pay") normalized = "parkmobile";
  if (/\bshort\s+stop\b/i.test(raw) && /\bvend/i.test(raw)) normalized = "short stop vending";
  if (normalized === "resume io") normalized = "resume.io";

  evidence.normalized = normalized;
  evidence.removed_tokens = [...new Set(evidence.removed_tokens)];
  return {
    raw,
    normalized,
    normalization_version: NORMALIZATION_VERSION,
    evidence,
  };
}

export function normalizedMerchantKeys(transaction = {}) {
  const values = [
    transaction.merchant_name,
    transaction.counterparty_name,
    transaction.name,
    transaction.original_description,
    transaction.description,
    transaction.raw?.merchant_name,
    transaction.raw?.name,
    transaction.raw?.original_description,
    transaction.raw?.originalName,
  ].filter(Boolean);
  const keys = [];
  const evidence = [];
  for (const value of values) {
    const normalized = normalizeMerchantIdentity(value);
    if (normalized.normalized && normalized.normalized.length >= 3) {
      keys.push(normalized.normalized);
      evidence.push(normalized.evidence);
    }
  }
  return {
    keys: [...new Set(keys)],
    evidence,
    normalization_version: NORMALIZATION_VERSION,
  };
}

export { NORMALIZATION_VERSION };
