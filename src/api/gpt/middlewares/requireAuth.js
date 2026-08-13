// /src/middleware/requireAuth.js
import cookie from 'cookie';
import { createClient } from '@supabase/supabase-js';
import { createRemoteJWKSet, jwtVerify } from 'jose';

// ─────────────────────────────────────────────────────────────────────────────
// Env + Admin client
// ─────────────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL) throw new Error('[requireAuth] Missing SUPABASE_URL');

const supabaseAdmin = SERVICE_ROLE
  ? createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

if (!SERVICE_ROLE) {
  console.warn(
    '[requireAuth] Missing SUPABASE_SERVICE_ROLE_KEY — falling back to JWKS only.'
  );
}

const ISSUER = `${SUPABASE_URL}/auth/v1`;

// Some projects expose keys under /keys, some under /jwks
const JWKS_URLS = [
  new URL(`${SUPABASE_URL}/auth/v1/keys`),
  new URL(`${SUPABASE_URL}/auth/v1/jwks`),
];

// Cache for JOSE remote JWK set
let jwksSet = null;
let jwksSource = '';
let testDeps = null;

// Optional dev bypass (NEVER enable in prod)
const AUTH_BYPASS_REQUESTED = String(process.env.BIZZY_AUTH_BYPASS || '').toLowerCase() === 'true';
if (process.env.NODE_ENV === 'production' && AUTH_BYPASS_REQUESTED) {
  throw new Error('[requireAuth] BIZZY_AUTH_BYPASS cannot be enabled in production.');
}
const BYPASS = process.env.NODE_ENV !== 'production' && AUTH_BYPASS_REQUESTED;

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────
export function extractAuthToken(req) {
  // Header (preferred)
  const auth = req.headers.authorization || req.headers.Authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }

  // Supabase cookies (if you proxied them)
  const rawCookie = req.headers.cookie;
  if (rawCookie) {
    const cookies = cookie.parse(rawCookie);
    if (cookies['sb-access-token']) return cookies['sb-access-token'];
    if (cookies['sb:token']) return cookies['sb:token'];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification paths
// ─────────────────────────────────────────────────────────────────────────────
async function verifyViaAdmin(token) {
  if (!supabaseAdmin) throw new Error('admin-client-unavailable');
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    const e = new Error(`getUser error: ${error?.message || 'unknown'}`);
    e.code = 'admin-verify-failed';
    throw e;
  }
  const u = data.user;
  return {
    userId: u.id,
    email: u.email || u.user_metadata?.email || null,
    role: u.role || u.app_metadata?.role || null,
    raw: u,
  };
}

async function verifyViaJWKS(token) {
  // Reuse a working JWKS if already resolved
  if (jwksSet) {
    const { payload } = await jwtVerify(token, jwksSet, {
      issuer: ISSUER,
      clockTolerance: 5, // seconds of slack for clock skew
    });
    return payload;
  }

  // Try both URLs; jose caches internally
  let lastErr;
  for (const url of JWKS_URLS) {
    const remoteSet = createRemoteJWKSet(url);
    try {
      const { payload } = await jwtVerify(token, remoteSet, {
        issuer: ISSUER,
        clockTolerance: 5,
      });
      jwksSet = remoteSet;
      jwksSource = url.toString();
      return payload;
    } catch (err) {
      lastErr = err;
      // If it's a real token error (expired/signature), don't keep trying other URLs
      const code = err?.code || err?.name || '';
      if (/Expired|NotBefore|JWTClaimInvalid|JWSSignatureVerificationFailed/i.test(code)) {
        err.code = 'token-invalid';
        throw err;
      }
      // else: network/JWKS fetch issue — try the next URL
    }
  }
  const e = new Error('jwks-fetch-failed');
  e.cause = lastErr;
  throw e;
}

async function verifySupabaseAccessToken(token) {
  if (testDeps?.verifyToken) return testDeps.verifyToken(token);

  try {
    return await verifyViaAdmin(token);
  } catch (adminErr) {
    const fallbackAllowed =
      adminErr?.message === 'admin-client-unavailable' ||
      adminErr?.code === 'admin-verify-failed';
    if (!fallbackAllowed) throw adminErr;

    const payload = await verifyViaJWKS(token);
    return {
      userId: payload.sub,
      email: payload.email || null,
      role: payload.role || null,
      raw: payload,
    };
  }
}

function sendAuthError(res, code, status = 401) {
  return res.status(status).json({ ok: false, error: code, code });
}

export function __setRequireAuthTestDeps(deps = null) {
  testDeps = deps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────
export async function requireAuth(req, res, next) {
  try {
    if (req.method === 'OPTIONS') return next();
    if (BYPASS) {
      req.auth = { userId: 'dev-user', email: null, role: 'dev' };
      // Compatibility only. Never include unverified tenant context here.
      req.user = { id: req.auth.userId, email: req.auth.email, role: req.auth.role };
      return next();
    }

    const token = extractAuthToken(req);
    if (!token) {
      return sendAuthError(res, 'AUTH_REQUIRED');
    }

    try {
      const claims = await verifySupabaseAccessToken(token);
      const userId = claims.userId || claims.sub || claims.id || null;
      if (!userId) return sendAuthError(res, 'AUTH_INVALID');

      req.auth = {
        userId,
        email: claims.email || null,
        role: claims.role || null,
      };

      // Compatibility only. Existing controllers can keep reading req.user.id
      // while new secure code uses req.auth. Tenant fields are attached only
      // by requireBusinessAccess after DB authorization.
      req.user = {
        id: req.auth.userId,
        email: req.auth.email,
        role: req.auth.role,
        raw: claims.raw || null,
      };

      return next();
    } catch (verifyErr) {
      console.error(
        '[requireAuth] verify failed:',
        verifyErr?.code || verifyErr?.name || 'ERR',
        verifyErr?.message,
        jwksSource ? `(jwks: ${jwksSource})` : ''
      );
      return sendAuthError(res, 'AUTH_INVALID');
    }
  } catch (err) {
    console.error(
      '[requireAuth] verify failed:',
      err?.code || err?.name || 'ERR',
      err?.message,
      jwksSource ? `(jwks: ${jwksSource})` : ''
    );
    return sendAuthError(res, 'AUTH_INVALID');
  }
}

export default requireAuth;
