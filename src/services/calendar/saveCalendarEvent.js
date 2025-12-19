// /src/services/calendar/saveCalendarEvent.js
import { createEvent } from './calendar.service.js';

/**
 * Save a calendar event from chat intent OR system seeding.
 */
export async function saveCalendarEvent({
  userId,
  businessId,
  title,
  date,
  end = null,
  type = 'deadline',
  module = 'tax',           // tax is default for our seeding; callers can override
  description = null,
  allDay = true,
  location = null,
  reminders = [],
  source = 'system',        // mark seeded items as 'system' by default
  status = 'scheduled',
  color = undefined,
  links = undefined,        // optional metadata bag your calendar.service supports
}) {
  try {
    if (!userId) throw new Error('Missing userId');
    if (!businessId) throw new Error('Missing businessId');
    if (!title) throw new Error('Missing title');
    if (!date) throw new Error('Missing date');
    if (!type) throw new Error('Missing type');

    // Normalize to ISO strings
    const startISO =
      typeof date === 'string' ? new Date(date).toISOString() : date.toISOString();

    const endISO = end
      ? (typeof end === 'string' ? new Date(end).toISOString() : end.toISOString())
      : new Date(new Date(startISO).getTime() + 60 * 60 * 1000).toISOString(); // +1h

    const draft = {
      user_id: userId,           // ⬅️ forward to calendar.service
      business_id: businessId,
      module,
      type,
      title,
      description,
      start: startISO,
      end: endISO,
      all_day: allDay,
      location,
      reminders,
      source,
      status,
      color,
      links,
    };

    const saved = await createEvent(draft);
    return { ...saved, persisted: true };
  } catch (err) {
    console.error('[saveCalendarEvent] error:', err);
    return { error: err.message, persisted: false };
  }
}

export default saveCalendarEvent;
