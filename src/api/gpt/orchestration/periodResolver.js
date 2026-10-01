const DEFAULT_TIMEZONE = "America/New_York";
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function localParts(now, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function resolveFinancialPeriod(message, { now = new Date(), timezone = DEFAULT_TIMEZONE } = {}) {
  let tz = timezone || DEFAULT_TIMEZONE;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = DEFAULT_TIMEZONE; }
  const { year, month, day } = localParts(now, tz);
  const text = String(message || "").toLowerCase();
  const explicit = text.match(/\b(20\d{2}-\d{2}-\d{2})\s+(?:to|through|until|-)\s+(20\d{2}-\d{2}-\d{2})\b/);
  if (explicit) return { start_date: explicit[1], end_date: explicit[2], label: `${explicit[1]} through ${explicit[2]}`, is_partial: false, timezone: tz, kind: "explicit_range" };

  if (/\blast year\b/.test(text)) return { start_date: iso(year - 1, 1, 1), end_date: iso(year - 1, 12, 31), label: String(year - 1), is_partial: false, timezone: tz, kind: "last_year" };
  if (/\b(this year|year to date|ytd)\b/.test(text)) return { start_date: iso(year, 1, 1), end_date: iso(year, month, day), label: `${year} year to date`, is_partial: true, timezone: tz, kind: "year_to_date" };
  if (/\b(trailing|last) 12 months\b/.test(text)) {
    const startMonth = month === 12 ? 1 : month + 1;
    const startYear = month === 12 ? year : year - 1;
    return { start_date: iso(startYear, startMonth, 1), end_date: iso(year, month, day), label: "trailing 12 months", is_partial: true, timezone: tz, kind: "trailing_12_months" };
  }
  if (/\blast (?:couple|two) months\b/.test(text)) {
    const start = new Date(Date.UTC(year, month - 3, 1));
    return { start_date: iso(start.getUTCFullYear(), start.getUTCMonth() + 1, 1), end_date: iso(year, month, day), label: "current and prior two calendar months", is_partial: true, timezone: tz, kind: "current_and_prior_two_calendar_months" };
  }
  if (/\blast month\b/.test(text)) {
    const m = month === 1 ? 12 : month - 1;
    const y = month === 1 ? year - 1 : year;
    return { start_date: iso(y, m, 1), end_date: iso(y, m, lastDay(y, m)), label: `${MONTHS[m - 1]} ${y}`, is_partial: false, timezone: tz, kind: "month" };
  }

  const namedIndex = MONTHS.findIndex((name) => new RegExp(`\\b${name}\\b`).test(text));
  if (namedIndex >= 0) {
    const m = namedIndex + 1;
    const explicitYear = Number(text.match(/\b(20\d{2})\b/)?.[1] || 0);
    const y = explicitYear || (m > month ? year - 1 : year);
    const current = y === year && m === month;
    return {
      start_date: iso(y, m, 1), end_date: current ? iso(year, month, day) : iso(y, m, lastDay(y, m)),
      label: `${MONTHS[namedIndex][0].toUpperCase()}${MONTHS[namedIndex].slice(1)} ${y}${current ? " month to date" : ""}`,
      is_partial: current || /\bso far\b/.test(text), timezone: tz, kind: "month",
    };
  }

  return { start_date: iso(year, month, 1), end_date: iso(year, month, day), label: "current month to date", is_partial: true, timezone: tz, kind: "current_month" };
}

export { DEFAULT_TIMEZONE };
