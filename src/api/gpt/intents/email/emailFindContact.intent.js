// src/api/gpt/brain/intents/email/emailFindContact.intent.js
import { supabase as serverSB } from '../../../../services/supabaseAdmin.js';

export const key = 'email_find_contact';

export function test(t = '') {
  const s = String(t).toLowerCase();
  return /\b(last|recent)\b.*\b(email|thread|message)\b.*\b(from|with)\b/.test(s)
      || /\bshow\b.*\b(from:|contact)\b/i.test(s);
}

export function cacheKey(ctx) {
  const uid = ctx?.user_id || '';
  const acct = ctx?.hint?.accountId || '';
  const raw = (ctx?.message || '').trim().toLowerCase().slice(0, 80);
  return `email:contact:${uid}:${acct}:${raw}`;
}

function parseEmailFromMessage(text = '') {
  const mail = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return mail ? mail[0] : '';
}

export async function recipe(ctx) {
  const sb = ctx?.supabase || serverSB;
  const user_id = ctx?.user_id;
  const accountId = ctx?.hint?.accountId || null;
  if (!sb || !user_id) return {};

  // Try to grab an explicit email from the message; otherwise rely on hint.fromEmail or leave blank
  const hintedEmail = ctx?.hint?.fromEmail || parseEmailFromMessage(ctx?.message || '');
  const likeEmail = hintedEmail ? `%${hintedEmail}%` : null;

  let q = sb
    .from('email_threads_cache')
    .select('thread_id,subject,snippet,from_name,from_email,last_message_ts,labels,unread,account_id')
    .eq('user_id', user_id)
    .order('last_message_ts', { ascending: false })
    .limit(50);

  if (accountId) q = q.eq('account_id', accountId);
  if (likeEmail) q = q.ilike('from_email', likeEmail);

  const { data, error } = await q;
  const inbound = (error ? [] : (data || [])).map(r => ({
    threadId: r.thread_id,
    subject: r.subject || '',
    from_name: r.from_name || '',
    from_email: r.from_email || '',
    snippet: r.snippet || '',
    date: r.last_message_ts || '',
    unread: !!r.unread,
    accountId: r.account_id,
  })).slice(0, 10);

  // Recent outbound by contact (from activity log)
  let out = [];
  if (hintedEmail) {
    const { data: sent } = await sb
      .from('email_activity_log')
      .select('payload,created_at,account_id')
      .eq('user_id', user_id)
      .eq('action', 'email_sent')
      .order('created_at', { ascending: false })
      .limit(100);

    out = (sent || [])
      .filter(r => String(r?.payload?.to || '').toLowerCase().includes(hintedEmail.toLowerCase()))
      .slice(0, 10)
      .map(r => ({
        subject: r.payload?.subject || '',
        date: r.created_at || '',
        accountId: r.account_id,
      }));
  }

  return {
    email: {
      contact: { email: hintedEmail || '' },
      inboundRecent: inbound,
      outboundRecent: out,
    }
  };
}
