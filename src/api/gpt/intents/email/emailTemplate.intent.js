// src/gpt/intents/email/emailTemplate.intent.js
import { applyTemplate } from '../../../../api/email/email.templates.js'; // adjust if needed
import { getThread } from '../../../email/gmail.service.js';

export const key = 'email_template';

export function test(t = '') {
  const s = String(t).toLowerCase();
  return /\b(template|payment reminder|estimate follow[- ]?up|scheduling(?:\s+email)?|follow[- ]?up)\b/.test(s);
}

export function cacheKey(ctx) {
  const tid = ctx?.hint?.threadId || '';
  const uid = ctx?.user_id || '';
  return tid ? `email:template:${uid}:${tid}` : null;
}

export async function recipe(ctx) {
  const { user_id, hint } = ctx || {};
  const accountId = hint?.accountId;
  const threadId = hint?.threadId;
  if (!user_id || !accountId || !threadId) return {};
  // Minimal bundle—template selection usually doesn’t need neighbor emails
  const t = await getThread({ userId: user_id, accountId, threadId });
  const last = t?.messages?.[t.messages.length - 1] || {};
  return {
    email: {
      accountId,
      threadId,
      subject: last.subject || t?.messages?.[0]?.subject || '(no subject)',
      participants: { from: last.from || '', to: last.to || '', cc: last.cc || '' },
      lastMessageText: (last.text || (last.html || '').replace(/<[^>]+>/g, ' ')).slice(0, 2000),
    }
  };
}

// (Optional) a small runner you can call directly if you want to produce a draft from a named template
export async function emailTemplateIntent({ name, vars = {} }) {
  // Delegates to your existing email.templates.js
  const { subject, body } = applyTemplate(name, vars);
  return { subject, body };
}
