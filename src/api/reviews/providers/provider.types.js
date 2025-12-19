/**
 * Shared provider helper utilities and typedefs.
 * These keep providers consistent and make upserts deterministic.
 */

/** @typedef {Object} NormalizedReview
 * @property {string} external_review_id
 * @property {number} rating                 // 1..5
 * @property {string|null} author_name
 * @property {string} body
 * @property {string} language               // ISO code, e.g. 'en'
 * @property {string} created_at_utc         // ISO timestamp (UTC)
 * @property {boolean} [owner_replied]
 * @property {string|null} [reply_text]
 * @property {string|null} [replied_at]
 */

/** Ensure a value is returned as a UTC ISO string. */
export function toISO(dateLike) {
  try {
    if (!dateLike) return new Date().toISOString();
    const d = new Date(dateLike);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/** Clamp rating to the 1..5 range and coerce to number. */
export function clampRating(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(5, Math.round(x)));
}

/** Tiny sleep helper for backoffs. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse Retry-After header (seconds or HTTP-date). */
export function retryAfterSeconds(h) {
  if (!h) return 0;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n) * 1000;
  const t = new Date(h);
  if (isNaN(t.getTime())) return 0;
  return Math.max(0, t.getTime() - Date.now());
}
