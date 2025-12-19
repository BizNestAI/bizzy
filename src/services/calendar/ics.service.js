import ics from 'ics';
import { db } from './db.js';

export async function generateIcsFeed({ business_id, token }) {
  // validate token if you add a table for it
  const events = await db.query('calendar_events', {
    business_id,
    start_ts_gte: new Date(new Date().setMonth(new Date().getMonth() - 3)).toISOString(),
    end_ts_lte: new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString(),
  }, { column: 'start_ts', ascending: true });

  const icsEvents = events.map(e => {
    const start = new Date(e.start_ts);
    const end = new Date(e.end_ts);
    return {
      start: [start.getFullYear(), start.getMonth() + 1, start.getDate(), start.getHours(), start.getMinutes()],
      end: [end.getFullYear(), end.getMonth() + 1, end.getDate(), end.getHours(), end.getMinutes()],
      title: e.title,
      description: e.description || '',
      location: e.location || '',
      uid: e.id,
      status: e.status === 'canceled' ? 'CANCELLED' : 'CONFIRMED',
    };
  });

  return new Promise((resolve, reject) => {
    ics.createEvents(icsEvents, (error, value) => {
      if (error) return reject(error);
      resolve(value);
    });
  });
}
