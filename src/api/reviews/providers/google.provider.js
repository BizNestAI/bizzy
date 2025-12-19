import fetch from 'node-fetch';
import { clampRating, toISO, sleep, retryAfterSeconds } from './provider.types.js';

/**
 * Fetch raw reviews from Google Business Profile.
 * NOTE: Endpoint details can vary by API version. This implementation is resilient:
 * - If token/ids are missing, returns mock data.
 * - Handles 429 with simple Retry-After backoff.
 */
export async function googleFetchReviews({ accessToken, locationId, pageToken = null, pageSize = 50 } = {}) {
  const forceMock = process.env.BIZZY_FORCE_MOCKS === '1';
  if (forceMock || !accessToken || !locationId) {
    return { reviews: mockGoogleRaw(), nextPageToken: null, is_mock: true };
  }

  // Example GBP endpoint (adjust once OAuth is live):
  // https://mybusiness.googleapis.com/v4/{locationId}/reviews?pageSize=50&pageToken=...
  const base = process.env.GBP_REVIEWS_BASE || 'https://mybusiness.googleapis.com/v4';
  const url = new URL(`${base}/${encodeURIComponent(locationId)}/reviews`);
  url.searchParams.set('pageSize', String(pageSize));
  if (pageToken) url.searchParams.set('pageToken', pageToken);

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
      console.error('[googleFetchReviews] HTTP', resp.status, await safeRead(resp));
      return { reviews: [], nextPageToken: null, error: `HTTP_${resp.status}` };
    }
    const json = await resp.json().catch(() => ({}));
    const reviews = Array.isArray(json.reviews) ? json.reviews : [];
    return { reviews, nextPageToken: json.nextPageToken || null };
  }

  return { reviews: [], nextPageToken: null, error: 'RETRY_LIMIT' };
}

/** Map GBP raw item → NormalizedReview */
export function normalizeGoogleReview(raw) {
  // Common GBP fields (names may vary slightly per version)
  const id = raw.reviewId || raw.name || raw.updateTime || String(raw.createTime || '');
  const profile = raw.reviewer || raw.reviewerProfile || {};
  const rating = raw.starRating || raw.rating || 0;

  return {
    external_review_id: String(id),
    rating: clampRating(rating),
    author_name: profile.displayName || profile.name || null,
    body: raw.comment || raw.review || '',
    language: raw.languageCode || 'en',
    created_at_utc: toISO(raw.createTime || raw.updateTime),
    owner_replied: !!raw.reviewReply,
    reply_text: raw.reviewReply?.comment || null,
    replied_at: raw.reviewReply?.updateTime ? toISO(raw.reviewReply.updateTime) : null,
  };
}

/** Minimal mock raw reviews for Google */
function mockGoogleRaw() {
  return [
    {
      reviewId: 'ggl-1',
      starRating: 5,
      comment: 'Amazing crew—clean, fast, professional!',
      languageCode: 'en',
      createTime: '2025-07-24T12:15:00Z',
      reviewer: { displayName: 'Renee' },
      reviewReply: null,
    },
    {
      reviewId: 'ggl-2',
      starRating: 3,
      comment: 'Quality ok, but communication could be better.',
      languageCode: 'en',
      createTime: '2025-07-27T18:42:00Z',
      reviewer: { displayName: 'Akash' },
      reviewReply: { comment: 'Thanks! We’ll improve comms.', updateTime: '2025-07-28T09:12:00Z' },
    },
  ];
}

async function safeRead(resp) {
  try { return await resp.text(); } catch { return ''; }
}
