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

// Optional dev bypass (NEVER enable in prod)
const BYPASS = String(process.env.BIZZY_AUTH_BYPASS || '').toLowerCase() === 'true';

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────
function extractToken(req) {
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    sub: u.id,
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

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────
export async function requireAuth(req, res, next) {
  try {
    if (req.method === 'OPTIONS') return next();
    if (BYPASS) {
      req.user = { id: 'dev-user', email: null, role: 'dev' };
      return next();
    }

    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: missing token' });
    }

    let claims;
    // Prefer Admin verification (simple + robust), fall back to JWKS if needed
    try {
      claims = await verifyViaAdmin(token);
    } catch (adminErr) {
      // If admin not available or failed due to network, try JOSE
      const fallbackAllowed =
        adminErr?.message === 'admin-client-unavailable' ||
        adminErr?.code === 'admin-verify-failed';
      if (!fallbackAllowed) throw adminErr;

      try {
        const payload = await verifyViaJWKS(token);
        claims = {
          sub: payload.sub,
          email: payload.email || null,
          role: payload.role || null,
          raw: payload,
        };
      } catch (jwksErr) {
        // Return clear reason
        const reason =
          jwksErr?.code === 'token-invalid'
            ? 'invalid token'
            : 'token verification failed';
        console.error(
          '[requireAuth] jwks error:',
          jwksErr?.code || jwksErr?.name || 'ERR',
          jwksErr?.message,
          jwksSource ? `(jwks: ${jwksSource})` : ''
        );
        return res.status(401).json({ ok: false, error: `Unauthorized: ${reason}` });
      }
    }

    // Attach user for downstream
    req.user = {
      id: claims.sub,
      email: claims.email || null,
      role: claims.role || null,
      raw: claims.raw || claims,
    };

    // Optional business_id pass-through
    const biz = req.headers['x-business-id'];
    if (biz && UUID_RE.test(String(biz))) req.user.business_id = biz;

    return next();
  } catch (err) {
    console.error(
      '[requireAuth] verify failed:',
      err?.code || err?.name || 'ERR',
      err?.message,
      jwksSource ? `(jwks: ${jwksSource})` : ''
    );
    return res.status(401).json({ ok: false, error: 'Unauthorized: invalid token' });
  }
}

export default requireAuth;
