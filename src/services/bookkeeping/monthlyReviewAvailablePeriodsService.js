const MONTH_RE = /^(\d{4})-(\d{2})(?:-\d{2})?$/;

export function normalizeMonthKey(value) {
  const match = String(value || "").trim().match(MONTH_RE);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function monthStartDate(monthKey) {
  const key = normalizeMonthKey(monthKey);
  if (!key) return null;
  return `${key}-01`;
}

function addMonths(monthKey, delta) {
  const key = normalizeMonthKey(monthKey);
  if (!key) return null;
  const [year, month] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function compareMonthKeys(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

function formatPeriodLabel(monthKey) {
  const key = normalizeMonthKey(monthKey);
  if (!key) return "Selected month";
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function buildAvailableMonthlyReviewPeriods({
  activityDates = [],
  runMonths = [],
  currentMonth,
} = {}) {
  const normalizedCurrentMonth = normalizeMonthKey(currentMonth) || normalizeMonthKey(new Date().toISOString().slice(0, 7));
  const validActivityDates = (activityDates || [])
    .map((date) => String(date || "").slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  const activityMonthSet = new Set(validActivityDates.map((date) => normalizeMonthKey(date)).filter(Boolean));
  const runMonthSet = new Set((runMonths || []).map(normalizeMonthKey).filter(Boolean));

  const firstActivityDate = validActivityDates[0] || null;
  const firstActivityMonth = normalizeMonthKey(firstActivityDate);
  const earliestRunMonth = [...runMonthSet].sort(compareMonthKeys)[0] || null;
  const earliestMonth = [firstActivityMonth, earliestRunMonth].filter(Boolean).sort(compareMonthKeys)[0] || null;
  const periods = [];
  const monthSet = new Set();

  if (earliestMonth && normalizedCurrentMonth && compareMonthKeys(earliestMonth, normalizedCurrentMonth) <= 0) {
    for (let cursor = earliestMonth; cursor && compareMonthKeys(cursor, normalizedCurrentMonth) <= 0; cursor = addMonths(cursor, 1)) {
      monthSet.add(cursor);
    }
  }

  for (const runMonth of runMonthSet) monthSet.add(runMonth);

  const sortedMonths = [...monthSet].sort(compareMonthKeys);
  for (const month of sortedMonths) {
    const monthDates = validActivityDates.filter((date) => normalizeMonthKey(date) === month);
    const isPartialStartMonth = Boolean(firstActivityDate && firstActivityMonth === month && firstActivityDate !== monthStartDate(month));
    periods.push({
      month,
      value: month,
      label: formatPeriodLabel(month),
      firstActivityDate: monthDates[0] || null,
      lastActivityDate: monthDates[monthDates.length - 1] || null,
      booksStartDate: firstActivityDate,
      isPartialStart: isPartialStartMonth,
      isPartialStartMonth,
      isCurrentMonth: month === normalizedCurrentMonth,
      hasActivity: activityMonthSet.has(month),
      hasRun: runMonthSet.has(month),
    });
  }

  return periods;
}

export async function getAvailableMonthlyReviewPeriods({ businessId, db, now = new Date() } = {}) {
  if (!businessId) {
    const err = new Error("missing_business_id");
    err.status = 400;
    err.error = "missing_business_id";
    throw err;
  }
  if (!db?.from) {
    const err = new Error("missing_database");
    err.status = 500;
    err.error = "missing_database";
    throw err;
  }

  const { data: activityRows, error: activityError } = await db
    .from("bank_transactions")
    .select("date")
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .not("date", "is", null)
    .order("date", { ascending: true });
  if (activityError) throw activityError;

  const { data: runRows, error: runError } = await db
    .from("monthly_review_runs")
    .select("review_month")
    .eq("business_id", businessId)
    .order("review_month", { ascending: true });
  if (runError) throw runError;

  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return buildAvailableMonthlyReviewPeriods({
    activityDates: (activityRows || []).map((row) => row.date),
    runMonths: (runRows || []).map((row) => row.review_month),
    currentMonth,
  });
}

export default {
  buildAvailableMonthlyReviewPeriods,
  getAvailableMonthlyReviewPeriods,
  normalizeMonthKey,
};
