// File: /src/services/supabaseAdmin.js
// Server-only Supabase client (service role). If imported in the browser, it
// returns a safe stub so your UI won't crash accidentally.
//
// Usage (server files only):
//   import { supabase } from '../services/supabaseAdmin.js';
//   const { data, error } = await supabase.from('my_table').select('*');

import { createClient } from '@supabase/supabase-js';

// ──────────────────────────────────────────────────────────────────────────────
// Environment detection
// ──────────────────────────────────────────────────────────────────────────────
const isBrowser = typeof window !== 'undefined';

// ──────────────────────────────────────────────────────────────────────────────
function makeBrowserStub() {
  const err = new Error(
    'supabaseAdmin (service role) is server-only. Import supabaseClient.js on the client.'
  );
  const chain = {
    select: async () => ({ data: null, error: err }),
    insert: async () => ({ data: null, error: err }),
    update: async () => ({ data: null, error: err }),
    upsert: async () => ({ data: null, error: err }),
    delete: async () => ({ data: null, error: err }),
    // query modifiers – return self so chaining doesn't explode
    eq() { return this; }, neq() { return this; }, gte() { return this; }, lte() { return this; },
    ilike() { return this; }, in() { return this; }, order() { return this; }, range() { return this; },
    single() { return this; }, limit() { return this; },
  };
  return {
    from() { return chain; },
    schema() { return this; },
    rpc: async () => ({ data: null, error: err }),
    auth: { getUser: async () => ({ data: null, error: err }) },
    _stub: true,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Build a single server-side admin client
// ──────────────────────────────────────────────────────────────────────────────
function buildAdminClient() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL || // optional fallback if reused envs
    '';

  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY || // common alt name
    '';

  if (!url || !serviceKey) {
    throw new Error(
      'Supabase admin missing env. Expected SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    );
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'X-Client-Info': 'bizzy-admin/1.0' } },
  });
}

// Singleton holder (avoid "Identifier has already been declared" issues)
let adminClientSingleton = null;

// Public accessor used across the codebase
export function getAdminClient() {
  if (isBrowser) return makeBrowserStub();
  if (adminClientSingleton) return adminClientSingleton;
  adminClientSingleton = buildAdminClient();
  return adminClientSingleton;
}

// Named/default export
export const supabase = getAdminClient();
export const adminClient = supabase;   // optional alias
export default supabase;

// Optional helpers
export function assertServer() {
  if (isBrowser) throw new Error('This function may only be called on the server.');
}
export function withSchema(schema = 'public') {
  assertServer();
  return supabase.schema(schema);
}
