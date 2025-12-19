// File: /src/api/docs/docs.controller.js
import { z } from 'zod';
import { supabase } from '../../services/supabaseAdmin.js';
import { summarizeWithLLM } from './summarizer.js';

/* ──────────────────────────────────────────────────────────────
 * Schemas & helpers
 * ────────────────────────────────────────────────────────────── */
const summarizePayload = z.object({
  business_id: z.string().uuid(),
  user_id: z.string().uuid(),
  title: z.string().min(1).max(200),
  category: z.enum(['financials','tax','marketing','investments','general']).default('general'),
  messages: z.array(z.object({
    role: z.enum(['user','assistant']),
    content: z.string().min(1)
  })).min(1).max(100) // hard cap on message count
});

const listQuery = z.object({
  business_id: z.string().uuid().optional(),
  category: z.enum(['all','general','financials','tax','marketing','investments']).default('all'),
  q: z.string().max(200).optional().default(''),
  sort: z.enum(['new','old','az','za']).default('new'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

function stripHtml(html = '') {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cheapSummary(messages) {
  const text = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  const body = stripHtml(text).slice(0, 1500);
  return {
    title: 'Bizzy Summary',
    sections: [
      { heading: 'Overview', body: body.substring(0, 600) },
      { heading: 'Details', body: body.substring(600, 1200) },
      { heading: 'Next Steps', body: '• Review key items.\n• Assign owners and dates.\n• Revisit this plan in 2 weeks.' }
    ],
    tags: ['summary','chat'],
    format: 'sections',
    plain_excerpt: body.substring(0, 600)
  };
}

const ok = (req, res, data) => res.json({ ...data, request_id: req.requestId });
const fail = (req, res, status, error, meta) => res.status(status).json({ error, ...(meta ? { meta } : {}), request_id: req.requestId });

/* ──────────────────────────────────────────────────────────────
 * POST /summarize-and-save
 * ────────────────────────────────────────────────────────────── */
export async function summarizeAndSaveDoc(req, res) {
  try {
    const parsed = summarizePayload.parse(req.body);
    const { business_id, user_id, category, title, messages } = parsed;

    // LLM call (with internal truncation and validation)
    let content;
    try {
      content = await summarizeWithLLM(title, category, messages);
    } catch (e) {
      console.warn('[docs] LLM unavailable, using cheap fallback:', e?.message);
      content = cheapSummary(messages);
      content.title = title;
    }

    // Ensure content has helpful render keys
    if (!content.format) content.format = 'sections';
    if (!content.plain_excerpt) {
      const comb = Array.isArray(content.sections)
        ? content.sections.map(s => s?.body || '').join(' ')
        : '';
      content.plain_excerpt = stripHtml(comb).slice(0, 600);
    }
    if (!Array.isArray(content.tags)) content.tags = [category, 'summary'];

    const { data, error } = await supabase
      .from('bizzy_docs')
      .insert({
        business_id,
        user_id,
        title,
        category,
        content,
        tags: content.tags || [],
      })
      .select('id')
      .single();

    if (error) {
      console.error('[docs] insert error', error);
      return fail(req, res, 500, 'insert_failed');
    }

    return ok(req, res, { ok: true, id: data.id });
  } catch (err) {
    console.error('[docs] summarizeAndSaveDoc error', err);
    const status = err?.status || 400;
    return fail(req, res, status, err?.message || 'invalid_request');
  }
}

/* ──────────────────────────────────────────────────────────────
 * GET /list
 * ────────────────────────────────────────────────────────────── */
export async function listDocsController(req, res) {
  try {
    const businessId = req?.ctx?.businessId || req?.query?.business_id;
    if (!businessId) return fail(req, res, 400, 'missing_or_invalid_business_id');

    const parsed = listQuery.safeParse(req.query || {});
    if (!parsed.success) {
      return fail(req, res, 400, 'invalid_query', { issues: parsed.error.issues });
    }
    const { q, category, sort, limit, offset } = parsed.data;

    let query = supabase
      .from('bizzy_docs')
      .select('id,business_id,title,filename,category,size,mime_type,created_at,author,updated_at', { count: 'exact' })
      .eq('business_id', businessId);

    if (category && category !== 'all') query = query.eq('category', category);

    // Basic search on title/filename; also peek into content.plain_excerpt if present
    if (q) {
      const like = `%${q}%`;
      query = query.or([
        `title.ilike.${like}`,
        `filename.ilike.${like}`,
        `content->>plain_excerpt.ilike.${like}`
      ].join(','));
    }

    if (sort === 'new')      query = query.order('created_at', { ascending: false });
    else if (sort === 'old') query = query.order('created_at', { ascending: true });
    else if (sort === 'az')  query = query.order('title', { ascending: true, nullsFirst: true });
    else if (sort === 'za')  query = query.order('title', { ascending: false, nullsFirst: true });

    query = query.range(offset, offset + Math.max(0, limit - 1));

    const { data, count, error } = await query;
    if (error) throw error;

    const safeData = Array.isArray(data) ? data : [];
    return ok(req, res, { data: safeData, count: count || 0 });
  } catch (err) {
    console.error('[docs:list] controller error', err);
    const status = err?.status || 400;
    return res.status(status).json({ error: err?.message || 'list_failed', request_id: req.requestId });
  }
}

/* ──────────────────────────────────────────────────────────────
 * GET /detail/:id
 * ────────────────────────────────────────────────────────────── */
export async function getDocController(req, res) {
  try {
    const businessId = req?.ctx?.businessId || req?.query?.business_id;
    if (!businessId) return fail(req, res, 400, 'missing_or_invalid_business_id');

    const { id } = req.params;
    const { data, error } = await supabase
      .from('bizzy_docs')
      .select('*')
      .eq('business_id', businessId)
      .eq('id', id)
      .single();

    if (error || !data) return fail(req, res, 404, 'not_found');
    return ok(req, res, { data });
  } catch (err) {
    const status = err?.status || 400;
    return res.status(status).json({ error: err?.message || 'detail_failed', request_id: req.requestId });
  }
}

/* ──────────────────────────────────────────────────────────────
 * GET /facets
 * ────────────────────────────────────────────────────────────── */
export async function getFacetsController(req, res) {
  try {
    const businessId = req?.ctx?.businessId || req?.query?.business_id;
    if (!businessId) return fail(req, res, 400, 'missing_or_invalid_business_id');

    const cats = ['general', 'financials', 'tax', 'marketing', 'investments'];

    const results = await Promise.all(
      cats.map(async (c) => {
        const { count, error } = await supabase
          .from('bizzy_docs')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', businessId)
          .eq('category', c);
        if (error) console.warn('[docs:facets] count error for', c, error?.message);
        return [c, count || 0];
      })
    );

    const { count: all } = await supabase
      .from('bizzy_docs')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId);

    return ok(req, res, { data: { all: all || 0, ...Object.fromEntries(results) } });
  } catch (err) {
    const status = err?.status || 400;
    return res.status(status).json({ error: err?.message || 'facets_failed', request_id: req.requestId });
  }
}
