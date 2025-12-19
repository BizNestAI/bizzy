// Optional integrations – import jobs and create events
import { createEvent } from './calendar.service.js';

export async function importJobsFromServiceTitan({ business_id, user_id, token }) {
  // call ST API, map jobs -> calendar events (module 'ops', type 'job')
  // await createEvent({ ... })
  return { imported: 0 };
}

export async function importJobsFromJobber({ business_id, user_id, token }) {
  // same mapping logic
  return { imported: 0 };
}
