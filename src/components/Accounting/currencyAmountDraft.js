export function sanitizeCurrencyAmountDraft(value) {
  const cleaned = String(value ?? "").replace(/[$,\s]/g, "").replace(/[^0-9.]/g, "");
  const decimalIndex = cleaned.indexOf(".");
  if (decimalIndex < 0) return cleaned;
  const whole = cleaned.slice(0, decimalIndex);
  const decimals = cleaned.slice(decimalIndex + 1).replace(/\./g, "").slice(0, 2);
  return `${whole}.${decimals}`;
}

export function normalizeCurrencyAmountDraft(value) {
  const draft = sanitizeCurrencyAmountDraft(value);
  if (!draft || draft === ".") return "";
  const numeric = Number(draft);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric.toFixed(2) : draft;
}
