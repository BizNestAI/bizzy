import { supabase } from '../../services/supabaseAdmin.js';
import { rangeToDates } from '../../utils/reviews/date.js';

export async function getReviewStats({ business_id, range = '30d' }) {
  const { start, end } = rangeToDates(range);
  const { data: reviews, error } = await supabase
    .from('reviews')
    .select('rating, owner_replied, created_at_utc, replied_at')
    .eq('business_id', business_id)
    .gte('created_at_utc', start)
    .lte('created_at_utc', end);
  if (error) throw error;

  const count = reviews.length;
  const avg = count ? reviews.reduce((a, r) => a + r.rating, 0) / count : null;
  const unreplied = reviews.filter(r => !r.owner_replied).length;

  const diffs = reviews
    .filter(r => r.owner_replied && r.replied_at)
    .map(r => (new Date(r.replied_at) - new Date(r.created_at_utc)) / 36e5)
    .sort((a,b) => a-b);

  const mid = Math.floor(diffs.length / 2);
  const median = diffs.length ? (diffs.length % 2 ? diffs[mid] : (diffs[mid-1] + diffs[mid]) / 2) : null;

  const pos = reviews.filter(r => r.rating >= 4).length;
  const neg = reviews.filter(r => r.rating <= 2).length;

  return {
    range,
    avg_rating: avg ? Number(avg.toFixed(2)) : null,
    count_reviews: count,
    new_reviews: count,
    unreplied_count: unreplied,
    response_median_hours: median ? Math.round(median) : null,
    pos_pct: count ? Math.round((pos / count) * 100) : null,
    neg_pct: count ? Math.round((neg / count) * 100) : null,
    top_themes: [],
  };
}
