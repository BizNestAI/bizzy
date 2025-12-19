// src/api/email/gmail.service.js
import { db } from '../../services/db.js';
import { getAuthorizedGmail } from '../../services/google/googleClient.js';
import { gmailLabelsToTags } from '../../services/email/labelMap.js';
import { normalizeThreadSummary, normalizeThread } from './gmail.parse.js';

function b64url(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// List recent threads with minimal metadata; cache results
export async function listThreads({ userId, accountId, label = 'INBOX', q = '', pageToken = null, pageSize = 50 }) {
  const { gmail } = await getAuthorizedGmail({ userId, accountId });
  const query = q || '';

  const resp = await gmail.users.threads.list({
    userId: 'me',
    ...(label ? { labelIds: [label] } : {}),
    q: query,
    pageToken: pageToken || undefined,
    maxResults: Math.min(pageSize || 50, 100),
  });

  const threads = resp.data.threads || [];
  const detailed = await Promise.all(threads.map(async (t) => {
    const full = await gmail.users.threads.get({
  userId: 'me',
  id: t.id,
  format: 'metadata',
  metadataHeaders: ['From', 'Subject', 'Date'],
});
    const summary = normalizeThreadSummary(full.data);
    const firstLabels = full.data?.messages?.[0]?.labelIds || [];
    summary.labels = gmailLabelsToTags(firstLabels);
    summary.unread = summary.labels.includes('UNREAD');
    return summary;
  }));

  // Upsert into cache
  if (detailed.length) {
    const rows = detailed.map((d) => ({
      user_id: userId,
      account_id: accountId,
      thread_id: d.threadId,
      subject: d.subject,
      snippet: d.snippet,
      from_name: d.from_name,
      from_email: d.from_email,
      last_message_ts: d.last_message_ts,
      labels: d.labels, // text[]
      unread: d.unread,
      last_synced_at: new Date().toISOString(),
    }));
    const { error } = await db.from('email_threads_cache')
      .upsert(rows, { onConflict: 'account_id,thread_id' });
    if (error) console.error('cache upsert error', error);
  }

  return { items: detailed, nextPageToken: resp.data.nextPageToken || null };
}

export async function getThread({ userId, accountId, threadId }) {
  const { gmail } = await getAuthorizedGmail({ userId, accountId });
  const resp = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
  const normalized = normalizeThread(resp.data);
  return normalized;
}

export async function getAttachment({ userId, accountId, messageId, attachmentId }) {
  const { gmail } = await getAuthorizedGmail({ userId, accountId });
  const resp = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  const { data, size } = resp.data || {};
  const mimeType = resp.data?.mimeType || 'application/octet-stream';
  return { data, size, mimeType };
}

function createRawEmail({ to, cc, bcc, from, subject, body }) {
  const lines = [];
  if (to) lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  if (from) lines.push(`From: ${from}`);
  lines.push(`Subject: ${subject || ''}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: 7bit');
  lines.push('');
  lines.push(body || '');
  return b64url(lines.join('\r\n'));
}

export async function sendEmail({ userId, accountId, to, cc, bcc, subject, body, threadId = null }) {
  const { gmail, account } = await getAuthorizedGmail({ userId, accountId });
  const from = account.google_email; // allow Gmail to validate "From"
  const raw = createRawEmail({ to, cc, bcc, from, subject, body });

  const params = { userId: 'me', resource: { raw } };
  if (threadId) params.resource.threadId = threadId;

  const result = await gmail.users.messages.send(params);

  await db.from('email_activity_log').insert({
    user_id: userId,
    account_id: accountId,
    thread_id: threadId || null,
    message_id: result.data.id || null,
    action: 'email_sent',
    payload: { to, cc, bcc, subject }
  });

  return { id: result.data.id };
}

export async function markThreadRead({ userId, accountId, threadId }) {
  const { gmail } = await getAuthorizedGmail({ userId, accountId });
  await gmail.users.threads.modify({
    userId: 'me',
    id: threadId,
    resource: { removeLabelIds: ['UNREAD'] }
  });

  // Update cache without relying on db.sql array_remove
  const { data: row, error: selErr } = await db
    .from('email_threads_cache')
    .select('labels')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .eq('thread_id', threadId)
    .single();
  if (!selErr && row) {
    const newLabels = (row.labels || []).filter(l => l !== 'UNREAD');
    await db.from('email_threads_cache')
      .update({ unread: false, labels: newLabels, last_synced_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('account_id', accountId)
      .eq('thread_id', threadId);
  }

  await db.from('email_activity_log').insert({
    user_id: userId,
    account_id: accountId,
    thread_id: threadId,
    action: 'thread_mark_read',
    payload: {}
  });

  return { ok: true };
}
