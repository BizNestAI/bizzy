// src/services/google/googleClient.js
import 'dotenv/config';
import crypto from 'crypto';
import { google } from 'googleapis';
import { db } from '../db.js'; // your Supabase server client

const ENC_ALGO = 'aes-256-gcm';

// Prefer a base64 key (32 bytes after decode) or a 32-char utf8 fallback.
function loadKey() {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (!raw) throw new Error('ENCRYPTION_KEY missing');
  // Try base64 first
  try {
    const k = Buffer.from(raw, 'base64');
    if (k.length === 32) return k;
  } catch { /* ignore */ }
  // Fallback to utf8
  const k = Buffer.from(raw, 'utf8');
  if (k.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes (use base64 or 32-char utf8).');
  }
  return k;
}

// Lazy init so we don't read env at import time if dotenv isn't loaded yet
let _ENC_KEY = null;
function getKey() {
  if (!_ENC_KEY) _ENC_KEY = loadKey();
  return _ENC_KEY;
}

function encrypt(json) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(json), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ENC_ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}
export function decryptTokenBlob(token_blob) {
  return decrypt(token_blob);
}

export function getOAuth2Client() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error('Google OAuth env vars missing');
  }
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

/**
 * Persist an account row and encrypted tokens.
 */
export async function saveAccountTokens({ userId, googleEmail, tokens, scopes, businessId = null }) {
  const payload = {
    user_id: userId,
    provider: 'gmail',
    google_email: googleEmail,
    scopes,
    business_id: businessId,
  };

  const { data: account, error } = await db
    .from('email_accounts')
    .upsert(payload, { onConflict: 'user_id,provider,google_email' })
    .select('*')
    .single();
  if (error) throw error;

  const enc = encrypt(tokens);
  const { error: updErr } = await db
    .from('email_accounts')
    .update({ token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null })
    .eq('id', account.id);
  if (updErr) throw updErr;

  const { error: secretsErr } = await db
    .from('email_account_secrets')
    .upsert({
      account_id: account.id,
      token_blob: enc,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'account_id' });
  if (secretsErr) throw secretsErr;

  return account;
}

/**
 * Load tokens for account and return an authorized Gmail client.
 * Will refresh tokens if expired and persist new tokens.
 */
export async function getAuthorizedGmail({ userId, accountId }) {
  const { data: account, error } = await db
    .from('email_accounts')
    .select('id, user_id, google_email')
    .eq('id', accountId)
    .single();
  if (error) throw error;
  if (account.user_id !== userId) throw new Error('Unauthorized');

  const { data: secret, error: secErr } = await db
    .from('email_account_secrets')
    .select('token_blob')
    .eq('account_id', accountId)
    .single();
  if (secErr) throw secErr;
  if (!secret?.token_blob) throw new Error('Missing token');

  const tokens = decrypt(secret.token_blob);
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(tokens);

  oauth2Client.on('tokens', async (newTokens) => {
    try {
      if (!newTokens || (!newTokens.access_token && !newTokens.refresh_token)) return;
      const merged = { ...tokens, ...newTokens };
      const enc = encrypt(merged);
      await db.from('email_account_secrets')
        .upsert({ account_id: accountId, token_blob: enc, updated_at: new Date().toISOString() });
      if (newTokens.expiry_date) {
        await db.from('email_accounts')
          .update({ token_expiry: new Date(newTokens.expiry_date) })
          .eq('id', accountId);
      }
    } catch (err) {
      console.error('[gmail tokens event] persist failed:', err);
    }
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  return { gmail, account };
}
