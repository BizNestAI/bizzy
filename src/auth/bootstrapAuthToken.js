// src/auth/bootstrapAuthToken.js
import { createClient } from '@supabase/supabase-js';
import { normalizeSupabaseProjectUrl } from '../services/authUrlConfig.js';

export const supabase = createClient(
  normalizeSupabaseProjectUrl(import.meta.env.VITE_SUPABASE_URL),
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage:
        typeof window !== 'undefined' && window.sessionStorage
          ? window.sessionStorage
          : undefined,
    },
  }
);

export async function bootstrapAuthToken() {
  // Keep legacy localStorage token state cleared. API calls should read the
  // current sessionStorage-backed Supabase session instead of persisted tokens.
  localStorage.removeItem('access_token');
  supabase.auth.onAuthStateChange((_event, session) => {
    if (!session?.access_token) {
      localStorage.removeItem('access_token');
    }
  });
}
