export function normalizeText(str = "") {
  return String(str || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function getCheckMemo(tx = {}) {
  return normalizeText([tx.name, tx.merchant_name, tx.counterparty_name].filter(Boolean).join(" "));
}

export function normalizeCheckMemo(tx = {}) {
  const memo = getCheckMemo(tx);
  return memo
    .replace(/check\s*#?\s*\d+/gi, " ")
    .replace(/chk\s*\d+/gi, " ")
    .replace(/check\s*no\.?\s*\d+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isCheck(tx = {}) {
  const transactionType = normalizeText(tx.transaction_type || "");
  const rawCheck = tx.check_number != null ? String(tx.check_number).trim() : "";
  const memo = getCheckMemo(tx);

  const parseCheckNumberFromMemo = () => {
    const match =
      memo.match(/check\s*#?\s*(\d{2,})/i) ||
      memo.match(/chk\s*(\d{2,})/i) ||
      memo.match(/check\s*no\.?\s*(\d{2,})/i);
    return match ? match[1] : null;
  };

  if (transactionType === "check" || transactionType === "cheque") {
    const parsed = rawCheck || parseCheckNumberFromMemo() || null;
    return { is_check: true, confidence: "high", reason: "transaction_type_check", check_number: parsed };
  }
  if (rawCheck) {
    return { is_check: true, confidence: "high", reason: "check_number_present", check_number: rawCheck };
  }

  if (memo) {
    if (/^check\s*#?\s*\d{2,}/i.test(memo)) {
      return { is_check: true, confidence: "medium", reason: "memo_starts_with_check_number", check_number: parseCheckNumberFromMemo() };
    }
    if (/\bcheck\b/i.test(memo) && /\d{2,}/.test(memo)) {
      return { is_check: true, confidence: "medium", reason: "memo_contains_check_digits", check_number: parseCheckNumberFromMemo() };
    }
    if (/\bchk\b/i.test(memo) && /\d{2,}/.test(memo)) {
      return { is_check: true, confidence: "medium", reason: "memo_contains_chk_digits", check_number: parseCheckNumberFromMemo() };
    }
    if (/check\s*no\.?\s*\d{2,}/i.test(memo)) {
      return { is_check: true, confidence: "medium", reason: "memo_contains_check_no", check_number: parseCheckNumberFromMemo() };
    }
  }

  return { is_check: false, confidence: null, reason: null, check_number: null };
}
