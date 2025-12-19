// src/gpt/intents/email/emailReply.intent.js
import OpenAI from 'openai';
import { db } from '../../../../services/calendar/db.js';
import { getThread } from '../../../email/gmail.service.js';

export const key = 'email_reply';

export function test(t = '') {
  const s = String(t).toLowerCase();
  return /\b(reply|respond|write back|draft(?:\s+a)?\s+reply)\b/.test(s);
}

export function cacheKey(ctx) {
  const tid = ctx?.hint?.threadId || '';
  const uid = ctx?.user_id || '';
  return tid ? `email:reply:${uid}:${tid}` : null;
}

export async function recipe(ctx) {
  const { user_id, supabase, hint } = ctx || {};
  const accountId = hint?.accountId;
  const threadId = hint?.threadId;
  if (!user_id || !accountId || !threadId) return {};

  const t = await getThread({ userId: user_id, accountId, threadId });
  const lastMessages = (t?.messages || [])
    .slice(-6)
    .map(m => ({
      from: m.from || '',
      date: m.date || '',
      subject: m.subject || '',
      body: (m.text || stripHtml(m.html || '')).replace(/\s+/g, ' ').trim().slice(0, 2000),
    }));

  const last = t?.messages?.[t.messages.length - 1] || {};
  const participants = { from: last.from || '', to: last.to || '', cc: last.cc || '' };
  const subject = last.subject || (t?.messages?.[0]?.subject || '(no subject)');

  return {
    email: {
      accountId,
      threadId,
      subject,
      participants,
      lastMessages,
    }
  };
}

// === existing executor ===
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function emailReplyIntent({
  userId,
  accountId,
  threadId,
  userPrompt = '',
  tone = 'professional',
  companyName = '',
  senderName = '',
}) {
  const thread = await getThread({ userId, accountId, threadId });
  const lastMsgs = thread.messages.slice(-6).map(m => ({
    role: 'user',
    content: `From: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.text || stripHtml(m.html) || ''}`
  }));

  const sys = `
You are Bizzy, an AI co-founder for construction/home service founders.
- Write short, clear, professional emails in plain English.
- Use an optimistic, respectful tone.
- If scheduling: propose 2–3 time slots.
- If payment/invoice: restate the amount and due date if known.
- Sign off as ${senderName || 'the team'} at ${companyName || 'our company'}.
`;

  const user = `
${userPrompt ? `User instruction: ${userPrompt}\n\n` : ''}
Write a reply to the most recent message in this thread.
Include a friendly sign-off.
`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'system', content: sys }, ...lastMsgs, { role: 'user', content: user }],
    temperature: 0.4,
  });

  const body = completion.choices[0].message.content.trim();

  await db.from('email_activity_log').insert({
    user_id: userId,
    account_id: accountId,
    thread_id: threadId,
    action: 'draft_generated',
    payload: { body, tone, userPrompt }
  });

  return { body };
}

function stripHtml(html = '') { return html.replace(/<[^>]+>/g, ' '); }
