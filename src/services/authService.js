// /src/services/authService.js
import { supabase } from './supabaseClient.js';

/* -----------------------------------------------------------
   Env helpers (frontend)
----------------------------------------------------------- */
function getEnv() {
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
  const url = (env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anon = (env.VITE_SUPABASE_ANON_KEY || '').trim();
  if (!url || !anon) {
    throw new Error(
      '[authService] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
      'Add them to .env/.env.local and restart the dev server.'
    );
  }
  return { url, anon };
}

/* -----------------------------------------------------------
   Signup (kept via Supabase client SDK)
----------------------------------------------------------- */
export async function signUp(email, password, names = {}) {
  const first_name = (names?.firstName || "").trim();
  const last_name = (names?.lastName || "").trim();
  const full_name = [first_name, last_name].filter(Boolean).join(" ") || null;

  // Seed auth metadata so future sessions carry the user's name
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        first_name: first_name || null,
        last_name: last_name || null,
        full_name,
      },
    },
  });
  if (error) throw error;

  // Best-effort profile record; ensure names land in user_profiles
  const { data: existing } = await supabase
    .from('user_profiles')
    .select('first_name,last_name,email,role')
    .eq('id', data.user.id)
    .maybeSingle();

  const payload = {
    id: data.user.id,
    email,
    role: existing?.role || 'owner',
    first_name: first_name || existing?.first_name || null,
    last_name: last_name || existing?.last_name || null,
    full_name: full_name || existing?.full_name || null,
  };

  const { error: upsertError } = await supabase
    .from('user_profiles')
    .upsert(payload, { onConflict: 'id' });

  if (upsertError) {
    // Surface meaningful failure so we can alert the user on the frontend
    throw upsertError;
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
  await supabase.auth.signOut();
  localStorage.removeItem('currentBusinessId');
  localStorage.removeItem('isProfileComplete');
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
