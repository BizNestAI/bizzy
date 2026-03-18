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
