// src/api/gpt/brain/intents/email/emailExtractTasks.intent.js
import { getThread } from '../../../email/gmail.service.js';

export const key = 'email_extract_tasks';

export function test(t = '') {
  const s = String(t).toLowerCase();
  return /\b(action items?|tasks?|todos?)\b.*\b(email|thread|inbox|this)\b/.test(s);
}

export function cacheKey(ctx) {
  const tid = ctx?.hint?.threadId || '';
  const uid = ctx?.user_id || '';
  return tid ? `email:tasks:${uid}:${tid}` : null;
}

export async function recipe(ctx) {
  const { user_id, hint } = ctx || {};
  const accountId = hint?.accountId;
  const threadId = hint?.threadId;
  if (!user_id || !accountId || !threadId) return {};

  const t = await getThread({ userId: user_id, accountId, threadId });

  const lastMessages = (t?.messages || [])
    .slice(-8)
    .map(m => ({
      from: m.from || '',
      date: m.date || '',
      subject: m.subject || '',
      body: (m.text || stripHtml(m.html || '')).replace(/\s+/g, ' ').trim().slice(0, 2000),
    }));

  const subject = (t?.messages?.[t.messages.length - 1]?.subject) || t?.messages?.[0]?.subject || '(no subject)';

  return {
    email: {
      threadId,
      accountId,
      subject,
      lastMessages
      // LLM layer should produce: { tasks: [{title, owner?, due?, note?}], next_action? }
    }
  };
}

function stripHtml(html = '') { return html.replace(/<[^>]+>/g, ' '); }
