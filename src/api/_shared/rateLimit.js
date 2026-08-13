const buckets = new Map();

function clientIp(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "unknown";
}

function defaultKey(req) {
  return [
    req.auth?.userId || req.user?.id || "anon",
    req.business?.id || req.auth?.businessId || "",
    clientIp(req),
  ].join(":");
}

export function createRateLimiter({
  windowMs = 60_000,
  max = 60,
  key = defaultKey,
  code = "rate_limited",
  message = "Too many requests. Try again shortly.",
} = {}) {
  return function rateLimit(req, res, next) {
    const bucketKey = String(key(req) || defaultKey(req));
    const now = Date.now();
    const existing = buckets.get(bucketKey) || [];
    const recent = existing.filter((ts) => now - ts < windowMs);

    if (recent.length >= max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(windowMs / 1000))));
      return res.status(429).json({ ok: false, error: code, code, message });
    }

    recent.push(now);
    buckets.set(bucketKey, recent);
    return next();
  };
}

export function __resetRateLimitBucketsForTests() {
  buckets.clear();
}

