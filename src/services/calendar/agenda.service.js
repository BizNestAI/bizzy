// File: /src/services/calendar/agenda.service.js
// Uses listEvents (with statusIn) instead of raw db.query

import { listEvents, buildPrimaryCta } from './calendar.service.js';

export async function getAgenda({
  business_id,
  module = 'all',
  fromISO,
  toISO,
  limit = 10,
}) {
  try {
    // Pull a bigger window, then slice after filtering
    const rows = await listEvents({
      business_id,
      fromISO,
      toISO,
      module,                               // server-side filter if column exists
      statusIn: ['scheduled', 'in_progress'],
      limit: Math.max(limit * 3, 50),
    });

    const filtered = module === 'all' ? rows : rows.filter(r => r.module === module);
    return filtered.slice(0, limit).map(rowToAgenda);
  } catch (e) {
    console.error('[agenda] getAgenda error:', e);
    return []; // fail-soft
  }
}

export async function getModuleAgendaGlance({ business_id, module, todayISO }) {
  try {
    const start = new Date(new Date(todayISO).setHours(0, 0, 0, 0)).toISOString();
    const endToday = new Date(new Date(todayISO).setHours(23, 59, 59, 999)).toISOString();
    const nextEnd = new Date(new Date(todayISO).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const today = await getAgenda({ business_id, module, fromISO: start,    toISO: endToday, limit: 6 });
    const next  = await getAgenda({ business_id, module, fromISO: endToday, toISO: nextEnd,  limit: 6 });
    return { today, next };
  } catch (e) {
    console.error('[agenda] getModuleAgendaGlance error:', e);
    return { today: [], next: [] }; // fail-soft
  }
}

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
