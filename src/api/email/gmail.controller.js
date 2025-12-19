// src/api/email/gmail.controller.js
import { listThreads, getThread, sendEmail, markThreadRead, getAttachment } from './gmail.service.js';
import { draftWithBizzy, summarizeThreadWithBizzy } from './gmail.llm.js';
import { db } from '../../services/db.js';

export async function listThreadsHandler(req, res) {
  try {
    const userId = req.user.id;
    const accountId = req.query.accountId;
    const label = req.query.label || 'INBOX';
    const q = req.query.q || '';
    const pageToken = req.query.pageToken || null;
    const pageSize = Math.min(parseInt(req.query.pageSize || '50', 10), 100);
    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    const data = await listThreads({ userId, accountId, label, q, pageToken, pageSize });
    return res.json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list threads' });
  }
}

export async function getThreadHandler(req, res) {
  try {
    const userId = req.user.id;
    const accountId = req.query.accountId;
    const { threadId } = req.params;
    if (!accountId || !threadId) return res.status(400).json({ error: 'accountId and threadId required' });

    const data = await getThread({ userId, accountId, threadId });
    return res.json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to fetch thread' });
  }
}

export async function sendEmailHandler(req, res) {
  try {
    const userId = req.user.id;
    const { accountId, to, cc, bcc, subject, body, threadId } = req.body;
    if (!accountId || !to || !subject || !body) return res.status(400).json({ error: 'Missing fields' });

    const r = await sendEmail({ userId, accountId, to, cc, bcc, subject, body, threadId });
    return res.json(r);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to send email' });
  }
}

export async function draftWithBizzyHandler(req, res) {
  try {
    const userId = req.user.id;
    const { accountId, threadId, prompt, tone } = req.body;
    if (!accountId || !threadId) return res.status(400).json({ error: 'accountId and threadId required' });

    const data = await draftWithBizzy({ userId, accountId, threadId, prompt, tone });
    return res.json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to draft email' });
  }
}

export async function summarizeThreadHandler(req, res) {
  try {
    const userId = req.user.id;
    const { accountId, threadId } = req.body;
    if (!accountId || !threadId) return res.status(400).json({ error: 'accountId and threadId required' });

    const data = await summarizeThreadWithBizzy({ userId, accountId, threadId });
    return res.json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to summarize thread' });
  }
}

export async function markReadHandler(req, res) {
  try {
    const userId = req.user.id;
    const { accountId } = req.body;
    const { threadId } = req.params;
    if (!accountId || !threadId) return res.status(400).json({ error: 'accountId and threadId required' });

    const data = await markThreadRead({ userId, accountId, threadId });
    return res.json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to mark read' });
  }
}

export async function getAttachmentHandler(req, res) {
  try {
    const userId = req.user.id;
    const { threadId, messageId, attachmentId } = req.params;
    const { accountId } = req.query;
    if (!accountId || !threadId || !messageId || !attachmentId) {
      return res.status(400).json({ error: 'accountId, threadId, messageId, attachmentId required' });
    }
    const data = await getAttachment({ userId, accountId, messageId, attachmentId });
    return res.json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to fetch attachment' });
  }
}
