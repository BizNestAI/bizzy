// Heuristic matcher that links reviews to jobs based on simple text signals.
// Safe to run as a cron or manual trigger; idempotent updates to reviews.job_id.
import { supabase } from '../../services/supabaseAdmin.js';

/** Normalize strings for lightweight matching. */
function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Token overlap score between two strings. */
function overlapScore(a, b) {
  const A = new Set(norm(a).split(' ').filter(Boolean));
  const B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit += 1;
  return hit / Math.max(A.size, B.size);
}

/**
 * Try to match a single review to a job from a candidate list.
 * Jobs: { id, client_name, title, address } (adjust fields to your schema)
 */
function pickBestJob(review, jobs) {
  const cand = [];
  for (const j of jobs) {
    let score = 0;

    // Strong signals
    if (review.author_name && j.client_name) {
      score = Math.max(score, overlapScore(review.author_name, j.client_name) * 2.0);
    }
    // Text-body signals
    score = Math.max(score, overlapScore(review.body, j.title || ''));
    score = Math.max(score, overlapScore(review.body, j.address || '') * 0.8);

    if (score > 0) cand.push({ id: j.id, score });
  }
  cand.sort((a, b) => b.score - a.score);
  const best = cand[0];
  return best && best.score >= 0.5 ? best.id : null; // threshold
}

/**
 * Run matcher for recent reviews missing a job_id.
 * @returns {{ matched: number, scanned: number, errors?: number }}
 */
export async function runJobMatcherForBusiness(business_id, { days = 120 } = {}) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  // Pull candidate reviews
  const { data: reviews, error: rErr } = await supabase
    .from('reviews')
    .select('id, author_name, body, created_at_utc, job_id')
    .eq('business_id', business_id)
    .is('job_id', null)
    .gte('created_at_utc', since)
    .limit(500);
  if (rErr) return { matched: 0, scanned: 0, errors: 1 };

  // Pull jobs (adjust table/columns to your schema)
  const { data: jobs, error: jErr } = await supabase
    .from('jobs')
    .select('id, client_name, title, address')
    .eq('business_id', business_id)
    .limit(1000);
  if (jErr) return { matched: 0, scanned: reviews?.length || 0, errors: 1 };

  let matched = 0;
  for (const rev of reviews || []) {
    const jobId = pickBestJob(rev, jobs || []);
    if (!jobId) continue;

    const { error: upErr } = await supabase
      .from('reviews')
      .update({ job_id: jobId })
      .eq('id', rev.id)
      .eq('business_id', business_id);
    if (!upErr) matched += 1;
  }

  return { matched, scanned: reviews?.length || 0 };
}
