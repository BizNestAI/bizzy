// src/api/email/email.classifier.js
export function classifyEmail({ subject = '', body = '' }) {
  const s = `${subject} ${body}`.toLowerCase();
  if (/invoice|payment|paid|balance|amount/.test(s)) return 'invoice';
  if (/estimate|quote|bid/.test(s)) return 'estimate';
  if (/schedule|reschedule|availability|time slot|meeting/.test(s)) return 'scheduling';
  if (/attachment|attach|missing file|pdf/.test(s)) return 'attachment';
  if (/review|rating|google|feedback/.test(s)) return 'review';
  return 'general';
}
