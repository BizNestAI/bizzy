import crypto from "node:crypto";

const DEFAULT_WINDOW_MS = 60_000;
const INTERNAL_HEADERS = new Set(["x-internal-cron-secret", "x-tax-scheduler-secret"]);
const buckets = new Map();

const LIMITS = Object.freeze([
  { name: "tax-export", match: (req) => /export|share/i.test(req.path), max: 8, windowMs: DEFAULT_WINDOW_MS },
  { name: "tax-force-calculation", match: (req) => req.method === "POST" && /calculate|calculations|refresh/i.test(req.path), max: 6, windowMs: DEFAULT_WINDOW_MS },
  { name: "tax-bulk-or-override", match: (req) => /bulk|override|exclude|restore|confirm/i.test(req.path) && ["POST", "PATCH"].includes(req.method), max: 30, windowMs: DEFAULT_WINDOW_MS },
  { name: "tax-mutation", match: (req) => ["POST", "PATCH", "PUT", "DELETE"].includes(req.method), max: 60, windowMs: DEFAULT_WINDOW_MS },
  { name: "tax-deep-read", match: (req) => /components|explanation|confidence|changes|transactions/i.test(req.path), max: 120, windowMs: DEFAULT_WINDOW_MS },
]);

const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]);

export function taxSecurityMiddleware(req, res, next) {
  req.id ||= req.headers?.["x-request-id"] || crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (!ALLOWED_METHODS.has(req.method)) {
    return res.status(405).json({ ok: false, error: { code: "method_not_allowed", message: "HTTP method is not allowed." }, requestId: req.id });
  }
  if (req.method === "OPTIONS") return next();
  if (isTrustedInternal(req)) return next();

  const matched = LIMITS.find((limit) => limit.match(req));
  if (!matched) return next();
  const result = consumeRateLimit({ req, limit: matched });
  res.setHeader("X-RateLimit-Limit", String(matched.max));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, result.remaining)));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
  if (!result.allowed) {
    return res.status(429).json({
      ok: false,
      error: {
        code: "tax_rate_limited",
        message: "Too many Tax requests. Please wait and try again.",
        action: "retry_later",
        retryable: true,
      },
      requestId: req.id,
    });
  }
  return next();
}

export function resetTaxRateLimits() {
  buckets.clear();
}

function consumeRateLimit({ req, limit }) {
  const now = Date.now();
  const key = `${limit.name}:${actorKey(req)}`;
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + limit.windowMs });
    return { allowed: true, remaining: limit.max - 1, resetAt: now + limit.windowMs };
  }
  bucket.count += 1;
  return { allowed: bucket.count <= limit.max, remaining: limit.max - bucket.count, resetAt: bucket.resetAt };
}

function actorKey(req) {
  return [
    req.user?.id || req.user?.sub || "anonymous",
    req.query?.businessId || req.query?.business_id || req.body?.businessId || req.body?.business_id || "no-business",
    req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || req.connection?.remoteAddress || "no-ip",
  ].join(":");
}

function isTrustedInternal(req) {
  const expected = process.env.TAX_SCHEDULER_INTERNAL_SECRET;
  if (!expected) return false;
  for (const header of INTERNAL_HEADERS) {
    if (req.headers?.[header] === expected) return true;
  }
  return false;
}
