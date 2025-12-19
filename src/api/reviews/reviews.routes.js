import { Router } from 'express';
import { supabase } from '../../services/supabaseAdmin.js';
import {
  getReviews, getStats, getSummary, postReply, postRequest, getInsights, postImportCsv, postIngestNormalized
} from './reviews.controller.js';

function attachSupabase(req, _res, next) { req.supabase = supabase; next(); }

export const reviewsRouter = Router();
reviewsRouter.use(attachSupabase);

// NEW: lightweight dashboard tile
reviewsRouter.get('/summary', getSummary);

reviewsRouter.get('/', getReviews);
reviewsRouter.get('/stats', getStats);
reviewsRouter.get('/insights', getInsights);
reviewsRouter.post('/import/csv', postImportCsv);
reviewsRouter.post('/:id/reply', postReply);
reviewsRouter.post('/requests', postRequest);
reviewsRouter.post('/ingest', postIngestNormalized); // optional internal
