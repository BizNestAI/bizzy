// /src/services/authService.js
import { supabase } from './supabaseClient.js';
import { apiFetch } from '../utils/apiBase.js';
import { getAuthRedirectTo, normalizeSupabaseProjectUrl } from './authUrlConfig.js';
import { clearStoredAuthAndBusinessState } from './authSessionCleanup.js';

/* -----------------------------------------------------------
   Env helpers (frontend)
----------------------------------------------------------- */
function getEnv() {
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
  const url = normalizeSupabaseProjectUrl(env.VITE_SUPABASE_URL);
  const anon = (env.VITE_SUPABASE_ANON_KEY || '').trim();
  if (!url || !anon) {
    throw new Error(
      '[authService] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
      'Add them to .env/.env.local and restart the dev server.'
    );
  }
  return { url, anon };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isExistingUserSignupResponse(data) {
  const identities = data?.user?.identities;
  return Array.isArray(identities) && identities.length === 0;
}

function isAlreadyRegisteredError(error) {
  return /already registered|already exists|user already/i.test(error?.message || '');
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function getSignupConfirmationStatus(email, redirectTo) {
  try {
    const res = await apiFetch('/api/auth/signup-confirmation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, redirectTo }),
      timeoutMs: 10000,
    });
    const json = await readJson(res);

    if (res.status === 409) {
      throw new Error(
        json?.message ||
          'This email already has a verified Bizzi account. Log in or reset your password.'
      );
    }
    if (res.status === 429) {
      throw new Error(
        json?.message ||
          'A confirmation email was already sent recently. Wait a minute and try again.'
      );
    }
    if (!res.ok) {
      throw new Error(json?.message || json?.error || 'Could not verify signup status.');
    }

    return json || { status: 'unknown' };
  } catch (error) {
    const isDev = Boolean(
      typeof import.meta !== 'undefined' && import.meta.env?.DEV
    );
    if (isDev) {
      console.warn('[authService] signup confirmation preflight failed:', error);
      return { status: 'unknown' };
    }
    throw error;
  }
}

export async function resendSignupConfirmation(email) {
  const normalizedEmail = normalizeEmail(email);
  const confirmationStatus = await getSignupConfirmationStatus(
    normalizedEmail,
    getAuthRedirectTo('/auth/confirm')
  );

  if (confirmationStatus.status === 'resent') {
    return confirmationStatus;
  }
  if (confirmationStatus.status === 'new') {
    throw new Error('No pending Bizzi account was found for that email.');
  }

  throw new Error(
    confirmationStatus.message || 'Could not send confirmation email.'
  );
}

export async function signUp(email, password, names = {}) {
  const normalizedEmail = normalizeEmail(email);
  clearStoredAuthAndBusinessState();
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    // Local stale auth/business state has already been cleared.
  }

  const first_name = (names?.firstName || "").trim();
  const last_name = (names?.lastName || "").trim();
  const full_name = [first_name, last_name].filter(Boolean).join(" ") || null;
  const redirectTo = getAuthRedirectTo('/auth/confirm');
  const confirmationStatus = await getSignupConfirmationStatus(
    normalizedEmail,
    redirectTo
  );

  if (confirmationStatus.status === 'resent') {
    return { user: null, session: null, confirmationResent: true };
  }

  // Seed auth metadata so future sessions carry the user's name
  const { data, error } = await supabase.auth.signUp({
    email: normalizedEmail,
    password,
    options: {
      emailRedirectTo: redirectTo,
      data: {
        first_name: first_name || null,
        last_name: last_name || null,
        full_name,
      },
    },
  });
  if (error) {
    if (isAlreadyRegisteredError(error)) {
      throw new Error(
        'This email is already registered. Log in or reset your password.'
      );
    }
    throw error;
  }

  if (isExistingUserSignupResponse(data)) {
    throw new Error(
      'This email is already registered. Log in or reset your password.'
    );
  }

  return data;
}

/* -----------------------------------------------------------
   Login — custom password grant (production-ready):
   1) POST /auth/v1/token?grant_type=password with anon key
   2) supabase.auth.setSession({ access_token, refresh_token })
   3) return hydrated session
----------------------------------------------------------- */
export async function login({ email, password }) {
  const { url, anon } = getEnv();

  const resp = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: anon,
      Authorization: `Bearer ${anon}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });

  const text = await resp.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  if (!resp.ok) {
    const msg = json?.error_description || json?.error || `Login failed (${resp.status})`;
    // Helpful hint if the anon key wasn’t sent
    if (resp.status === 400 && /No API key/i.test(text || '')) {
      console.error('[authService] Supabase rejected login: apikey missing. Check VITE_SUPABASE_* envs and restart.');
    }
    throw new Error(msg);
  }

  const { access_token, refresh_token } = json || {};
  if (!access_token || !refresh_token) throw new Error('Login response missing tokens.');

  // Hydrate supabase-js client so the rest of the app reads the session
  const { data: setData, error: setErr } = await supabase.auth.setSession({
    access_token,
    refresh_token,
  });
  if (setErr) throw setErr;

  return {
    user: setData?.user ?? json?.user ?? null,
    session: setData?.session ?? { access_token, refresh_token, token_type: 'bearer' },
  };
}

/* -----------------------------------------------------------
   Logout
----------------------------------------------------------- */
export async function logout() {
  try {
    await supabase.auth.signOut();
  } finally {
    clearStoredAuthAndBusinessState();
  }
}

/* -----------------------------------------------------------
   Reset password (kept via client SDK)
----------------------------------------------------------- */
export async function resetPassword(email) {
  const redirectTo =
    (typeof window !== 'undefined' && `${window.location.origin}/reset-password`) ||
    'http://localhost:5173/reset-password';

  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}
