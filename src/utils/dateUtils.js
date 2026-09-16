export const getMonthName = (monthNum) => {
  const date = new Date();
  date.setMonth(monthNum - 1);
  return date.toLocaleString('default', { month: 'long' });
};

export function parseCalendarDateOnly(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, monthIndex, day);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== monthIndex ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

export function parseDisplayDate(value) {
  if (!value) return null;
  const raw = String(value);
  const dateOnly = parseCalendarDateOnly(raw.slice(0, 10));
  if (dateOnly && raw.length === 10) return dateOnly;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatShortCalendarDate(value, options = {}) {
  const date = parseDisplayDate(value);
  if (!date) return options.fallback ?? "";
  return date.toLocaleDateString(options.locale, {
    month: "short",
    day: "numeric",
    ...(options.year ? { year: "numeric" } : {}),
  });
}
