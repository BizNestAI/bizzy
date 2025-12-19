// src/gpt/intents/email/emailSummarize.intent.js
import OpenAI from 'openai';
import { getThread } from '../../../email/gmail.service.js';
import { db } from '../../../../services/calendar/db.js'; // for neighbor lookups if needed

export const key = 'email_summarize';

// Light keyword test; attachIntent adds route/message bias
export function test(t = '') {
  const s = String(t).toLowerCase();
  return /\b(tl;dr|summarize|summary|what.?s this about|what is this about)\b/.test(s);
}

// Optional cache key for attachContext cache
export function cacheKey(ctx) {
  const tid = ctx?.hint?.threadId || '';
  const uid = ctx?.user_id || '';
  return tid ? `email:summary:${uid}:${tid}` : null;
}

/**
 * Recipe returns compact email bundle:
 * { email: { accountId, threadId, subject, participants, lastMessages[], contact, inboundRecent[], outboundRecent[], attachmentsHint[] } }
 */
export async function recipe(ctx) {
  const { user_id, supabase, hint } = ctx || {};
  const accountId = hint?.accountId;
  const threadId = hint?.threadId;
  if (!user_id || !accountId || !threadId) return {};

  // Load target thread (full normalize happens in service)
  const t = await getThread({ userId: user_id, accountId, threadId });

  // Build compact last messages slice (text-only)
  const lastMessages = (t?.messages || [])
    .slice(-8)
    .map(m => ({
      from: m.from || '',
      date: m.date || '',
      subject: m.subject || '',
      body: (m.text || stripHtml(m.html || '')).replace(/\s+/g, ' ').trim().slice(0, 2000),
    }));

  // Participants & subject
  const last = t?.messages?.[t.messages.length - 1] || {};
  const participants = {
    from: last.from || '',
    to: last.to || '',
    cc: last.cc || '',
  };
  const subject = last.subject || (t?.messages?.[0]?.subject || '(no subject)');

  // Contact extraction (simple)
  const contactEmail = parseEmail(participants.from);
  const contactDomain = contactEmail?.split('@')[1] || '';

  // Neighbor context (very light): recent inbound/outbound snippets for this account/contact
  const inboundRecent = await fetchRecentInbound({ supabase, user_id, accountId, contactEmail, limit: 3 });
  const outboundRecent = await fetchRecentOutbound({ supabase, user_id, accountId, contactEmail, limit: 3 });

  const attachmentsHint = (t?.messages || [])
    .flatMap(m => m.attachments || [])
    .slice(-5)
    .map(a => a.filename)
    .filter(Boolean);

  return {
    email: {
      accountId,
      threadId,
      subject,
      participants,
      contact: { email: contactEmail, domain: contactDomain },
      lastMessages,
      inboundRecent,
      outboundRecent,
      attachmentsHint,
    }
  };
}

// === Existing executor (kept, now benefits from richer context when called standalone) ===
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
export async function emailSummarizeIntent({ userId, accountId, threadId }) {
  const thread = await getThread({ userId, accountId, threadId });
  const lastMsgs = thread.messages.slice(-8).map(m => ({
    role: 'user',
    content: `From: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.text || stripHtml(m.html) || ''}`
  }));

  const sys = `
You are Bizzy. Summarize this email thread for a busy contractor owner.
Return 3–5 bullets (plain text) and one suggested next action.
`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'system', content: sys }, ...lastMsgs, { role: 'user', content: 'Summarize this thread.' }],
    temperature: 0.2,
  });

  const summary = completion.choices[0].message.content.trim();
  return { summary };
}

// --- helpers ---
function stripHtml(html = '') { return html.replace(/<[^>]+>/g, ' '); }
function parseEmail(from = '') { const m = String(from).match(/<([^>]+)>/); return m ? m[1] : from; }

// Supabase helpers against your cache/log tables (fail-soft)
async function fetchRecentInbound({ supabase, user_id, accountId, contactEmail, limit = 3 }) {
  if (!supabase || !contactEmail) return [];
  const { data, error } = await supabase
    .from('email_threads_cache')
    .select('subject,snippet,from_email,last_message_ts')
    .eq('user_id', user_id)
    .eq('account_id', accountId)
    .ilike('from_email', `%${contactEmail}%`)
    .order('last_message_ts', { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data || []).map(r => ({
    subject: r.subject || '',
    snippet: r.snippet || '',
    date: r.last_message_ts || ''
  }));
}

async function fetchRecentOutbound({ supabase, user_id, accountId, contactEmail, limit = 3 }) {
  if (!supabase || !contactEmail) return [];
  const { data, error } = await supabase
    .from('email_activity_log')
    .select('payload,created_at')
    .eq('user_id', user_id)
    .eq('account_id', accountId)
    .eq('action', 'email_sent')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return [];
  const rows = (data || [])
    .map(r => ({ ...r, to: r.payload?.to || '' }))
    .filter(r => String(r.to).toLowerCase().includes(contactEmail.toLowerCase()))
    .slice(0, limit)
    .map(r => ({
      subject: r.payload?.subject || '',
      snippet: '', // keep light
      date: r.created_at || ''
    }));
  return rows;
}
