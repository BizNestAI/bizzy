// src/api/gpt/insights/generators/calendar.generators.js
import { supabase } from '../../../services/supabaseAdmin.js';

/** Upsert-like helper: dedupe by (user_id, module, source_event_id) */
async function insertInsightsDedup(rows = []) {
  const out = [];
  for (const r of rows) {
    try {
      if (!r.user_id || !r.module || !r.source_event_id) continue;
      const { data: existing } = await supabase
        .from('insights')
        .select('id')
        .eq('user_id', r.user_id)
        .eq('module', r.module)
        .eq('source_event_id', r.source_event_id)
        .limit(1);
      if (existing && existing.length) continue;

      const { data, error } = await supabase
        .from('insights')
        .insert(r)
        .select('id')
        .single();

      if (!error && data) out.push(data.id);
    } catch { /* ignore per-row failure */ }
  }
  return out;
}

const safe = (s) => (s || '').toString().trim();
const fmt = (iso) => new Date(iso).toLocaleString();

/* ============================================================================
  1) UPCOMING EVENTS (existing)
  Table: calendar_events (id, user_id, title, start_time, end_time, location, is_all_day?)
============================================================================ */
export async function genCalendarUpcoming({ userId, hoursAhead = 48 }) {
  if (!userId) return [];
  const now = new Date();
  const until = new Date(Date.now() + hoursAhead * 3600000);
  const { data, error } = await supabase
    .from('calendar_events')
    .select('id,title,start_time,end_time,location')
    .eq('user_id', userId)
    .gte('start_time', now.toISOString())
    .lte('start_time', until.toISOString())
    .order('start_time', { ascending: true })
    .limit(50);
  if (error || !data) return [];

  const rows = data.map(ev => ({
    user_id: userId,
    module: 'calendar',
    title: `Upcoming: ${safe(ev.title) || 'Event'}`,
    body: `${fmt(ev.start_time)}${ev.location ? ' @ ' + ev.location : ''}`,
    severity: 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open calendar', route: '/dashboard/calendar' },
    tags: ['calendar','upcoming'],
    source_event_id: `cal:upcoming:${ev.id}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
  2) TIME CONFLICTS / OVERLAPS (next 7 days)
============================================================================ */
export async function genEventConflicts({ userId, daysAhead = 7 }) {
  if (!userId) return [];
  const now = new Date();
  const until = new Date(Date.now() + daysAhead * 86400000);
  const { data, error } = await supabase
    .from('calendar_events')
    .select('id,title,start_time,end_time')
    .eq('user_id', userId)
    .gte('start_time', now.toISOString())
    .lte('start_time', until.toISOString())
    .order('start_time', { ascending: true })
    .limit(200);
  if (error || !data) return [];

  const evts = data;
  const overlaps = [];
  for (let i = 0; i < evts.length; i++) {
    const a = evts[i];
    const aStart = new Date(a.start_time).getTime();
    const aEnd   = new Date(a.end_time).getTime();
    for (let j = i + 1; j < evts.length; j++) {
      const b = evts[j];
      const bStart = new Date(b.start_time).getTime();
      if (bStart >= aEnd) break; // since sorted by start
      const bEnd = new Date(b.end_time).getTime();
      const overlap = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
      if (overlap > 0) overlaps.push({ a, b });
    }
  }

  const rows = overlaps.slice(0, 8).map(({ a, b }) => ({
    user_id: userId,
    module: 'calendar',
    title: `Conflict: "${safe(a.title)}" overlaps "${safe(b.title)}"`,
    body: `${fmt(a.start_time)} ↔ ${fmt(b.start_time)}`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Resolve conflict', route: '/dashboard/calendar' },
    tags: ['calendar','conflict'],
    source_event_id: `cal:conflict:${a.id}:${b.id}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
  3) RSVPs MISSING (events in next 48h with attendees but no responses)
  Tables: calendar_events, calendar_attendees
============================================================================ */
export async function genRsvpsMissing({ userId, hoursAhead = 48 }) {
  if (!userId) return [];
  const now = new Date();
  const until = new Date(Date.now() + hoursAhead * 3600000);

  const { data: evts } = await supabase
    .from('calendar_events')
    .select('id,title,start_time')
    .eq('user_id', userId)
    .gte('start_time', now.toISOString())
    .lte('start_time', until.toISOString())
    .limit(100);

  const ids = (evts || []).map(e => e.id);
  if (!ids.length) return [];

  const { data: att } = await supabase
    .from('calendar_attendees')
    .select('event_id,response_status') // response_status: 'accepted'|'tentative'|'declined'|null
    .in('event_id', ids);

  const byEvent = new Map(ids.map(id => [id, []]));
  for (const a of (att || [])) {
    byEvent.set(a.event_id, [...(byEvent.get(a.event_id) || []), a]);
  }

  const missing = (evts || []).filter(e => {
    const arr = byEvent.get(e.id) || [];
    if (!arr.length) return false; // no attendees → skip
    return arr.every(x => !x.response_status); // none has responded
  });

  const rows = missing.slice(0, 10).map(e => ({
    user_id: userId,
    module: 'calendar',
    title: `RSVPs missing: ${safe(e.title)}`,
    body: `${fmt(e.start_time)} — attendees have not responded.`,
    severity: 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Nudge attendees', route: '/dashboard/calendar' },
    tags: ['calendar','rsvp'],
    source_event_id: `cal:rsvp_missing:${e.id}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
  4) MISSING DETAILS (next 24h: no location/online link/agenda)
  Tables: calendar_events (location, conferencing_link? description/agenda?)
============================================================================ */
export async function genMissingDetails({ userId, hoursAhead = 24 }) {
  if (!userId) return [];
  const now = new Date();
  const until = new Date(Date.now() + hoursAhead * 3600000);

  const { data, error } = await supabase
    .from('calendar_events')
    .select('id,title,start_time,location,description,conferencing_link')
    .eq('user_id', userId)
    .gte('start_time', now.toISOString())
    .lte('start_time', until.toISOString())
    .order('start_time', { ascending: true })
    .limit(100);

  if (error || !data) return [];

  const needs = data.filter(e => {
    const hasLoc = !!safe(e.location);
    const hasLink = !!safe(e.conferencing_link);
    const hasAgenda = !!safe(e.description);
    return !(hasLoc || hasLink) || !hasAgenda;
  });

  const rows = needs.slice(0, 10).map(e => ({
    user_id: userId,
    module: 'calendar',
    title: `Add details: ${safe(e.title)}`,
    body: `${fmt(e.start_time)} — add location/online link and a brief agenda.`,
    severity: 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Edit event', route: '/dashboard/calendar' },
    tags: ['calendar','details'],
    source_event_id: `cal:missing_details:${e.id}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
  5) REMINDERS DUE (within next 6h)
  Table: calendar_reminders (id, user_id, title, remind_at, done)
============================================================================ */
export async function genRemindersDue({ userId, hoursAhead = 6, max = 10 }) {
  if (!userId) return [];
  const now = new Date();
  const until = new Date(Date.now() + hoursAhead * 3600000);

  const { data, error } = await supabase
    .from('calendar_reminders')
    .select('id,title,remind_at,done')
    .eq('user_id', userId)
    .eq('done', false)
    .gte('remind_at', now.toISOString())
    .lte('remind_at', until.toISOString())
    .order('remind_at', { ascending: true })
    .limit(50);

  if (error || !data) return [];

  const rows = data.slice(0, max).map(r => ({
    user_id: userId,
    module: 'calendar',
    title: `Reminder: ${safe(r.title)}`,
    body: `${fmt(r.remind_at)}`,
    severity: 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open reminders', route: '/dashboard/calendar' },
    tags: ['calendar','reminder'],
    source_event_id: `cal:reminder:${r.id}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
  6) AGENDA ITEMS DUE (next 3 days)
  Table: agenda_items (id, title, due_at, done)
============================================================================ */
export async function genAgendaItemsDue({ userId, daysAhead = 3, max = 10 }) {
  if (!userId) return [];
  const now = new Date();
  const until = new Date(Date.now() + daysAhead * 86400000);

  const { data, error } = await supabase
    .from('agenda_items')
    .select('id,title,due_at,done')
    .eq('user_id', userId)
    .eq('done', false)
    .gte('due_at', now.toISOString())
    .lte('due_at', until.toISOString())
    .order('due_at', { ascending: true })
    .limit(50);

  if (error || !data) return [];

  const rows = data.slice(0, max).map(a => ({
    user_id: userId,
    module: 'calendar',
    title: `Due soon: ${safe(a.title)}`,
    body: `${fmt(a.due_at)}`,
    severity: 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open agenda', route: '/dashboard/calendar' },
    tags: ['calendar','agenda'],
    source_event_id: `cal:agenda_due:${a.id}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
  7) FOCUS BLOCK SUGGESTION
  Heuristic: day within next 5d with > N meeting hours → suggest blocking time
============================================================================ */
export async function genFocusBlockSuggestion({ userId, daysAhead = 5, minHours = 6 }) {
  if (!userId) return [];
  const now = new Date();
  const until = new Date(Date.now() + daysAhead * 86400000);

  const { data, error } = await supabase
    .from('calendar_events')
    .select('id,title,start_time,end_time')
    .eq('user_id', userId)
    .gte('start_time', now.toISOString())
    .lte('start_time', until.toISOString())
    .order('start_time', { ascending: true })
    .limit(200);
  if (error || !data) return [];

  const byDay = new Map(); // 'YYYY-MM-DD' -> total hours
  for (const e of data) {
    const day = e.start_time.slice(0, 10);
    const durH = (new Date(e.end_time) - new Date(e.start_time)) / 3600000;
    byDay.set(day, (byDay.get(day) || 0) + Math.max(0, durH));
  }

  const rows = [];
  for (const [day, hrs] of byDay.entries()) {
    if (hrs >= minHours) {
      rows.push({
        user_id: userId,
        module: 'calendar',
        title: `Heavy meeting day (${hrs.toFixed(1)}h)`,
        body: `Consider adding a focus block on ${day}.`,
        severity: 'info',
        is_read: false,
        primary_cta: { action: 'open_route', label: 'Add focus block', route: '/dashboard/calendar' },
        tags: ['calendar','focus'],
        source_event_id: `cal:focus:${day}`,
      });
    }
  }

  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
  8) TAX DEADLINES NOT ON CALENDAR (next 30d)
  Cross-check tax_deadlines vs events; nudge to add event if none exists same day
============================================================================ */
export async function genTaxDeadlinesNotOnCalendar({ userId, windowDays = 30 }) {
  if (!userId) return [];
  const now = new Date();
  const until = new Date(Date.now() + windowDays * 86400000);

  const { data: deadlines } = await supabase
    .from('tax_deadlines')
    .select('id,deadline_type,deadline_date')
    .eq('user_id', userId)
    .gte('deadline_date', now.toISOString())
    .lte('deadline_date', until.toISOString())
    .order('deadline_date', { ascending: true });

  if (!deadlines || !deadlines.length) return [];

  // Fetch events in the window to check same-day existence
  const { data: evts } = await supabase
    .from('calendar_events')
    .select('id,start_time,title')
    .eq('user_id', userId)
    .gte('start_time', now.toISOString())
    .lte('start_time', until.toISOString());

  const setByDay = new Set((evts || []).map(e => e.start_time.slice(0,10)));
  const rows = deadlines
    .filter(d => !setByDay.has(d.deadline_date.slice(0,10)))
    .map(d => ({
      user_id: userId,
      module: 'calendar',
      title: `Add ${d.deadline_type} to calendar`,
      body: `Due ${new Date(d.deadline_date).toLocaleDateString()}.`,
      severity: 'info',
      is_read: false,
      primary_cta: { action: 'open_route', label: 'Open Tax', route: '/dashboard/tax' },
      tags: ['calendar','tax','deadline'],
      source_event_id: `cal:tax_deadline:nocal:${d.id}`,
    }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
  Aggregator for Calendar rail
============================================================================ */
export async function generateCalendarInsights(opts) {
  const { userId } = opts || {};
  const batches = await Promise.allSettled([
    genCalendarUpcoming({ userId, hoursAhead: 48 }),
    genEventConflicts({ userId, daysAhead: 7 }),
    genRsvpsMissing({ userId, hoursAhead: 48 }),
    genMissingDetails({ userId, hoursAhead: 24 }),
    genRemindersDue({ userId, hoursAhead: 6 }),
    genAgendaItemsDue({ userId, daysAhead: 3 }),
    genFocusBlockSuggestion({ userId, daysAhead: 5, minHours: 6 }),
    genTaxDeadlinesNotOnCalendar({ userId, windowDays: 30 }),
  ]);

  const total = batches
    .map(p => (p.status === 'fulfilled' ? (p.value?.length || 0) : 0))
    .reduce((a, b) => a + b, 0);

  return { ok: true, inserted: total };
}

export default generateCalendarInsights;
