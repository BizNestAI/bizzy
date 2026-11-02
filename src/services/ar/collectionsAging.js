import { daysPastDueDateOnly, formatDateOnly, normalizeDateOnly } from "./collectionsInvoiceProjection.js";

export const COLLECTIONS_AGING_BUCKETS = Object.freeze([
  Object.freeze({ key: "current", label: "Current", min: 0, max: 0, colorToken: "#3fb489", softToken: "rgba(63,180,137,0.16)" }),
  Object.freeze({ key: "1_30", label: "1–30", min: 1, max: 30, colorToken: "#f0c56b", softToken: "rgba(240,197,107,0.14)" }),
  Object.freeze({ key: "31_60", label: "31–60", min: 31, max: 60, colorToken: "#e99b60", softToken: "rgba(233,155,96,0.14)" }),
  Object.freeze({ key: "61_90", label: "61–90", min: 61, max: 90, colorToken: "#e06d67", softToken: "rgba(224,109,103,0.14)" }),
  Object.freeze({ key: "90_plus", label: "90+", min: 91, max: Infinity, colorToken: "#c95c80", softToken: "rgba(201,92,128,0.14)" }),
]);

export const UNKNOWN_COLLECTIONS_AGING = Object.freeze({
  key: "unknown",
  label: "Unknown",
  daysPastDue: null,
  colorToken: "rgba(255,255,255,0.42)",
  softToken: "rgba(255,255,255,0.045)",
});

export function getCollectionsAging(dueDate, { asOf = new Date(), timeZone = "America/New_York" } = {}) {
  if (!normalizeDateOnly(dueDate)) return { ...UNKNOWN_COLLECTIONS_AGING };
  const daysPastDue = daysPastDueDateOnly(dueDate, asOf, timeZone);
  if (daysPastDue == null) return { ...UNKNOWN_COLLECTIONS_AGING };
  const definition = COLLECTIONS_AGING_BUCKETS.find((bucket) => daysPastDue >= bucket.min && daysPastDue <= bucket.max);
  return { ...definition, daysPastDue };
}

export function collectionsAgingBadgeText(aging) {
  if (!aging || aging.key === "unknown") return "Due date unavailable";
  if (aging.key === "current") return "Current";
  return `${aging.label} · ${aging.daysPastDue} ${aging.daysPastDue === 1 ? "day" : "days"} past due`;
}

export function formatCollectionsDueDate(dueDate, { asOf = new Date(), timeZone = "America/New_York", locale = "en-US" } = {}) {
  const normalized = normalizeDateOnly(dueDate);
  if (!normalized) return "Due date unavailable";
  const displayYear = yearInTimeZone(asOf, timeZone);
  const dueYear = Number(normalized.slice(0, 4));
  return formatDateOnly(normalized, { locale, month: "short", year: dueYear !== displayYear });
}

function yearInTimeZone(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().getFullYear();
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(date));
}
