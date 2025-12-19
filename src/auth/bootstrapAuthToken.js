// src/auth/bootstrapAuthToken.js
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export async function bootstrapAuthToken() {
  // pick up existing session (after refresh / redirect)
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    localStorage.setItem('access_token', session.access_token);
  }

  // keep it fresh on sign-in / refresh / sign-out
  supabase.auth.onAuthStateChange((_event, session) => {
    if (session?.access_token) {
      localStorage.setItem('access_token', session.access_token);
    } else {
      localStorage.removeItem('access_token');
    }
  });
}
