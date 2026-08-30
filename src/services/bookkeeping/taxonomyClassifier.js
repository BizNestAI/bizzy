export const TAXONOMY_TYPES = {
  TRANSFER_INTERNAL: "transfer_internal",
  CC_PAYMENT: "cc_payment",
  OWNER_DRAW: "owner_draw",
  OWNER_CONTRIBUTION: "owner_contribution",
  REFUND: "refund",
  PAYROLL: "payroll",
  PEER_TO_PEER_TRANSFER: "peer_to_peer_transfer",
};

export function normalizeText(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function getMemo(tx = {}) {
  const parts = [tx.name, tx.merchant_name, tx.counterparty_name].filter(Boolean);
  return normalizeText(parts.join(" "));
}

export function isOutflow(tx = {}) {
  const dir = (tx.direction || tx.Direction || "").toUpperCase();
  if (dir === "OUTFLOW") return true;
  if (dir === "INFLOW") return false;
  const amt = Number(tx.amount || 0);
  return Number.isFinite(amt) ? amt < 0 : false;
}

export function isInflow(tx = {}) {
  const dir = (tx.direction || tx.Direction || "").toUpperCase();
  if (dir === "INFLOW") return true;
  if (dir === "OUTFLOW") return false;
  const amt = Number(tx.amount || 0);
  return Number.isFinite(amt) ? amt > 0 : false;
}

export function looksLikeTransfer(tx = {}) {
  const ccHit = looksLikeCcPayment(tx);
  if (ccHit?.confidence === "high") return null;

  const primary = (tx.category_primary || "").toUpperCase();
  const pfcPrimary = (tx.personal_finance_category?.primary || "").toUpperCase();
  const memo = getMemo(tx);
  const hasTransferTokens =
    /\btransfer\b/.test(memo) ||
    /\bxfer\b/.test(memo) ||
    memo.includes("internal transfer") ||
    memo.includes("online transfer") ||
    memo.includes("bank transfer") ||
    memo.includes("ach transfer");
  const hasAccountDirection =
    /\b(to|from)\b.*\b(checking|savings|account)\b/.test(memo) || memo.includes("online transfer");
  const hasMerchantSignal = Boolean(normalizeText(tx.merchant_name) || normalizeText(tx.counterparty_name));
  const amountMagnitude = Math.abs(Number(tx.amount || 0));

  if (pfcPrimary.startsWith("TRANSFER") || primary === "TRANSFER_IN" || primary === "TRANSFER_OUT") {
    return { confidence: "high", notes: "Plaid category indicates transfer" };
  }

  if (hasTransferTokens && hasAccountDirection && !hasMerchantSignal) {
    return { confidence: "high", notes: "Memo indicates internal transfer between accounts" };
  }

  if (hasTransferTokens && !hasMerchantSignal && amountMagnitude >= 5) {
    return { confidence: "medium", notes: "Memo mentions transfer without merchant" };
  }

  return null;
}

export function looksLikeCcPayment(tx = {}, context = {}) {
  const memo = getMemo(tx);
  const outflow = isOutflow(tx);
  const inflow = isInflow(tx);
  const hasMerchantSignal = Boolean(normalizeText(tx.merchant_name) || normalizeText(tx.counterparty_name));
  const currentAccountType = normalizeText(context?.currentAccountType || "");
  const currentAccountSubtype = normalizeText(context?.currentAccountSubtype || "");
  const currentAccountIsCredit =
    currentAccountType.includes("credit") ||
    currentAccountSubtype.includes("credit") ||
    currentAccountSubtype.includes("credit card");
  const hasCreditCardPair = context?.hasCreditCardPaymentPair === true;
  const payrollLike =
    /\b(?:payroll|payroll ach|direct deposit|salary|wages|paycheck|paychex payroll|adp payroll|gusto payroll|transtech)\b/.test(memo);
  const p2pLike = /\b(?:zelle|venmo|cash app|cashapp)\b/.test(memo);
  const paypalPersonToPerson =
    /\bpaypal\b/.test(memo) &&
    /\b(?:friends?|family|person|personal|p2p|transfer)\b/.test(memo) &&
    !/\b(?:credit card|card payment|payment thank you|epay|epayment|e payment|e-payment|autopay)\b/.test(memo);
  const personNamePayment =
    /\b[a-z]{2,}\s+[a-z]{2,}\s+payment\b/.test(memo) &&
    !/\b(?:credit|card|crd|amex|american express|discover|chase|visa|mastercard|master card|thank you|epay|epayment)\b/.test(memo);
  const issuerHit =
    /\b(?:amex|american express|discover|chase|visa|mastercard|master card|credit crd|credit card|cc)\b/.test(memo);
  const hardNegative = payrollLike || p2pLike || paypalPersonToPerson || personNamePayment || /\bmobile deposit\b/.test(memo);
  const strongHigh = [
    "credit card payment",
    "card payment",
    "cc payment",
    "cc pmt",
    "payment received",
    "online payment",
    "automatic payment",
    "autopay",
    "auto pay",
    "mobile payment",
    "e payment",
    "e-payment",
    "epay",
    "epayment",
    "ach pmt",
  ];
  const memoHasStrongHigh = strongHigh.some((p) => memo.includes(p));
  const memoHasThankYou = memo.includes("thank you");
  const memoHasMedium =
    memo.includes("payment") &&
    (memo.includes("card") || memo.includes("cc") || issuerHit);
  const contextTargetIsCredit = Array.isArray(context?.targetAccountTypes)
    ? context.targetAccountTypes.includes("credit")
    : false;

  const hasHigh =
    memoHasStrongHigh ||
    (memoHasThankYou && memo.includes("payment")) ||
    (memoHasStrongHigh && memo.includes("ach") && (memo.includes("card") || memo.includes("credit"))) ||
    (issuerHit && /\b(?:payment|pmt|epay|epayment|e-payment|autopay|ach)\b/.test(memo));

  if (hardNegative && !hasCreditCardPair) {
    return null;
  }

  if (hasCreditCardPair && (outflow || currentAccountIsCredit) && (hasHigh || memoHasMedium || issuerHit || memo.includes("payment"))) {
    return {
      confidence: "high",
      notes: "Matched opposite-side credit card payment by amount/date and payment memo",
    };
  }

  if (currentAccountIsCredit && inflow && (memoHasStrongHigh || memoHasThankYou || memoHasMedium)) {
    return {
      confidence: "high",
      notes: "Credit account inflow with payment language",
    };
  }

  if (hasHigh && outflow) {
    if (hasMerchantSignal && memoHasThankYou && !memoHasStrongHigh && !memo.includes("payment")) {
      return null;
    }
    return {
      confidence: "high",
      notes: contextTargetIsCredit ? "Outflow payment toward credit account" : "Outflow with CC payment language",
    };
  }

  if (memoHasMedium && !hasMerchantSignal && outflow) {
    return { confidence: "medium", notes: "Outflow payment memo referencing card" };
  }

  return null;
}

export function looksLikePayroll(tx = {}) {
  const memo = getMemo(tx);
  const primary = (tx.category_primary || "").toUpperCase();
  const pfcPrimary = (tx.personal_finance_category?.primary || "").toUpperCase();
  if (
    /\b(?:payroll|payroll ach|direct deposit|salary|wages|paycheck|paychex payroll|adp payroll|gusto payroll|transtech)\b/.test(memo) ||
    primary.includes("PAYROLL") ||
    pfcPrimary.includes("PAYROLL")
  ) {
    return { confidence: "high", notes: "Payroll/direct deposit language" };
  }
  return null;
}

export function looksLikePeerToPeerTransfer(tx = {}) {
  const memo = getMemo(tx);
  const issuerOrCardPayment =
    /\b(?:credit card|credit crd|card payment|payment thank you|mobile payment - thank you|internet payment - thank you|amex|american express|discover|chase|visa|mastercard|master card|epay|epayment|e-payment|autopay)\b/.test(memo);

  if (issuerOrCardPayment) return null;

  if (/\b(?:zelle|venmo|cash app|cashapp)\b/.test(memo)) {
    return { confidence: "high", notes: "Peer-to-peer payment rail language" };
  }

  if (/\bpayment id\b/.test(memo)) {
    return { confidence: "high", notes: "Payment ID transfer language without card issuer evidence" };
  }

  if (/\b[a-z]{2,}\s+[a-z]{2,}\s+payment\b/.test(memo)) {
    return { confidence: "high", notes: "Person-name payment language without card issuer evidence" };
  }

  return null;
}

export function looksLikeRefund(tx = {}) {
  const memo = getMemo(tx);
  const inflow = isInflow(tx);
  const pfcPrimary = (tx.personal_finance_category?.primary || "").toUpperCase();
  const hasMerchantSignal = Boolean(normalizeText(tx.merchant_name) || normalizeText(tx.counterparty_name));
  const hasRefundTokens =
    memo.includes("refund") ||
    memo.includes("reversal") ||
    memo.includes("returned") ||
    memo.includes("chargeback");

  if (inflow && hasRefundTokens && (hasMerchantSignal || pfcPrimary.startsWith("REFUND"))) {
    return { confidence: "high", notes: "Inflow refund with merchant or refund category" };
  }

  if (inflow && (memo.includes("chargeback") || memo.includes("reversal") || memo.includes("credit reversal"))) {
    return { confidence: "high", notes: "Inflow with chargeback/reversal language" };
  }

  if (inflow && hasRefundTokens) {
    return { confidence: "medium", notes: "Inflow refund language without clear merchant/category" };
  }

  if (inflow && memo.includes("credit") && normalizeText(tx.merchant_name)) {
    return { confidence: "medium", notes: "Inflow credit tied to merchant" };
  }

  const strongRefundMemo =
    memo.includes("chargeback") || memo.includes("reversal") || memo.includes("refund") || memo.includes("returned");
  const strongRefundCategory = pfcPrimary.startsWith("REFUND") || pfcPrimary.startsWith("CHARGEBACK");
  if ((strongRefundMemo || strongRefundCategory) && (hasMerchantSignal || pfcPrimary)) {
    return { confidence: "high", notes: "Refund/chargeback indicator (direction-agnostic)" };
  }

  return null;
}

export function looksLikeOwnerMove(tx = {}, context = {}) {
  const memo = getMemo(tx);
  const inflow = isInflow(tx);
  const outflow = isOutflow(tx);
  const hasMerchantSignal = Boolean(normalizeText(tx.merchant_name) || normalizeText(tx.counterparty_name));
  const subtype = inflow ? TAXONOMY_TYPES.OWNER_CONTRIBUTION : TAXONOMY_TYPES.OWNER_DRAW;
  const ownerTokens = Array.isArray(context?.ownerTokens) ? context.ownerTokens : [];

  const memoContainsOwner = () => {
    if (!ownerTokens.length) return false;
    return ownerTokens.some((t) => t && memo.includes(t));
  };

  const drawPhrases = ["owner draw", "owner distribution", "draw to owner", "owner payout"];
  const contribPhrases = [
    "owner contribution",
    "capital contribution",
    "capital contributions",
    "capital injection",
    "contribution from owner",
  ];

  const cashOutPhrases = ["atm withdrawal", "cash withdrawal", "cash withdraw"];
  const selfTransferPhrases = ["to myself", "transfer to personal", "to personal", "venmo cashout", "paypal transfer"];
  const inflowOwnerPhrases = ["from owner", "owner contribution", "capital contribution", "capital injection"];
  const ownerOutflowWithName = [
    "zelle to",
    "venmo to",
    "venmo cashout",
    "paypal transfer",
    "transfer to personal",
    "to personal",
    "to myself",
  ];
  const ownerInflowWithName = [
    "zelle from",
    "from owner",
    "owner contribution",
    "capital contribution",
    "capital injection",
    "contribution from",
  ];

  if (drawPhrases.some((p) => memo.includes(p))) {
    return { confidence: "high", subtype: TAXONOMY_TYPES.OWNER_DRAW, notes: "Explicit owner draw language" };
  }
  if (contribPhrases.some((p) => memo.includes(p))) {
    return { confidence: "high", subtype: TAXONOMY_TYPES.OWNER_CONTRIBUTION, notes: "Explicit owner contribution language" };
  }

  const txnType = (tx.transaction_type || "").toLowerCase();
  const looksCashTxn = txnType.includes("cash") || txnType.includes("atm");
  if (outflow && (looksCashTxn || cashOutPhrases.some((p) => memo.includes(p))) && !hasMerchantSignal) {
    return { confidence: "high", subtype: TAXONOMY_TYPES.OWNER_DRAW, notes: "Cash/ATM withdrawal likely owner draw" };
  }

  if (outflow && selfTransferPhrases.some((p) => memo.includes(p))) {
    return { confidence: "high", subtype: TAXONOMY_TYPES.OWNER_DRAW, notes: "Transfer to personal/self" };
  }

  if (inflow && inflowOwnerPhrases.some((p) => memo.includes(p))) {
    return { confidence: "high", subtype: TAXONOMY_TYPES.OWNER_CONTRIBUTION, notes: "Inflow from owner" };
  }

  if (hasMerchantSignal) {
    return null;
  }

  if (outflow && memoContainsOwner() && ownerOutflowWithName.some((p) => memo.includes(p))) {
    return { confidence: "high", subtype: TAXONOMY_TYPES.OWNER_DRAW, notes: "Owner-named transfer outflow" };
  }

  if (inflow && memoContainsOwner() && ownerInflowWithName.some((p) => memo.includes(p))) {
    return { confidence: "high", subtype: TAXONOMY_TYPES.OWNER_CONTRIBUTION, notes: "Owner-named transfer inflow" };
  }

  return null;
}

export function classifyTaxonomy(tx = {}, context = {}) {
  const suppressCcPayment = context?.suppressCcPayment === true || context?.taxonomyOverride === "not_cc_payment";
  const classifiers = [
    { fn: looksLikeTransfer, type: TAXONOMY_TYPES.TRANSFER_INTERNAL },
    suppressCcPayment ? null : { fn: looksLikeCcPayment, type: TAXONOMY_TYPES.CC_PAYMENT },
    { fn: looksLikePayroll, type: TAXONOMY_TYPES.PAYROLL },
    { fn: looksLikeRefund, type: TAXONOMY_TYPES.REFUND },
    { fn: looksLikeOwnerMove, type: null },
    { fn: looksLikePeerToPeerTransfer, type: TAXONOMY_TYPES.PEER_TO_PEER_TRANSFER },
  ].filter(Boolean);

  for (const entry of classifiers) {
    const hit = entry.fn(tx, context);
    if (!hit) continue;

    const confidence = hit.confidence || "low";
    if (confidence !== "high") continue; // Foundation: only return high confidence

    const type =
      entry.type ||
      hit.subtype ||
      (isInflow(tx) ? TAXONOMY_TYPES.OWNER_CONTRIBUTION : TAXONOMY_TYPES.OWNER_DRAW);

    return {
      type,
      subtype: hit.subtype && hit.subtype !== type ? hit.subtype : null,
      confidence,
      notes: hit.notes || "",
    };
  }

  return null;
}

export function buildTaxonomyMeta(hit) {
  if (!hit) return null;
  return {
    taxonomy_type: hit.type,
    taxonomy_subtype: hit.subtype || null,
    taxonomy_confidence: hit.confidence,
    suggestion_source: "taxonomy",
    safe_to_auto_post: false,
    auto_approve_reason: null,
  };
}
