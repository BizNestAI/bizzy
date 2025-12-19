// File: /src/services/calendar/calendar.service.js
import dayjs from 'dayjs';
import crypto from 'node:crypto';
import { db } from './db.js';
import { generateMockCalendarEvents } from '../../api/calendar/mock/events.mock.js';

function buildMockEvents({ fromISO, toISO, businessId, module = 'all', limit = 500 }) {
  const events = generateMockCalendarEvents({ fromISO, toISO, businessId, module, limit });
  const filtered = module && module !== 'all' ? events.filter((e) => e.module === module) : events;
  return filtered.slice(0, limit);
}

const MODULE_COLORS = {
  financials: '#22c55e',
  tax: '#ffd700',
  marketing: '#60a5fa',
  investments: '#c084fc',
  ops: '#94a3b8',
};

function deriveColor(module) {
  return MODULE_COLORS[module] || '#a3a3a3';
}

function validateEventDraft(draft) {
  const errs = [];
  if (!draft.title) errs.push('title required');
  if (!draft.start || !draft.end) errs.push('start/end required');
  if (!draft.module) errs.push('module required');
  if (!draft.type) errs.push('type required');
  if (draft.start && draft.end && new Date(draft.end) <= new Date(draft.start))
    errs.push('end must be after start');
  return errs;
}

