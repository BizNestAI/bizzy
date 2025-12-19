import express from 'express';
import { sendOk, sendErr } from '../_shared/apiResponder.js';
import captionsRouter from './generate-social-caption.js';
import emailRouter from './generate-email-campaign.js';

const router = express.Router();

function normalizeIds(req, _res, next) {
  const q = req.query || {};
  const h = req.headers || {};
  req.ctx = {
    userId: q.user_id || q.userId || h['x-user-id'] || null,
    businessId: q.business_id || q.businessId || h['x-business-id'] || null,
  };
  next();
}

// Dev CORS for POST routes in this module
router.options(['/', '/insights', '/generate-insights', '/email/generate', '/captions/generate'], (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-user-id, x-business-id',
  });
  res.sendStatus(204);
});

// ---- Insights (mock-toggle kept) ----
async function handleInsights(req, res) {
  try {
    const { posts = [], campaigns = [] } = req.body || {};
    if (process.env.MOCK_MARKETING_INSIGHTS === 'true') {
      const payload = {
        summary:
          'Engagement rose week-over-week. Before/After posts outperformed; email subject lines with benefits had higher opens.',
        postInsights: posts.map((p, i) => ({
          id: i,
          insight: `“${p.post_type || 'Post'}” on ${p.platform || 'platform'} shows above-average engagement; consider posting similar content.`
        })),
        campaignInsights: campaigns.map((c, i) => ({
          id: i,
          insight: `Open ${c.open_rate}% / CTR ${c.ctr}% — test a shorter subject and a single CTA to lift clicks.`
        })),
      };
      return sendOk(res, payload, { is_mock: true });
    }
    return sendErr(res, 501, 'Insights generation not implemented');
  } catch (err) {
    return sendErr(res, 500, 'Failed to generate insights');
  }
}
router.post('/insights', normalizeIds, handleInsights);
router.post('/generate-insights', normalizeIds, handleInsights);
router.get(['/insights', '/generate-insights'], (_req, res) =>
  sendErr(res, 405, 'Use POST for /api/marketing/insights')
);

// Mount feature routers
router.use(captionsRouter);     // POST /captions/generate
router.use(emailRouter);        // POST /email/generate

export default router;
