export const PAYMENT_TYPES = [
  ["estimated_payment", "Estimated payment"],
  ["withholding", "Withholding"],
  ["extension_payment", "Extension payment"],
  ["prior_year_credit", "Prior-year credit"],
  ["refund_applied", "Refund applied"],
  ["balance_due_payment", "Balance-due payment"],
  ["ptet_payment", "PTET payment"],
  ["entity_tax_payment", "Entity tax payment"],
  ["other", "Other"],
];

export const PAYMENT_SOURCES = [
  ["manual", "Manually entered"],
  ["bank_match", "Matched to bank transaction"],
  ["payroll", "Imported from payroll"],
  ["prior_return", "Imported from prior return"],
  ["accountant", "Accountant confirmed"],
  ["other", "Other"],
];

export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI",
  "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
  "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
  "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY",
];

export function formatMoney(value, fallback = "Not available") {
  if (value == null || Number.isNaN(Number(value))) return fallback;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value));
}

export function formatDate(value, fallback = "Not available") {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function formatDateTime(value, fallback = "Not available") {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function labelize(value) {
  if (!value) return "Not available";
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function paymentTypeLabel(value) {
  return PAYMENT_TYPES.find(([key]) => key === value)?.[1] || labelize(value);
}

export function paymentSourceLabel(value) {
  return PAYMENT_SOURCES.find(([key]) => key === value)?.[1] || labelize(value);
}

export function paymentStatusLabel(value) {
  const status = String(value || "posted").toLowerCase();
  if (["posted", "confirmed", "active"].includes(status)) return "Confirmed";
  if (status === "needs_review" || status === "pending_review") return "Pending review";
  if (status === "void" || status === "voided") return "Voided";
  return labelize(status);
}

export function safeAccountLabel(account) {
  if (!account) return "No reserve account selected";
  const name = account.displayName || "Tax reserve account";
  return account.mask ? `${name} •••• ${String(account.mask).slice(-4)}` : name;
}

export function bucketValue(summary, key) {
  const value = summary?.[key];
  return value == null || Number.isNaN(Number(value)) ? null : Number(value);
}