export async function createEvent(draft) {
  const errs = validateEventDraft(draft);
  if (errs.length) throw new Error('Invalid event: ' + errs.join(', '));

  const payload = {
    id: crypto.randomUUID(),
    business_id: draft.business_id,
    user_id: draft.user_id,
    module: draft.module,
    type: draft.type,
    title: draft.title,
    description: draft.description ?? null,
    start_ts: draft.start,
    end_ts: draft.end,
    all_day: !!draft.all_day,
    location: draft.location ?? null,
    source: draft.source ?? 'manual',
    status: draft.status ?? 'scheduled',
    links: draft.links ?? null,
    color: draft.color ?? deriveColor(draft.module),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const data = await db.insert('calendar_events', payload);

  // reminders (optional)
  for (const r of draft.reminders ?? []) {
    await db.insert('calendar_reminders', {
      event_id: data.id,
      offset_str: r.offset,
      channel: r.channel ?? 'inapp',
    });
  }
  return data;
}

export async function updateEvent(id, patch) {
  const existing = await db.findById('calendar_events', id);
  if (!existing) throw new Error('Not found');

  const updated = {
    ...existing,
    ...normalizePatch(patch),
    updated_at: new Date().toISOString(),
  };

  const errs = validateEventDraft({
    ...updated,
    start: updated.start_ts,
    end: updated.end_ts,
  });
  if (errs.length) throw new Error('Invalid event: ' + errs.join(', '));

  return db.update('calendar_events', id, updated);
}

function normalizePatch(patch) {
  const out = { ...patch };
  if (patch.start) out.start_ts = patch.start;
  if (patch.end) out.end_ts = patch.end;
  delete out.start; delete out.end;
  return out;
}

export async function deleteEvent(id) {
  await db.delete('calendar_reminders', null); // optional cleanup by trigger
  await db.delete('calendar_events', id);
}

/**
 * List events for a range and optional module/status filters.
 * Adds support for:
 *  - statusIn: string[]  (e.g., ['scheduled','in_progress'])
 *  - limit:    number    (max rows to return; default 500)
 * Fail-soft: returns [] on any underlying error.
 */
export async function listEvents({
  business_id,
  fromISO,
  toISO,
  module,
  statusIn = null,
  limit = 500,
}) {
  const mockEnabled = process.env.MOCK_CALENDAR === 'true';
  const fallbackEnabled = process.env.MOCK_CALENDAR_FALLBACK !== 'false';
  try {

    // Pull a reasonably wide set then filter by overlap in JS.
     // If your db layer supports BETWEEN/overlap, you can push this down later.
    const match = { business_id, start_ts_lte: toISO }; // fast prefilter
    let rows = await db.query(
      'calendar_events',
      match,
      { column: 'start_ts', ascending: true },
      Math.max(limit * 3, 1000) // grab more, then slice after filtering
    );

    // Keep only events that OVERLAP [fromISO, toISO]
     const from = new Date(fromISO).getTime();
     const to = new Date(toISO).getTime();
     rows = rows.filter(r => {
       const start = new Date(r.start_ts).getTime();
       const end = new Date(r.end_ts).getTime();
       return start < to && end > from;
     });

     if (module && module !== 'all') rows = rows.filter(r => r.module === module);
     if (Array.isArray(statusIn) && statusIn.length) {
       const set = new Set(statusIn.map(String));
       rows = rows.filter(r => set.has(String(r.status)));
     }

    // Sort and cap
     rows.sort((a, b) => new Date(a.start_ts) - new Date(b.start_ts));
     let sliced = rows.slice(0, limit);

     if (mockEnabled) {
       const mockRows = buildMockEvents({ fromISO, toISO, businessId: business_id, module, limit });
       sliced = [...sliced, ...mockRows]
         .sort((a, b) => new Date(a.start_ts) - new Date(b.start_ts))
         .slice(0, limit);
    } else if (!sliced.length && fallbackEnabled) {
       sliced = buildMockEvents({ fromISO, toISO, businessId: business_id, module, limit });
     }

     return sliced;
  } catch (e) {
    console.error('[calendar] listEvents error:', e);
    if (fallbackEnabled) {
      return buildMockEvents({ fromISO, toISO, businessId: business_id, module, limit });
    }
    return [];
  }
}

/**
 * Convenience: Agenda built via listEvents (so all filtering is centralized).
 * Use this from agenda.service.js instead of querying db directly.
 */
export async function getAgenda({
  business_id,
  module = 'all',
  fromISO,
  toISO,
  limit = 10,
}) {
  const rows = await listEvents({
    business_id,
    fromISO,
    toISO,
    module,
    statusIn: ['scheduled', 'in_progress'],
    // grab a few more, then slice (in case filtering shrinks set)
    limit: Math.max(limit * 3, 50),
  });

  const filtered = module === 'all' ? rows : rows.filter(r => r.module === module);
  return filtered.slice(0, limit).map(rowToAgenda);
}

/** Build primary CTA default based on module/type */
export function buildPrimaryCta(e) {
  if (e.module === 'financials' && e.type === 'invoice')
    return { label: 'Open Invoice', action: 'open_route', route: `/dashboard/accounting/invoices/${e.links?.invoice_id ?? ''}` };
  if (e.module === 'tax' && e.type === 'deadline')
    return { label: 'Tax Deadlines', action: 'open_route', route: `/dashboard/tax/deadlines` };
  if (e.module === 'marketing' && e.type === 'post')
    return { label: 'Open Post', action: 'open_route', route: `/dashboard/marketing/gallery/${e.links?.post_id ?? ''}` };
  if (e.module === 'ops' && e.type === 'job')
    return { label: 'Open Job', action: 'open_route', route: `/dashboard/ops/jobs/${e.links?.job_id ?? ''}` };
  const dateParam = encodeURIComponent(e.start_ts || '');
  const dateSuffix = dateParam ? `?date=${dateParam}` : '';
  return {
    label: 'Open in Calendar',
    action: 'open_route',
    route: `/dashboard/calendar${dateSuffix}`,
  };
}

/** Internal: map event row -> agenda item */
function rowToAgenda(e) {
  return {
    id: e.id,
    module: e.module,
    type: e.type,
    title: e.title,
    when: { start: e.start_ts, end: e.end_ts, all_day: e.all_day },
    meta: { location: e.location, status: e.status },
    primaryCta: buildPrimaryCta(e),
    secondaryCta: {
      label: 'Ask Bizzi',
      action: 'open_chat',
      payload: { intent: 'explain_event', event_id: e.id },
    },
  };
}
