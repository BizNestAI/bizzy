// Placeholder stub — replace with Meta Graph API once connected
export async function fetchPublishedPosts(userId, businessId) {
  console.log(`[fetchPublishedPosts] Stub for user ${userId}, biz ${businessId}`);
  return [
    {
      id: 'published-1',
      user_id: userId,
      business_id: businessId,
      caption: 'Excited to help another family get their dream kitchen! 🔨💥',
      category: 'Before/After',
      platform: 'instagram',
      image_url: 'https://via.placeholder.com/400x300.png?text=Kitchen+Remodel',
      status: 'published',
      created_at: '2025-07-27T18:42:00Z',
      metrics_json: { likes: 47, comments: 3, reach: 321, shares: 1 },
      source: 'published',
    },
    {
      id: 'published-2',
      user_id: userId,
      business_id: businessId,
      caption: '⭐️⭐️⭐️⭐️⭐️ “They showed up on time and finished the job early!”',
      category: 'Testimonial',
      platform: 'facebook',
      image_url: 'https://via.placeholder.com/400x300.png?text=Client+Review',
      status: 'published',
      created_at: '2025-07-24T12:15:00Z',
      metrics_json: { likes: 23, comments: 0, reach: 154, shares: 0 },
      source: 'published',
    },
  ];
}
