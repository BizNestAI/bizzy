import fetch from 'node-fetch';
import { clampRating, toISO, sleep, retryAfterSeconds } from './provider.types.js';

/**
 * Fetch raw reviews/ratings from Facebook Graph for a Page.
 * If token/ids missing (or forced mock), returns a small mock set.
 */
export async function facebookFetchReviews({ accessToken, pageId, after = null, limit = 50 } = {}) {
  const forceMock = process.env.BIZZY_FORCE_MOCKS === '1';
  if (forceMock || !accessToken || !pageId) {
    return { reviews: mockFacebookRaw(), nextCursor: null, is_mock: true };
  }

  // Example Graph endpoint:
  // GET https://graph.facebook.com/v20.0/{pageId}/ratings?fields=review_text,rating,created_time,reviewer{name}&limit=50&after=cursor
  const base = process.env.FB_GRAPH_BASE || 'https://graph.facebook.com/v20.0';
  const url = new URL(`${base}/${encodeURIComponent(pageId)}/ratings`);
  url.searchParams.set('fields', 'review_text,rating,created_time,recommendation_type,reviewer{name}');
  url.searchParams.set('limit', String(limit));
  if (after) url.searchParams.set('after', after);

  let attempt = 0;
  while (attempt < 2) {
    attempt += 1;
    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (resp.status === 429) {
      const waitMs = retryAfterSeconds(resp.headers.get('retry-after')) || 1500;
      await sleep(waitMs);
      continue;
    }
    if (!resp.ok) {
      console.error('[facebookFetchReviews] HTTP', resp.status, await safeRead(resp));
      return { reviews: [], nextCursor: null, error: `HTTP_${resp.status}` };
    }
    const json = await resp.json().catch(() => ({}));
    const reviews = Array.isArray(json.data) ? json.data : [];
    const nextCursor = json.paging?.cursors?.after || null;
    return { reviews, nextCursor };
  }

  return { reviews: [], nextCursor: null, error: 'RETRY_LIMIT' };
}

/** Map FB raw item → NormalizedReview */
export function normalizeFacebookReview(raw) {
  const reviewer = raw.reviewer || {};
  // FB "recommendation_type" can be "positive"/"negative" instead of 1..5; if rating missing, map pos→5 / neg→2
  const derivedRating = raw.recommendation_type
    ? (raw.recommendation_type === 'positive' ? 5 : 2)
    : (raw.rating ?? 0);

  return {
    external_review_id: String(raw.id || raw.created_time || ''),
    rating: clampRating(derivedRating),
    author_name: reviewer.name || null,
    body: raw.review_text || '',
    language: 'en',
    created_at_utc: toISO(raw.created_time),
    owner_replied: false,     // FB Page replies can be fetched via /{ratingId}/comments if desired (phase 2)
    reply_text: null,
    replied_at: null,
  };
}

/** Minimal mock raw reviews for Facebook */
function mockFacebookRaw() {
  return [
    {
      id: 'fb-1',
      rating: 5,
      review_text: 'They finished the deck in two days. Superb.',
      created_time: '2025-07-23T10:00:00Z',
      reviewer: { name: 'Maya' },
    },
    {
      id: 'fb-2',
      recommendation_type: 'negative',
      review_text: 'Price was higher than expected.',
      created_time: '2025-07-29T16:21:00Z',
      reviewer: { name: 'Chris' },
    },
  ];
}

async function safeRead(resp) {
  try { return await resp.text(); } catch { return ''; }
}
