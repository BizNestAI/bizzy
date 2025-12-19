// /src/services/tax/calendarSync.js
import { saveCalendarEvent } from "../calendar/saveCalendarEvent.js"; // your existing helper

export async function syncTaxDeadlinesToCalendar({ businessId, year, quarterly }) {
  if (!businessId || !quarterly?.length) return;
  for (const q of quarterly) {
    try {
      await saveCalendarEvent({
        businessId,
        title: `${year} ${q.quarter} Estimated Tax Payment`,
        date: q.due,
        tags: ["tax", "deadline"],
        metadata: { type: "estimated_tax", quarter: q.quarter, year },
        // idempotency so duplicates aren't created
        idempotencyKey: `tax:${businessId}:${year}:${q.quarter}`,
      });
    } catch (e) {
      // non-fatal
      console.warn("[calendarSync] saveCalendarEvent warning:", e?.message || e);
    }
  }
}
