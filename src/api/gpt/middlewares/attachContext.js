// File: /src/api/gpt/middlewares/attachContext.js
import { getIntentModule } from '../registry/intentRegistry.js';
import { supabase } from '../../../services/supabaseAdmin.js';

// ---------------------------
// Optional in-process cache
// ---------------------------
// Only used when an intent module exposes `cacheKey(ctx)`.
// TTL keeps it safe across brief bursts (e.g., same KPI panel).
const CACHE = new Map(); // key -> { value, exp }
const TTL_MS = 60 * 1000; // 60s

function getCache(key) {
  const item = CACHE.get(key);
  if (!item) return null;
  if (item.exp < Date.now()) {
    CACHE.delete(key);
    return null;
  }
  return item.value;
}
function setCache(key, value, ttl = TTL_MS) {
  CACHE.set(key, { value, exp: Date.now() + ttl });
}

// ---------------------------
// Payload guards & observability
// ---------------------------

// Trim big arrays/strings to keep prompts snappy.
// Conservative defaults; adjust if needed.
const MAX_ARRAY = 100;
const MAX_STRING = 8000;

function pruneBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') return bundle;
  const seen = new WeakSet();

  function prune(obj) {
    if (obj && typeof obj === 'object') {
      if (seen.has(obj)) return obj;
      seen.add(obj);

      if (Array.isArray(obj)) {
        if (obj.length > MAX_ARRAY) return obj.slice(0, MAX_ARRAY);
        return obj.map(prune);
      }

      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') {
          out[k] = v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v;
        } else if (Array.isArray(v)) {
          out[k] = v.length > MAX_ARRAY ? v.slice(0, MAX_ARRAY).map(prune) : v.map(prune);
        } else if (v && typeof v === 'object') {
          out[k] = prune(v);
        } else {
          out[k] = v;
        }
      }
      return out;
    }
    return obj;
  }

  return prune(bundle);
}

export async function attachContext(req, _res, next) {
  req.bizzy = req.bizzy || {};
  const started = Date.now();

  try {
    const intent = req.bizzy.intent || 'general';
    const mod = getIntentModule(intent);

    let bundle = {};
    let cacheUsed = false;

    if (mod && typeof mod.recipe === 'function') {
      // Build ctx for recipe
      const ctx = {
        user_id: req.body?.user_id || req.header('x-user-id') || null,
        business_id: req.body?.business_id || req.header('x-business-id') || null,
        supabase,
        message: req.body?.message || '',
        route: req.originalUrl || '',
        // 💡 lightweight hints for email & others
        hint: {
          accountId: req.body?.accountId || null,
          threadId: req.body?.threadId || null,
          toEmail: req.body?.toEmail || null,
          fromEmail: req.body?.fromEmail || null,
          searchQuery: req.body?.searchQuery || null,      // 🔍 for email_search
          followupDelay: req.body?.followupDelay || null,  // ⏰ for email_followup
          contactName: req.body?.contactName || null,      // 👤 for email_find_contact
        },
      };

      // Optional cache
      let cacheKey = null;
      if (typeof mod.cacheKey === 'function') {
        try {
          cacheKey = mod.cacheKey(ctx);
          const cached = cacheKey ? getCache(cacheKey) : null;
          if (cached) {
            bundle = cached;
            cacheUsed = true;
          }
        } catch { /* noop */ }
      }

      if (!cacheUsed) {
        try {
          const raw = await mod.recipe(ctx);
          bundle = (raw && typeof raw === 'object') ? raw : {};
          if (cacheKey) setCache(cacheKey, bundle);
        } catch (e) {
          bundle = {};
          if (process.env.NODE_ENV !== 'production') {
            console.warn(`[attachContext] recipe error for intent "${intent}":`, e?.message || e);
          }
        }
      }
    }

    const pruned = pruneBundle(bundle);

    req.bizzy.contextBundle = pruned;
    req.bizzy.contextMeta = {
      intent,
      ms: Date.now() - started,
      cache: cacheUsed,
      keys: Object.keys(pruned || {}),
    };

    next();
  } catch (e) {
    req.bizzy.contextBundle = {};
    req.bizzy.contextMeta = {
      intent: req.bizzy.intent || 'general',
      ms: Date.now() - started,
      cache: false,
      keys: [],
      error: process.env.NODE_ENV !== 'production' ? (e?.message || String(e)) : undefined,
    };
    next();
  }
}

export default attachContext;