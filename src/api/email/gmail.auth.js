// src/api/email/gmail.auth.js
import { getOAuth2Client, saveAccountTokens, decryptTokenBlob } from '../../services/google/googleClient.js';
import { google } from 'googleapis';
import crypto from 'crypto';
import { db } from '../../services/db.js';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify', // needed for mark-as-read, labels
];

const APP_BASE = process.env.APP_BASE_URL || 'http://localhost:5173';
const STATE_SECRET = process.env.STATE_SECRET || process.env.ENCRYPTION_KEY || 'state-secret';

// HMAC sign/verify of state JSON
function signState(payload) {
  const json = JSON.stringify(payload);
  const h = crypto.createHmac('sha256', STATE_SECRET).update(json).digest('hex');
  return Buffer.from(JSON.stringify({ json, h }), 'utf8').toString('base64url');
}
function verifyState(b64) {
  const { json, h } = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  const check = crypto.createHmac('sha256', STATE_SECRET).update(json).digest('hex');
  if (check !== h) throw new Error('Invalid OAuth state');
  return JSON.parse(json);
}

export async function connect(req, res) {
  try {
    const userId = req.user.id; // set by your auth middleware
    const businessId = req.query.business_id || null;

    const oauth2Client = getOAuth2Client();
    const state = signState({
      userId,
      businessId,
      nonce: crypto.randomBytes(12).toString('hex'),
      ts: Date.now(),
    });

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: GMAIL_SCOPES,
      prompt: 'consent',
      include_granted_scopes: true,
      state,
    });
    return res.json({ url });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create OAuth URL' });
  }
}

export async function callback(req, res) {
  try {
    const { code, state } = req.query;
    const { userId, businessId } = verifyState(state);
    const oauth2Client = getOAuth2Client();

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Use Gmail API profile — works with gmail.* scopes
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const me = await gmail.users.getProfile({ userId: 'me' });
    const googleEmail = me.data.emailAddress;

    await saveAccountTokens({
      userId,
      googleEmail,
      tokens,
      scopes: GMAIL_SCOPES,
      businessId
    });

    return res.redirect(`${APP_BASE}/dashboard/email?connected=1`);
  } catch (e) {
    console.error(e);
    return res.redirect(`${APP_BASE}/dashboard/email?error=oauth_failed`);
  }
}

export async function disconnect(req, res) {
  try {
    const userId = req.user.id;
    const { accountId } = req.body;

    const { data: secret } = await db
      .from('email_account_secrets')
      .select('token_blob')
      .eq('account_id', accountId)
      .single();

    // Revoke access token if we have one
    if (secret?.token_blob) {
      try {
        const tokens = decryptTokenBlob(secret.token_blob);
        if (tokens?.access_token) {
          const oauth2Client = getOAuth2Client();
          await oauth2Client.revokeToken(tokens.access_token);
        }
      } catch (err) {
        console.warn('[disconnect] token decrypt/revoke issue:', err?.message || err);
      }
    }

    await db.from('email_account_secrets').delete().eq('account_id', accountId);
    await db.from('email_accounts').delete().eq('id', accountId).eq('user_id', userId);
    await db.from('email_threads_cache').delete().eq('account_id', accountId).eq('user_id', userId);
    await db.from('email_activity_log').delete().eq('account_id', accountId).eq('user_id', userId);

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to disconnect' });
  }
}
