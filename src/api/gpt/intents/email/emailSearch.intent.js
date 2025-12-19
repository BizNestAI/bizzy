// src/api/gpt/brain/intents/email/emailSearch.intent.js
import { supabase as serverSB } from '../../../../services/supabaseAdmin.js';

export const key = 'email_search';

export function test(t = '') {
  const s = String(t).toLowerCase();
  // find|show|search ... (emails|inbox|threads), includes quick filters
  return /\b(find|show|search)\b.*\b(email|emails|inbox|thread|threads)\b/.test(s)
    || /\bfrom:|subject:|label:|before:|after:/i.test(s);
}

export function cacheKey(ctx) {
  // cache on user + normalized query plus optional account
  const uid = ctx?.user_id || '';
  const acct = ctx?.hint?.accountId || '';
  const raw = (ctx?.message || '').trim().toLowerCase().slice(0, 120);
  return `email:search:${uid}:${acct}:${raw}`;
}

// tiny parser for inline filters like: "find emails from:john subject:invoice after:2025-09-01 before:2025-10-01"
function parseInlineFilters(text = '') {
  const q = text;
  const mFrom = q.match(/from:([^\s]+)/i);
  const mSubject = q.match(/subject:([^\s].*?)(?=\s+\w+:|$)/i);
  const mLabel = q.match(/label:([^\s]+)/i);
  const mAfter = q.match(/after:(\d{4}-\d{2}-\d{2})/i);
  const mBefore = q.match(/before:(\d{4}-\d{2}-\d{2})/i);

  // free text (minus the explicit filters)
  const stripped = q
    .replace(/from:[^\s]+/ig, '')
    .replace(/subject:[^\s].*?(?=\s+\w+:|$)/ig, '')
    .replace(/label:[^\s]+/ig, '')
    .replace(/after:\d{4}-\d{2}-\d{2}/ig, '')
    .replace(/before:\d{4}-\d{2}-\d{2}/ig, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    text: stripped || '',
    from: mFrom?.[1] || '',
    subject: (mSubject?.[1] || '').trim(),
    label: mLabel?.[1] || '',
    after: mAfter?.[1] || '',
    before: mBefore?.[1] || '',
  };
}

export async function recipe(ctx) {
  const sb = ctx?.supabase || serverSB;
  const user_id = ctx?.user_id;
  const accountId = ctx?.hint?.accountId || null;
  if (!sb || !user_id) return {};

  const filters = parseInlineFilters(ctx?.message || '');
  const likeQ = (filters.text || '').slice(0, 120);

  let q = sb
    .from('email_threads_cache')
    .select('thread_id,subject,snippet,from_name,from_email,last_message_ts,labels,unread,account_id')
    .eq('user_id', user_id)
    .order('last_message_ts', { ascending: false })
    .limit(50);

  if (accountId) q = q.eq('account_id', accountId);
  if (filters.from) q = q.ilike('from_email', `%${filters.from}%`);
  if (filters.subject) q = q.ilike('subject', `%${filters.subject}%`);
  if (filters.label) q = q.contains('labels', [filters.label.toUpperCase()]);
  if (filters.after) q = q.gte('last_message_ts', filters.after);
  if (filters.before) q = q.lte('last_message_ts', filters.before);
  if (likeQ) {
    // subject or snippet fuzzy match
    q = q.or(`subject.ilike.%${likeQ}%,snippet.ilike.%${likeQ}%`);
  }

  const { data, error } = await q;
  const results = (error ? [] : (data || [])).map(r => ({
    threadId: r.thread_id,
    subject: r.subject || '',
    from_name: r.from_name || '',
    from_email: r.from_email || '',
    snippet: r.snippet || '',
    date: r.last_message_ts || '',
    labels: r.labels || [],
    unread: !!r.unread,
    accountId: r.account_id,
  })).slice(0, 25);

  return {
    email: {
      search: {
        filters,
        results
      }
    }
  };
}
