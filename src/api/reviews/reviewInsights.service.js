import { getReviewStats } from './reviewStats.service.js';

const sevOf = (n) => (n >= 10 ? 'high' : n >= 5 ? 'medium' : 'low');

export async function buildReviewInsights(business_id) {
  const stats = await getReviewStats({ business_id, range: '30d' });
  const out = [];

  if (stats.unreplied_count > 0) {
    out.push({
      module: 'marketing',
      type: 'insight',
      severity: sevOf(stats.unreplied_count),
      title: `You have ${stats.unreplied_count} unreplied reviews`,
      body: 'Aim for responses within 24 hours.',
      primary_cta: { label: 'Reply now', action: 'open_route', route: '/dashboard/marketing/reviews?filter=unreplied' }
    });
  }

  if (stats.response_median_hours && stats.response_median_hours > 24) {
    out.push({
      module: 'marketing',
      type: 'insight',
      severity: 'medium',
      title: `Reply time is ${stats.response_median_hours}h (target ≤24h)`,
      body: 'Consider batch-replying now.',
      primary_cta: { label: 'Open Reviews', action: 'open_route', route: '/dashboard/marketing/reviews' }
    });
  }

  if (stats.avg_rating && stats.avg_rating < 4.5) {
    out.push({
      module: 'marketing',
      type: 'insight',
      severity: 'low',
      title: `Avg rating ${stats.avg_rating} (last 30d)`,
      body: 'Monitor themes and address common issues.',
      primary_cta: { label: 'See Reviews', action: 'open_route', route: '/dashboard/marketing/reviews' }
    });
  }

  return out;
}
