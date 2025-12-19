// src/server/heroInsights/shared/selectHero.js

/**
 * Selects the top hero insight using a simple score.
 * Each candidate: { id, title, summary?, metric?, delta?, severity?, impact, confidence, freshness, relevance }
 */
export function selectHero(candidates = []) {
  if (!Array.isArray(candidates) || !candidates.length) return null;

  const scored = candidates
    .map((c) => ({
      ...c,
      _score:
        (c.impact ?? 0) * 0.40 +
        (c.confidence ?? 0) * 0.25 +
        (c.freshness ?? 0) * 0.20 +
        (c.relevance ?? 0) * 0.15,
    }))
    .sort((a, b) => b._score - a._score);

  const top = scored[0];
  const threshold = 0.5; // tweak for your domain
  return top && top._score >= threshold ? top : null;
}
