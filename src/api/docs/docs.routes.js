// File: /src/api/docs/docs.routes.js
import { Router } from 'express';
import {
  summarizeAndSaveDoc,
  listDocsController,
  getDocController,
  getFacetsController,
} from './docs.controller.js';
import { supabase } from '../../services/supabaseAdmin.js';
import { generateThreadSummaryLLM } from '../gpt/brain/generateThreadSummary.js';

export const docsRouter = Router();

/* ──────────────────────────────────────────────────────────────
 * Helpers: request id / id normalization / cache policy
 * ────────────────────────────────────────────────────────────── */
function attachRequestId(req, res, next) {
  const id = req.headers['x-request-id'] || cryptoRandomId();
  res.set('X-Request-ID', id);
  req.requestId = id;
  next();
}

function cryptoRandomId() {
  // Small, fast, non-crypto unique-ish id for tracing
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Normalize IDs (query or headers)
 *  - In production: require valid UUIDs, else 400
 *  - In dev: fall back to a stable UUID so routes don’t crash
 */
function normalizeIds(req, res, next) {
  const q = req.query || {};
  const h = req.headers || {};
  const isUuid =
    (v) =>
      typeof v === 'string' &&
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(v);

  const dev = process.env.NODE_ENV !== 'production';
  const fallback = '00000000-0000-0000-0000-000000000001';

  const userIdRaw = q.user_id || q.userId || h['x-user-id'] || process.env.DEV_USER_ID;
  const bizIdRaw  = q.business_id || q.businessId || h['x-business-id'] || process.env.DEV_BUSINESS_ID;

  if (!dev) {
    if (!isUuid(userIdRaw)) return res.status(400).json({ error: 'missing_or_invalid_user_id', request_id: req.requestId });
    if (!isUuid(bizIdRaw))  return res.status(400).json({ error: 'missing_or_invalid_business_id', request_id: req.requestId });
  }

  req.ctx = {
    userId:     isUuid(userIdRaw) ? userIdRaw : fallback,
    businessId: isUuid(bizIdRaw)  ? bizIdRaw  : (process.env.DEV_BUSINESS_ID || fallback),
  };
  next();
}

function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

/* ──────────────────────────────────────────────────────────────
 * Lightweight rate limiter for summarize endpoint (in-memory)
 * Avoids accidental abuse and big token bills.
 * ────────────────────────────────────────────────────────────── */
const RATE_WINDOW_MS = 60_000; // 1 min window
const RATE_MAX = 6; // 6 requests per minute per business
const rateBucket = new Map();

function rateLimitSummarize(req, res, next) {
  const biz = req?.ctx?.businessId || 'unknown';
  const now = Date.now();
  const win = rateBucket.get(biz) || [];
  const recent = win.filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    return res.status(429).json({ error: 'rate_limited', request_id: req.requestId });
  }
  recent.push(now);
  rateBucket.set(biz, recent);
  next();
}

/* ──────────────────────────────────────────────────────────────
 * Routes
 * ────────────────────────────────────────────────────────────── */

/**
 * GET /api/docs/list
 * Query: business_id?, category=all, q, limit=100, offset=0, sort=new|old|az|za
 * Returns: { data: Doc[], count: number }
 */
docsRouter.get('/list', attachRequestId, normalizeIds, noStore, async (req, res) => {
  try {
    return await listDocsController(req, res);
  } catch (e) {
    console.error('[docs:list] error:', e, 'req_id=', req.requestId);
    return res.status(500).json({ error: 'list_failed', request_id: req.requestId });
  }
});

/**
 * GET /api/docs/facets
 * Query: business_id?
 * Returns: { data: { all, general, financials, tax, marketing, investments } }
 */
docsRouter.get('/facets', attachRequestId, normalizeIds, noStore, async (req, res) => {
  try {
    return await getFacetsController(req, res);
  } catch (e) {
    console.error('[docs:facets] error:', e, 'req_id=', req.requestId);
    return res.status(500).json({ error: 'facets_failed', request_id: req.requestId });
  }
});

/**
 * GET /api/docs/detail/:id
 * Returns: { data: Doc } or 404
 */
docsRouter.get('/detail/:id', attachRequestId, normalizeIds, noStore, async (req, res) => {
  try {
    return await getDocController(req, res);
  } catch (e) {
    console.error('[docs:detail] error:', e, 'req_id=', req.requestId);
    return res.status(404).json({ error: 'not_found', request_id: req.requestId });
  }
});

/**
 * POST /api/docs/summarize-and-save
 * body: { business_id, user_id, category, title, messages:[...] }
 */
docsRouter.post(
  '/summarize-and-save',
  attachRequestId,
  normalizeIds,
  rateLimitSummarize,
  async (req, res) => {
    try {
      return await summarizeAndSaveDoc(req, res);
    } catch (e) {
      console.error('[docs:summarize] error:', e, 'req_id=', req.requestId);
      return res.status(500).json({ error: 'summarize_failed', request_id: req.requestId });
    }
  }
);

docsRouter.post(
  '/thread-summary',
  attachRequestId,
  normalizeIds,
  rateLimitSummarize,
  async (req, res) => {
    try {
      const { thread_id, snippet = '', business_name } = req.body || {};
      let messages = [];
      if (thread_id) {
        const { data, error } = await supabase
          .from('gpt_messages')
          .select('role,content')
          .eq('thread_id', thread_id)
          .order('created_at', { ascending: true })
          .limit(12);
        if (error) throw error;
        messages = data || [];
      }
      const summary = await generateThreadSummaryLLM({
        messages,
        snippet,
        businessName: business_name,
      });
      const fallbackBody =
        snippet ||
        messages
          .map((m) => `${m.role === 'assistant' ? 'Bizzi' : 'You'}: ${m.content}`)
          .join('\n\n');
      const normalized = summary && Array.isArray(summary.sections) && summary.sections.length
        ? summary.sections
            .map((section, idx) => ({
              heading: section.heading || (idx === 0 ? 'Summary' : ''),
              body: section.body || '',
            }))
            .filter((section) => section.body)
        : [{ heading: 'Summary', body: fallbackBody }];
      const title =
        (summary?.title && summary.title.trim()) ||
        (business_name ? `Bizzi notes — ${business_name}` : 'Bizzi notes');
      return res.json({ summary: { title, sections: normalized } });
    } catch (e) {
      console.error('[docs:thread-summary] error:', e, 'req_id=', req.requestId);
      return res.status(500).json({ error: 'summary_failed', request_id: req.requestId });
    }
  }
);

export default docsRouter;
