import { db } from './db.js';

/**
 * Run every 5 minutes: find reminders whose time window hit relative to event.start_ts.
 * Enqueue in‑app/email/SMS notifications via your notifications system.
 */
export async function runReminderSweep(nowISO = new Date().toISOString()) {
  // 1) Join reminders+events and compute due offsets server-side if you prefer.
  // 2) For simplicity, we pull upcoming events and calculate in JS here (OK for MVP).
  const upcoming = await db.query('calendar_reminders', {}); // Replace with a proper join on events
  // Pseudo: get events and compute if (event.start_ts + offset_str) <= now
  // When due → enqueue notifications and mark as sent. Left as an exercise since your notif system is custom.
  return upcoming.length;
}
