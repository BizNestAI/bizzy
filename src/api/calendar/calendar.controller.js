// File: /src/api/calendar/calendar.controller.js
import {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  buildPrimaryCta,              // optional: add default CTAs to items
} from '../../services/calendar/calendar.service.js';
import { generateMockCalendarEvents } from './mock/events.mock.js';
import { getAgenda, getModuleAgendaGlance } from '../../services/calendar/agenda.service.js';
import { parseQuickCreate } from '../../services/calendar/quickCreate.service.js';

/** Utility: start/end of day in ISO */
const isoDayStart = (d) => {
  const x = d ? new Date(d) : new Date();
  x.setHours(0, 0, 0, 0);
  return x.toISOString();
};
const isoDayEnd = (d) => {
  const x = d ? new Date(d) : new Date();
  x.setHours(23, 59, 59, 999);
  return x.toISOString();
};

/** GET /api/calendar/health */
export function healthRoute(_req, res) {
  res.json({ ok: true, module: 'calendar' });
}

/** GET /api/calendar/events?business_id=&from=&to=&module=all */
export async function getEvents(req, res) {
  try {
    const { business_id, from, to, module = 'all' } = req.query;
    if (!business_id) return res.status(400).json({ error: 'missing business_id' });

    const fromISO = from ? new Date(from).toISOString() : isoDayStart(new Date());
    const toISO = to ? new Date(to).toISOString() : isoDayEnd(new Date());

    if (process.env.MOCK_CALENDAR === 'true') {
      const data = generateMockCalendarEvents({ fromISO, toISO, businessId: business_id, module })
        .filter((evt) => module === 'all' || evt.module === module)
        .map((evt) => ({ ...evt, cta: buildPrimaryCta(evt) }));
      return res.json({ data, business_id, from: fromISO, to: toISO, module });
    }

    const rows = await listEvents({ business_id, fromISO, toISO, module });
    // enrich with a default CTA for convenience (optional)
    const data = rows.map((r) => ({ ...r, cta: buildPrimaryCta(r) }));
    res.json({ data, business_id, from: fromISO, to: toISO, module });
  } catch (e) {
    console.error('[calendar] getEvents error:', e);
    // Keeping events strict (400/500) is fine; change to fail-soft if you want:
    res.status(500).json({ error: e.message || 'events_failed' });
  }
}

/** POST /api/calendar/events { draft } */
export async function postEvent(req, res) {
  try {
    const { draft } = req.body || {};
    if (!draft) return res.status(400).json({ error: 'missing draft' });
    const data = await createEvent(draft);
    res.json({ data });
  } catch (e) {
    console.error('[calendar] postEvent error:', e);
    res.status(400).json({ error: e.message || 'create_failed' });
  }
}

/** PATCH /api/calendar/events/:id { patch } */
export async function patchEvent(req, res) {
  try {
    const { id } = req.params;
    const { patch } = req.body || {};
    if (!id) return res.status(400).json({ error: 'missing id' });
    if (!patch) return res.status(400).json({ error: 'missing patch' });
    const data = await updateEvent(id, patch);
    res.json({ data });
  } catch (e) {
    console.error('[calendar] patchEvent error:', e);
    res.status(400).json({ error: e.message || 'update_failed' });
  }
}

/** DELETE /api/calendar/events/:id */
export async function delEvent(req, res) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'missing id' });
    await deleteEvent(id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[calendar] delEvent error:', e);
    res.status(400).json({ error: e.message || 'delete_failed' });
  }
}

/**
 * GET /api/calendar/agenda?business_id=&module=&date=ISO
 * - Keeps your existing “today + next 7 days” agenda shape (today/next).
 * - FAIL-SOFT: returns { today: [], next: [] } on error (200 OK)
 */
export async function getAgendaRoute(req, res) {
  const { business_id, module = 'all', date } = req.query;
  try {
    if (!business_id) return res.status(400).json({ error: 'missing business_id' });

    const base = date ? new Date(date) : new Date();
    const todayStart = isoDayStart(base);
    const todayEnd = isoDayEnd(base);

    const nextEndDate = new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000);
    const nextEnd = isoDayEnd(nextEndDate);

    const today = await getAgenda({ business_id, module, fromISO: todayStart, toISO: todayEnd, limit: 8 });
    const next = await getAgenda({ business_id, module, fromISO: todayEnd, toISO: nextEnd, limit: 8 });

    res.json({ today, next, business_id, module, date: base.toISOString() });
  } catch (e) {
    console.error('[calendar] getAgendaRoute error:', e);
    // Fail-soft: never 500 the UI; return empty lists with helpful context
    const base = date ? new Date(date) : new Date();
    res.json({
      today: [],
      next: [],
      business_id: business_id ?? null,
      module,
      date: base.toISOString(),
      error: 'agenda_failed',
    });
  }
}

/**
 * GET /api/calendar/agenda-range?business_id=&module=&from=&to=
 * - General range agenda used by widgets; defaults to today → +14 days.
 * - FAIL-SOFT: returns { items: [] } on error (200 OK)
 */
export async function getAgendaRangeRoute(req, res) {
  const { business_id, module = 'all', from, to } = req.query;
  try {
    if (!business_id) return res.status(400).json({ error: 'missing business_id' });

    const start = from ? new Date(from) : new Date();
    const end = to ? new Date(to) : new Date(start.getTime() + 14 * 86400000);

    const fromISO = isoDayStart(start);
    const toISO = isoDayEnd(end);

    const rows = await listEvents({ business_id, fromISO, toISO, module });
    const items = rows.map((r) => ({ ...r, cta: buildPrimaryCta(r) }));

    res.json({ business_id, module, from: fromISO, to: toISO, items });
  } catch (e) {
    console.error('[calendar] getAgendaRangeRoute error:', e);
    // Fail-soft: empty items array with the context you asked for
    const start = from ? new Date(from) : new Date();
    const end = to ? new Date(to) : new Date(start.getTime() + 14 * 86400000);
    res.json({
      business_id: business_id ?? null,
      module,
      from: isoDayStart(start),
      to: isoDayEnd(end),
      items: [],
      error: 'agenda_range_failed',
    });
  }
}

/**
 * OPTIONAL: GET /api/calendar/agenda-glance?business_id=&module=
 * - FAIL-SOFT: returns {} or { items: [] } on error (200 OK)
 */
export async function getAgendaGlanceRoute(req, res) {
  const { business_id, module = 'all' } = req.query;
  try {
    if (!business_id) return res.status(400).json({ error: 'missing business_id' });

    const data = await getModuleAgendaGlance({ business_id, module });
    res.json(data);
  } catch (e) {
    console.error('[calendar] getAgendaGlanceRoute error:', e);
    // Fail-soft: return an empty shape; adjust to your UI’s expectation if needed
    res.json({ items: [], error: 'agenda_glance_failed' });
  }
}

/** POST /api/calendar/quick-create { input, defaults } */
export async function quickCreateRoute(req, res) {
  try {
    const { input, defaults } = req.body || {};
    if (!input) return res.status(400).json({ error: 'missing input' });
    const parsed = await parseQuickCreate(input, defaults);
    res.json(parsed);
  } catch (e) {
    console.error('[calendar] quickCreateRoute error:', e);
    res.status(400).json({ error: e.message || 'quick_create_failed' });
  }
}
