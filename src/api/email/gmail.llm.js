// src/api/email/gmail.llm.js
import { db } from '../../services/db.js';
import { getThread } from './gmail.service.js';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// crude but effective guards
const MAX_MSGS = 8;
const MAX_CHARS_PER_MSG = 4000;

function stripHtml(html = '') {
  return html.replace(/<[^>]+>/g, ' ');
}
function redactPII(s = '') {
  return s
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[redacted-email]')
    .replace(/\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[redacted-phone]');
}
function clamp(s = '', n = MAX_CHARS_PER_MSG) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export async function draftWithBizzy({ userId, accountId, threadId, prompt = '', tone = 'professional' }) {
  const thread = await getThread({ userId, accountId, threadId });
  const lastMsgs = (thread.messages || [])
    .slice(-MAX_MSGS)
    .map(m => ({
      role: 'user',
      content: clamp(
        redactPII(`From: ${m.from}\nSubject: ${m.subject}\nBody:\n${m.text || stripHtml(m.html) || ''}`)
      ),
    }));

  const sys = `
You are Bizzi, an AI co-founder for construction/home service founders.
Write concise, professional emails in plain English. Be polite, direct, and helpful.
Tone: ${tone}.
If scheduling, propose specific time slots. If payment/invoice, be clear and include amounts if provided.
`;

  const user = `
${prompt ? `User instruction: ${prompt}\n` : ''}
Write a reply to the most recent message in this thread. Include a friendly sign-off.
`;

  let body = '';
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: sys }, ...lastMsgs, { role: 'user', content: user }],
      temperature: 0.4,
    });
    body = completion?.choices?.[0]?.message?.content?.trim() || '';
  } catch (err) {
    console.error('[draftWithBizzy] OpenAI error:', err?.message || err);
  }

  if (!body) {
    body = `Hi there,

Thanks for reaching out. (Auto-draft failed to generate a response. Please edit and send.)

Best regards,
Bizzy`;
  }

  await db.from('email_activity_log').insert({
    user_id: userId,
    account_id: accountId,
    thread_id: threadId,
    action: 'draft_generated',
    payload: { body, tone, prompt }
  });

  return { body };
}

export async function summarizeThreadWithBizzy({ userId, accountId, threadId }) {
  const thread = await getThread({ userId, accountId, threadId });
  const lastMsgs = (thread.messages || [])
    .slice(-MAX_MSGS)
    .map(m => ({
      role: 'user',
      content: clamp(
        redactPII(`From: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\nBody:\n${m.text || stripHtml(m.html) || ''}`)
      ),
    }));

  const sys = `
You are Bizzy. Summarize email threads for a busy contractor.
Use 3-5 bullet points and end with one suggested next action.
`;

  let summary = '';
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: sys }, ...lastMsgs, { role: 'user', content: 'Summarize this thread.' }],
      temperature: 0.2,
    });
    summary = completion?.choices?.[0]?.message?.content?.trim() || '';
  } catch (err) {
    console.error('[summarizeThreadWithBizzy] OpenAI error:', err?.message || err);
  }

  if (!summary) {
    summary = `• Summary unavailable.\n• Try again in a moment.\n\nNext action: Open the thread and reply.`;
  }

  return { summary };
}
