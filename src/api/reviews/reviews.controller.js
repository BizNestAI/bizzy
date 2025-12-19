import { asyncHandler, HttpError } from '../../utils/reviews/errors.js';
import { listReviewsQuery, statsQuery, replyBody, requestBody, csvImportBody } from '../../utils/reviews/validators.js';
import { listReviews, importCsvBase64, upsertNormalizedReviews } from './reviews.service.js';
import { getReviewStats } from './reviewStats.service.js';
import { buildReviewInsights } from './reviewInsights.service.js';
import { sendOwnerReplyEmail } from '../../services/reviews/gmail.service.js';
import { buildReplyDraft } from './gpt/reviewDrafts.js';
import { emitInsights } from '../../services/reviews/insightsBus.js';
import { sendOk, sendErr } from '../_shared/apiResponder.js';
import { supabase } from '../../services/supabaseAdmin.js';

// GET /api/reviews/summary?business_id=&range=30d
export const getSummary = asyncHandler(async (req, res) => {
  const { business_id, range = '30d' } = req.query || {};
  if (!business_id) return sendErr(res, 400, 'business_id required');

  const stats = await getReviewStats({ business_id, range });

  // Simple by_source breakdown + one sample
  const { data: sampleRows } = await supabase
    .from('reviews')
    .select('id, source, rating, body, author_name, created_at_utc')
    .eq('business_id', business_id)
    .order('created_at_utc', { ascending: false })
    .limit(3);

  const by_source = {};
  (sampleRows || []).forEach(r => { by_source[r.source] = (by_source[r.source] || 0) + 1; });

  const payload = {
    ...stats,
    by_source,
    sample: (sampleRows || []).map(r => ({
      id: r.id,
      source: r.source,
      rating: r.rating,
      text: r.body,
      author: r.author_name,
      created_at: r.created_at_utc,
    })),
  };
  return sendOk(res, payload);
});

// GET /api/reviews
export const getReviews = asyncHandler(async (req, res) => {
  const params = listReviewsQuery.parse(req.query);
  const result = await listReviews(params);
  return sendOk(res, result);
});

// GET /api/reviews/stats
export const getStats = asyncHandler(async (req, res) => {
  const params = statsQuery.parse(req.query);
  const result = await getReviewStats(params);
  return sendOk(res, result);
});

// POST /api/reviews/:id/reply
export const postReply = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const body = replyBody.parse(req.body);

  const { data: r, error } = await req.supabase
    .from('reviews')
    .select('*')
    .eq('id', id)
    .single();
  if (error || !r) throw new HttpError(404, 'Review not found');

  // Tenant guard: ensure caller provided matching business_id (if present)
  if (body.business_id && r.business_id !== body.business_id) {
    throw new HttpError(403, 'Forbidden for this business');
  }

  const draft = body.draft_text || buildReplyDraft({
    rating: r.rating, themes: r.themes, body: r.body, author_name: r.author_name
  });

  const send = await sendOwnerReplyEmail({
    toEmail: r.author_email || 'no-reply@example.com',
    subject: `Reply from your contractor`,
    text: draft,
    tokens: null,
  });

  const { error: upErr } = await req.supabase
    .from('reviews')
    .update({ owner_replied: true, reply_text: draft, replied_at: new Date().toISOString() })
    .eq('id', id);
  if (upErr) throw upErr;

  return sendOk(res, { ok: true, draft, fallback: send.fallback || null });
});

// POST /api/reviews/requests
export const postRequest = asyncHandler(async (req, res) => {
  const payload = requestBody.parse(req.body);
  return sendOk(res, { ok: true, queued: true, payload }); // stub ack
});

// GET /api/reviews/insights
export const getInsights = asyncHandler(async (req, res) => {
  const { business_id } = statsQuery.parse(req.query);
  const insights = await buildReviewInsights(business_id);
  await emitInsights(business_id, insights);
  return sendOk(res, insights);
});

// POST /api/reviews/import/csv
export const postImportCsv = asyncHandler(async (req, res) => {
  const payload = csvImportBody.parse(req.body);
  const result = await importCsvBase64(payload);
  return sendOk(res, { ok: true, ...result });
});

// POST /api/reviews/ingest
export const postIngestNormalized = asyncHandler(async (req, res) => {
  const { business_id, source, items } = req.body || {};
  if (!business_id || !source || !Array.isArray(items)) {
    return sendErr(res, 400, 'Invalid payload');
  }
  const result = await upsertNormalizedReviews(business_id, source, items);
  return sendOk(res, { ok: true, ...result });
});
