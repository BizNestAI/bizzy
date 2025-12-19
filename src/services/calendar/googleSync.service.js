// Two-way Google Calendar sync (skeleton)
export async function syncGoogleCalendar({ business_id, user_id }) {
  // 1) get tokens for user (oauth_tokens table)
  // 2) pull Google events -> upsert into calendar_events
  // 3) push Bizzy changes -> Google
  // 4) handle deleted/updated conflicts
  return { pulled: 0, pushed: 0 };
}
