export class FinancialEvidenceConfigurationError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

export function assertReportingTimezone(timezone) {
  if (!timezone) throw new FinancialEvidenceConfigurationError("reporting_timezone_unavailable");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date()); }
  catch { throw new FinancialEvidenceConfigurationError("reporting_timezone_invalid", { timezone }); }
  return timezone;
}

export function resolveCanonicalEvidencePeriods({ timezone, now = new Date(), intent }) {
  assertReportingTimezone(timezone);
  const { year, month, day } = localDateParts(now, timezone);
  const today = iso(year, month, day);
  if (intent === "tax_ytd_book_profit") {
    return {
      period: { start: iso(year, 1, 1), end: today, timezone, is_partial: today !== iso(year, 12, 31) },
      comparison_period: null,
      warnings: [],
    };
  }
  const prior = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  const priorLastDay = daysInMonth(prior.year, prior.month);
  const comparisonDay = Math.min(day, priorLastDay);
  const shortened = comparisonDay !== day;
  return {
    period: {
      start: iso(year, month, 1),
      end: today,
      timezone,
      is_partial: day !== daysInMonth(year, month),
    },
    comparison_period: {
      start: iso(prior.year, prior.month, 1),
      end: iso(prior.year, prior.month, comparisonDay),
    },
    warnings: shortened ? ["comparison_period_shortened_to_prior_month_end"] : [],
  };
}

function localDateParts(now, timezone) {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function iso(year, month, day) { return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`; }

