// /src/services/tax/seedDefaultTaxDeadlines.js
import { listEvents } from '../calendar/calendar.service.js';
import { saveCalendarEvent } from '../calendar/saveCalendarEvent.js';

/** Move Sat/Sun to next Monday (basic business-day roll-forward). */
function nextBusinessDay(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay(); // 0 Sun .. 6 Sat
  if (day === 6) dt.setUTCDate(dt.getUTCDate() + 2); // Sat -> Mon
  if (day === 0) dt.setUTCDate(dt.getUTCDate() + 1); // Sun -> Mon
  return dt;
}

/** Build a UTC date (YYYY, M(1-12), D). */
function utcDate(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d));
}

/** Federal small-business baseline deadlines for a given year. */
function federalSmallBizDeadlines(year) {
  const items = [];

  // Quarterly estimated tax (1040-ES) — Q1/Q2/Q3 current year, Q4 is Jan 15 of next year
  const q = [
    { label: 'Q1 Estimated Tax Payment (1040-ES)', date: utcDate(year, 4, 15) },
    { label: 'Q2 Estimated Tax Payment (1040-ES)', date: utcDate(year, 6, 15) },
    { label: 'Q3 Estimated Tax Payment (1040-ES)', date: utcDate(year, 9, 15) },
  ];
  q.forEach(qi => items.push({ title: qi.label, date: nextBusinessDay(qi.date) }));

  // Q4 (for this tax year) is due Jan 15 of next calendar year
  items.push({
    title: `Q4 Estimated Tax Payment (1040-ES)`,
    date: nextBusinessDay(utcDate(year + 1, 1, 15)),
  });

  // Annual returns (common for Bizzy’s audience: sole prop / SMLLC Schedule C)
  items.push({ title: 'Individual Return Due (1040 + Schedule C)', date: nextBusinessDay(utcDate(year + 1, 4, 15)) });

  // S-Corp & Partnership (many construction companies choose this)
  items.push({ title: 'S-Corp & Partnership Returns Due (1120-S / 1065)', date: nextBusinessDay(utcDate(year + 1, 3, 15)) });

  // Extensions (filed previous April/March) -> extended due dates in the following fall
  items.push({ title: 'Extended Partnership/S-Corp Returns Due', date: nextBusinessDay(utcDate(year + 1, 9, 15)) });
  items.push({ title: 'Extended Individual Returns Due',       date: nextBusinessDay(utcDate(year + 1, 10, 15)) });

  // W-2 / 1099-NEC
  items.push({ title: 'Deliver W-2s to Employees', date: nextBusinessDay(utcDate(year + 1, 1, 31)) });
  items.push({ title: 'Deliver 1099-NEC to Contractors', date: nextBusinessDay(utcDate(year + 1, 1, 31)) });
  // IRS filing windows (paper/e-file); for MVP, put the e-file date:
  items.push({ title: 'E-file W-2s / 1099s with IRS/SSA', date: nextBusinessDay(utcDate(year + 1, 3, 31)) });

  // Payroll cadence (high level). Many Bizzy users file 941 quarterly.
  // Q1/Q2/Q3/Q4 Forms 941 due: last day of the month following end of quarter (Apr 30, Jul 31, Oct 31, Jan 31)
  items.push({ title: 'Form 941 Q1 Due', date: nextBusinessDay(utcDate(year, 4, 30)) });
  items.push({ title: 'Form 941 Q2 Due', date: nextBusinessDay(utcDate(year, 7, 31)) });
  items.push({ title: 'Form 941 Q3 Due', date: nextBusinessDay(utcDate(year, 10, 31)) });
  items.push({ title: 'Form 941 Q4 Due', date: nextBusinessDay(utcDate(year + 1, 1, 31)) });

  // FUTA annual (Form 940) due Jan 31 next year
  items.push({ title: 'Form 940 (FUTA) Due', date: nextBusinessDay(utcDate(year + 1, 1, 31)) });

  // Universal ops/compliance that matter for home services
  items.push({ title: 'Workers Comp Insurance Renewal (review)', date: nextBusinessDay(utcDate(year + 1, 1, 15)) });
  items.push({ title: 'General Liability Insurance Renewal (review)', date: nextBusinessDay(utcDate(year + 1, 1, 15)) });

  return items;
}

/** Simple dedupe: same title on the same day within +/- 1 day window. */
async function alreadySeeded({ businessId, title, dateISO }) {
  const start = new Date(dateISO);
  const fromISO = new Date(start.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const toISO   = new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const rows = await listEvents({
    business_id: businessId,
    fromISO,
    toISO,
    module: 'tax',
    statusIn: ['scheduled', 'in_progress', 'done'],
    limit: 200,
  });

  return rows.some(r =>
    r.title === title &&
    new Date(r.start_ts).toDateString() === new Date(dateISO).toDateString()
  );
}

/**
 * Seed default tax deadlines for a business/year.
 * Call this on onboarding and at year-roll (Dec/Jan) or expose a route.
 */
export async function seedDefaultTaxDeadlines({
  userId,
  businessId,
  year,
}) {
  if (!userId) throw new Error('userId required');
  if (!businessId) throw new Error('businessId required');
  if (!year) year = new Date().getUTCFullYear();

  const items = federalSmallBizDeadlines(year);

  let created = 0, skipped = 0, failures = 0;

  for (const it of items) {
    const dateISO = it.date.toISOString();

    // dedupe guard
    if (await alreadySeeded({ businessId, title: it.title, dateISO })) {
      skipped++;
      continue;
    }

    const res = await saveCalendarEvent({
      userId,
      businessId,
      title: it.title,
      date: dateISO,
      type: 'deadline',
      module: 'tax',
      description: 'Auto-added by Bizzy (federal baseline).',
      allDay: true,
      source: 'system',
      // reminder idea: 7d + 1d before
      reminders: [
        { offset: 'P7D', channel: 'inapp' },  // ISO-8601 duration; your reminder writer stores raw string
        { offset: 'P1D', channel: 'inapp' },
      ],
    });

    if (res?.persisted) created++;
    else failures++;
  }

  return { created, skipped, failures, year };
}
