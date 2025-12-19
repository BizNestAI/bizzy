import cron from 'node-cron';
import { supabase } from '../services/supabaseAdmin.js';
import { log } from '../utils/logger.js';
// Providers will be added later; keeping calls but they can be mocked out for now.
import { googleFetchReviews, normalizeGoogleReview } from '../api/reviews/providers/google.provider.js';
import { facebookFetchReviews, normalizeFacebookReview } from '../api/reviews/providers/facebook.provider.js';
import { upsertNormalizedReviews } from '../api/reviews/reviews.service.js';

// Runs nightly at 2:15am server time
export function startReviewsCron() {
  cron.schedule('15 2 * * *', async () => {
    log.info('[cron] Nightly reviews fetch start');
    const { data: sources, error } = await supabase
      .from('review_sources')
      .select('id, business_id, provider, external_id, connected, metadata');
    if (error) { log.error('[cron] fetch sources failed', error); return; }

    for (const src of sources || []) {
      try {
        if (!src.connected) continue;
        if (src.provider === 'google' && typeof googleFetchReviews === 'function') {
          const { reviews } = await googleFetchReviews({
            accessToken: src.metadata?.access_token,
            locationId: src.external_id,
          });
          const items = (reviews || []).map(normalizeGoogleReview);
          if (items.length) await upsertNormalizedReviews(src.business_id, 'google', items);
        }
        if (src.provider === 'facebook' && typeof facebookFetchReviews === 'function') {
          const { reviews } = await facebookFetchReviews({
            accessToken: src.metadata?.access_token,
            pageId: src.external_id,
          });
          const items = (reviews || []).map(normalizeFacebookReview);
          if (items.length) await upsertNormalizedReviews(src.business_id, 'facebook', items);
        }
      } catch (e) { log.error('[cron] provider error', e); }
    }
    log.info('[cron] Nightly reviews fetch done');
  });
}
