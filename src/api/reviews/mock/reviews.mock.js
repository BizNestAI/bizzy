// src/api/reviews/mock/reviews.mock.js
export function mockReviewSummary() {
  return {
    avg_rating: 4.8,
    count_reviews: 26,
    new_reviews: 26,
    unreplied_count: 5,
    response_median_hours: 10,
    pos_pct: 78,
    neg_pct: 4,
    by_source: { google: 18, facebook: 8 },
    sample: [
      { id: 'r1', source: 'google', rating: 5, text: 'Crew was fast and cleaned up perfectly.', author: 'John S.', created_at: '2025-09-18T14:05:00Z' }
    ],
  };
}
