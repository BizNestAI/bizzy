export const mockPosts = (businessId) => ([
  {
    id: 'mock-ig-1',
    business_id: businessId,
    platform: 'instagram',
    post_id: 'p_001',
    caption: 'Backyard paver transformation: before ➜ after',
    media_url: 'https://placehold.co/640x640',
    metrics: { reach: 1124, likes: 92, comments: 14, shares: 6, clicks: 25, saves: 9 },
    posted_at: '2025-07-31T15:20:00Z'
  },
  // …
]);
