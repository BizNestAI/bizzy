// src/utils/monthKey.js
// Single source of truth for month keys and ranges

const pad2 = (n) => String(n).padStart(2, "0");

// Returns "YYYY-MM-01"
export function monthKeyFromParts(year, month) {
  return `${year}-${pad2(month)}-01`;
}

// Returns a Date for first day of month (local)
export function monthDateFromParts(year, month) {
  return new Date(year, month - 1, 1);
}

// Parses "YYYY-MM" or "YYYY-MM-01" into { year, month }
export function partsFromMonthKey(monthKey) {
  const m = String(monthKey || "").split("-").map((v) => Number(v));
  if (m.length < 2 || !m[0] || !m[1]) return { year: NaN, month: NaN };
  return { year: m[0], month: m[1] };
}

// Last completed calendar month relative to now
export function lastFullMonthParts(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

// Previous month parts
export function prevMonthParts({ year, month }) {
  const d = new Date(year, month - 2, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

// Range of last N months (oldest -> newest)
export function rangeLastNMonths({ year, month, n }) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(year, month - 1 - i, 1);
    out.push({
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      monthKey: monthKeyFromParts(d.getFullYear(), d.getMonth() + 1),
    });
  }
  return out;
}

// Chronological trailing window ending with a one-based anchor month.
export function trailingMonthWindow({ anchorYear, anchorMonth, count = 12 }) {
  const year = Number(anchorYear);
  const month = Number(anchorMonth);
  const n = Number(count);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error("invalid_anchor_year");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("invalid_anchor_month");
  }
  if (!Number.isInteger(n) || n < 1 || n > 36) {
    throw new Error("invalid_month_count");
  }
  return rangeLastNMonths({ year, month, n });
}
