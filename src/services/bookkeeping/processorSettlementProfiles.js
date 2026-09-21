const PROFILE_DEFINITIONS = [
  { key: "quickbooks_payments", name: "QuickBooks Payments", aliases: ["intuit", "quickbooks payments", "qb payments"], fee: [/\btran(?:saction)? fee intuit\b/i, /\bquickbooks payments? fee\b/i], payout: [/\bdeposit intuit\b/i, /\bquickbooks payments? deposit\b/i], windowDays: 4, separateFees: true },
  { key: "stripe", name: "Stripe", aliases: ["stripe"], fee: [/\bstripe\b.*\bfee\b/i], payout: [/\bstripe\b.*\b(?:payout|deposit)\b/i], windowDays: 4, nettedFees: true },
  { key: "square", name: "Square", aliases: ["square"], fee: [/\bsquare\b.*\bfee\b/i], payout: [/\bsquare\b.*\b(?:payout|deposit|settlement)\b/i], windowDays: 4, nettedFees: true },
  { key: "paypal", name: "PayPal", aliases: ["paypal"], fee: [/\bpaypal\b.*\bfee\b/i], payout: [/\bpaypal\b.*\b(?:transfer|payout|deposit)\b/i], windowDays: 5, nettedFees: true },
  { key: "clover", name: "Clover", aliases: ["clover"], fee: [/\bclover\b.*\bfee\b/i], payout: [/\bclover\b.*\b(?:deposit|settlement)\b/i], windowDays: 4, nettedFees: true },
  ...["jobber", "housecall pro", "joist", "servicetitan", "buildertrend", "fieldpulse", "workiz"].map((name) => ({
    key: name.replace(/\s+/g, "_"), name, aliases: [name],
    fee: [new RegExp(`\\b${name.replace(/\s+/g, "\\s*")}\\b.*\\b(?:processing|merchant|transaction) fee\\b`, "i")],
    payout: [new RegExp(`\\b${name.replace(/\s+/g, "\\s*")}\\b.*\\b(?:payout|deposit|settlement)\\b`, "i")],
    windowDays: 5,
  })),
];

export const PROCESSOR_SETTLEMENT_PROFILES = Object.freeze(PROFILE_DEFINITIONS);

function evidenceText(transaction = {}) {
  return [transaction.name, transaction.description, transaction.bank_memo, transaction.memo, transaction.merchant_name, transaction.original_description, transaction.counterparty_name]
    .concat((transaction.counterparties || []).map((item) => item?.name || item?.legal_name))
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function directionOf(transaction = {}) {
  const direction = String(transaction.direction || "").toUpperCase();
  if (direction === "INFLOW" || direction === "OUTFLOW") return direction;
  return Number(transaction.signed_amount ?? transaction.amount) < 0 ? "OUTFLOW" : "INFLOW";
}

export function detectProcessorSettlementActivity(transaction = {}, tenantAliases = []) {
  const text = evidenceText(transaction);
  const direction = directionOf(transaction);
  for (const profile of PROCESSOR_SETTLEMENT_PROFILES) {
    const aliasHit = profile.aliases.some((alias) => text.toLowerCase().includes(alias.toLowerCase()));
    const feeHit = direction === "OUTFLOW" && profile.fee.some((pattern) => pattern.test(text));
    const payoutHit = direction === "INFLOW" && profile.payout.some((pattern) => pattern.test(text));
    if (feeHit || payoutHit) return { profile, kind: feeHit ? "fee" : "payout", confidence: "high", text };
    if (aliasHit) return { profile, kind: "platform_charge", confidence: "low", text };
  }
  const learned = tenantAliases.find((alias) => alias?.pattern && new RegExp(alias.pattern, "i").test(text));
  if (learned?.activity_kind && ["fee", "payout"].includes(learned.activity_kind)) {
    return { profile: { key: learned.processor_key, name: learned.processor_name, windowDays: learned.window_days || 5 }, kind: learned.activity_kind, confidence: "tenant_learned", text };
  }
  return null;
}

export function validateSettlementArithmetic({ grossMinor = 0, feeMinor = 0, adjustmentMinor = 0, netMinor = 0 } = {}) {
  const expectedNetMinor = Number(grossMinor) - Math.abs(Number(feeMinor)) + Number(adjustmentMinor);
  return { valid: Number.isInteger(expectedNetMinor) && expectedNetMinor === Number(netMinor), expectedNetMinor, differenceMinor: Number(netMinor) - expectedNetMinor };
}

export function isCompatibleProcessingFeeAccount(accountName = "") {
  return /\b(?:payment processing|merchant processing|merchant fees?|processing fees?)\b/i.test(accountName) || /\bbank (?:charges|fees)\b/i.test(accountName);
}
