// /src/services/supabaseClient.js
import { createClient } from '@supabase/supabase-js';

const isServer = typeof window === 'undefined';
if (isServer) {
  // If some server file imports this by mistake, fail clearly.
  throw new Error('supabaseClient.js is browser-only. Use supabaseAdmin.js on the server.');
}

// Prefer Vite env, fall back to the probe we set in index.html
const vite = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const injected = (typeof window !== 'undefined' && window.__VITE) || {};

const url =
  vite.VITE_SUPABASE_URL ??
  injected.VITE_SUPABASE_URL;

const anonKey =
  vite.VITE_SUPABASE_ANON_KEY ??
  injected.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error('[supabaseClient] Missing Supabase URL/key.', {
    hasViteUrl: !!vite.VITE_SUPABASE_URL,
    hasViteAnon: !!vite.VITE_SUPABASE_ANON_KEY,
    hasInjectedUrl: !!injected.VITE_SUPABASE_URL,
    hasInjectedAnon: !!injected.VITE_SUPABASE_ANON_KEY,
  });
  // Avoid hard-crashing the UI; your auth calls will fail visibly anyway.
}

// Create a single shared client
export const supabase = createClient(url, anonKey);
export default supabase;
