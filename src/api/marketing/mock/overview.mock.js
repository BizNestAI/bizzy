// src/api/marketing/mock/overview.mock.js
export function mockOverview(businessId) {
  return {
    business_id: businessId || null,
    totals: { reach: 14200, engagements: 1384, avg_engagement_rate: 0.097 },
    delta_vs_last_week: 0.113,
    best_post: { id: 'mock-ig-1', title: 'Backyard Before/After Reveal' },
    best_campaign: { id: 'mock-email-1', title: 'Spring Promo' },
  };
}

