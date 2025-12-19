export const key = 'calendar_schedule';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(schedule|book|add to calendar|remind)\b/.test(s);
}

export async function recipe({ business_id }) {
  // The LLM will parse natural language; we only pass module tag + defaults
  return { calendarDefaults: { business_id, module: 'ops' } };
}
