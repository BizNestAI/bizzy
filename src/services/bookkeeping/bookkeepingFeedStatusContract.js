export const CANONICAL_BOOKKEEPING_FEED_STATUSES = Object.freeze([
  "needs_review",
  "handled",
  "posted",
  "matched",
  "pending",
  "excluded",
]);

const STATUS_ALIASES = Object.freeze({
  approved: "handled",
  reconciled: "matched",
});

export class InvalidBookkeepingFeedStatusError extends Error {
  constructor(status) {
    super("invalid_bookkeeping_feed_status");
    this.name = "InvalidBookkeepingFeedStatusError";
    this.code = "invalid_bookkeeping_feed_status";
    this.status = 400;
    this.requestedStatus = status == null ? null : String(status);
  }
}

export function canonicalBookkeepingFeedStatus(status = "needs_review") {
  const normalized = String(status || "needs_review").trim().toLowerCase();
  const canonical = STATUS_ALIASES[normalized] || normalized;
  return CANONICAL_BOOKKEEPING_FEED_STATUSES.includes(canonical) ? canonical : null;
}

export function requireCanonicalBookkeepingFeedStatus(status = "needs_review") {
  const canonical = canonicalBookkeepingFeedStatus(status);
  if (!canonical) throw new InvalidBookkeepingFeedStatusError(status);
  return canonical;
}
