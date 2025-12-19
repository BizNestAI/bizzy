import dayjs from 'dayjs';

/** Very light parser; replace with chrono-node or GPT later */
export async function parseQuickCreate(input, defaults = {}) {
  const draft = {
    business_id: defaults.business_id,
    user_id: defaults.user_id,
    module: inferModule(input) || defaults.module || 'ops',
    type: inferType(input) || 'task',
    title: inferTitle(input) || 'New event',
    start: inferStart(input),
    end: inferEnd(input),
    all_day: false,
    reminders: inferReminders(input),
  };

  const errors = [];
  if (!draft.start || !draft.end) errors.push('Could not infer a valid time range');
  if (!draft.title) errors.push('Could not infer title');

  return errors.length ? { ok: false, errors } : { ok: true, intent: 'create_event', draft };
}

function inferTitle(s) {
  const m = s.match(/^(job|post|email|invoice|meeting|deadline)\s*:\s*(.+)$/i);
  if (m) return m[2].trim();
  return s.trim();
}
function inferModule(s) {
  if (/tax|deadline/i.test(s)) return 'tax';
  if (/post|email|newsletter|campaign/i.test(s)) return 'marketing';
  if (/invoice|payroll|p&l|profit/i.test(s)) return 'financials';
  if (/ira|401|hsa|rebalance|portfolio/i.test(s)) return 'investments';
  return null;
}
function inferType(s) {
  if (/job/i.test(s)) return 'job';
  if (/lead/i.test(s)) return 'lead';
  if (/post/i.test(s)) return 'post';
  if (/email/i.test(s)) return 'email';
  if (/invoice/i.test(s)) return 'invoice';
  if (/deadline|tax/i.test(s)) return 'deadline';
  if (/meeting|call/i.test(s)) return 'meeting';
  return 'task';
}
function inferStart(s) {
  // naive: today at 9am if no time given
  return dayjs().add(1, 'hour').startOf('hour').toISOString();
}
function inferEnd(s) {
  return dayjs(inferStart(s)).add(1, 'hour').toISOString();
}
function inferReminders(s) {
  const arr = [];
  if (/\bremind\b.*7d/i.test(s)) arr.push({ offset_str: '-7d', channel: 'inapp' });
  if (/\bremind\b.*2d/i.test(s)) arr.push({ offset_str: '-2d', channel: 'inapp' });
  return arr;
}
