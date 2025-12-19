// src/api/gpt/brain/intents/email/emailFollowup.intent.js
import { getThread } from '../../../email/gmail.service.js';

export const key = 'email_followup';

export function test(t = '') {
  const s = String(t).toLowerCase();
  return /\bfollow[- ]?up\b/.test(s);
}

export function cacheKey(ctx) {
  const tid = ctx?.hint?.threadId || '';
  const uid = ctx?.user_id || '';
  const when = (ctx?.message || '').toLowerCase().slice(0, 40);
  return tid ? `email:followup:${uid}:${tid}:${when}` : null;
}

// very small "when" hint extractor: today|tomorrow|next <weekday>|in <N> (days|weeks)
function extractWhenHint(text = '') {
  const s = text.toLowerCase();
  const simple = s.match(/\b(today|tomorrow|next\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*)\b/);
  const inN = s.match(/\bin\s+(\d{1,2})\s+(day|days|week|weeks)\b/);
  if (simple) return simple[0];
  if (inN) return inN[0];
  const date = s.match(/\b\d{4}-\d{2}-\d{2}\b/);
  return date ? date[0] : '';
}

export async function recipe(ctx) {
  const { user_id, hint, message } = ctx || {};
  const accountId = hint?.accountId;
  const threadId = hint?.threadId;
  if (!user_id || !accountId || !threadId) return {};

  const whenHint = extractWhenHint(message || '');

  const t = await getThread({ userId: user_id, accountId, threadId });
  const last = t?.messages?.[t.messages.length - 1] || {};
  const contactEmail = parseEmail(last.from || '');

  return {
    email: {
      threadId,
      accountId,
      contact: { email: contactEmail },
      whenHint,                     // e.g., "next Tuesday", "in 2 days", "2025-10-18"
      subject: last.subject || t?.messages?.[0]?.subject || '(no subject)',
      lastMessageText: (last.text || stripHtml(last.html || '')).slice(0, 2000)
      // LLM can produce: follow-up draft OR calendar event with start time & attendees
    }
  };
}

function stripHtml(html = '') { return html.replace(/<[^>]+>/g, ' '); }
function parseEmail(from = '') { const m = String(from).match(/<([^>]+)>/); return m ? m[1] : from; }
