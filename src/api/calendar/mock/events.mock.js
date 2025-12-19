// src/api/calendar/mock/events.mock.js
import dayjs from 'dayjs';

const BLUEPRINTS = [
  { title: 'Crew standup', module: 'ops', type: 'job', dayOfWeek: 1, hour: 9, durationHours: 1 },
  { title: 'Weekly finance sync', module: 'financials', type: 'meeting', dayOfWeek: 2, hour: 10, durationHours: 1 },
  { title: 'Kitchen walkthrough', module: 'ops', type: 'job', dayOfWeek: 3, hour: 9, durationHours: 2, location: 'Active job site' },
  { title: 'AR follow-ups', module: 'financials', type: 'task', dayOfWeek: 4, hour: 11, durationHours: 1 },
  { title: 'Tile delivery follow up', module: 'ops', type: 'job', dayOfWeek: 5, hour: 9, durationHours: 1.5 },
  { title: 'Payroll submission', module: 'financials', type: 'deadline', dayOfWeek: 5, hour: 0, durationHours: 8, allDay: true },
  { title: 'Marketing review', module: 'marketing', type: 'meeting', dayOfWeek: 4, hour: 15, durationHours: 1 },
  { title: 'Tax prep consult', module: 'tax', type: 'deadline', dayOfWeek: 2, hour: 13, durationHours: 1 },
  { title: 'Content shoot', module: 'marketing', type: 'post', dayOfWeek: 1, hour: 14, durationHours: 2, repeatDays: 14 },
];

function seededRandom(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0; // convert to 32-bit int
  }
  const value = Math.abs(Math.sin(hash)) % 1;
  return value;
}

function getBaseJitter(base, blueprint) {
  const dayRoll = seededRandom(`${base}-day-${blueprint.title}`);
  const hourRoll = seededRandom(`${base}-hour-${blueprint.title}`);
  return {
    dayOffset: Math.round(dayRoll * 4) - 2, // -2 .. +2 days
    hourOffset: Math.round(hourRoll * 4) - 2, // -2 .. +2 hours
  };
}

function getOccurrenceVariation(base, blueprint, occurrenceIndex) {
  const skipRoll = seededRandom(`${base}-skip-${blueprint.title}-${occurrenceIndex}`);
  const minuteRoll = seededRandom(`${base}-minute-${blueprint.title}-${occurrenceIndex}`);
  return {
    skip: skipRoll > 0.82,
    minuteOffset: Math.round((minuteRoll - 0.5) * 120), // +/- 60 minutes
  };
}

function makeEvent({ base, businessId, blueprint, occurrenceIndex }) {
  const start = base.clone();
  const duration = blueprint.durationHours ?? 1;
  const end = start.clone().add(duration, 'hour');
  return {
    id: `mock-${blueprint.module}-${blueprint.type}-${start.valueOf()}-${occurrenceIndex}`,
    business_id: businessId,
    module: blueprint.module,
    type: blueprint.type,
    title: blueprint.title,
    description: blueprint.allDay ? `${blueprint.title} (all day)` : `${blueprint.title} (${start.format('h:mm A')})`,
    start_ts: start.toISOString(),
    end_ts: blueprint.allDay ? start.endOf('day').toISOString() : end.toISOString(),
    all_day: !!blueprint.allDay,
    location: blueprint.location || null,
    source: 'mock',
    status: 'scheduled',
    links: null,
    color: '#bfbfbf',
    created_at: start.toISOString(),
    updated_at: start.toISOString(),
  };
}

/**
 * Generate deterministic mock events for a date range.
 * The events repeat weekly (or every repeatDays) and stay within the provided window.
 */
export function generateMockCalendarEvents({
  fromISO,
  toISO,
  businessId,
  module = 'all',
  limit = 200,
}) {
  const start = dayjs(fromISO || Date.now()).startOf('day');
  const end = toISO ? dayjs(toISO).endOf('day') : start.clone().add(30, 'day');
  const biz = businessId || 'mock-biz';
  const monthKey = start.add(3, 'day').format('YYYY-MM');
  const events = [];

  for (const blueprint of BLUEPRINTS) {
    if (module !== 'all' && blueprint.module !== module) continue;
    const anchorWeek = start.clone().startOf('week');
    const baseDay = blueprint.dayOfWeek ?? 1;
    const { dayOffset, hourOffset } = getBaseJitter(monthKey, blueprint);
    const normalizedDay = ((baseDay + dayOffset) % 7 + 7) % 7;
    let cursor = anchorWeek.clone().add(normalizedDay, 'day');
    if (cursor.isBefore(start)) cursor = cursor.add(7, 'day');
    const hour = blueprint.allDay ? 0 : Math.min(20, Math.max(6, (blueprint.hour ?? 9) + hourOffset));
    cursor = cursor.hour(hour).minute(0);
    let occurrence = 0;
    const repeat = blueprint.repeatDays || 7;

    while (cursor.isBefore(end) && events.length < limit) {
      const variation = getOccurrenceVariation(monthKey, blueprint, occurrence + 1);
      const shifted = blueprint.allDay ? cursor : cursor.add(variation.minuteOffset, 'minute');
      if (!variation.skip) {
        events.push(
          makeEvent({ base: shifted, businessId: biz, blueprint, occurrenceIndex: occurrence })
        );
      }
      cursor = cursor.add(repeat, 'day');
      occurrence += 1;
    }
  }

  events.sort((a, b) => new Date(a.start_ts) - new Date(b.start_ts));
  return events.slice(0, limit);
}
