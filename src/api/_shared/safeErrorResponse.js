const SENSITIVE_KEY_RE = /(token|secret|password|authorization|bearer|service[_-]?role|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|stack|meta|details|hint|query|sql|body|payload|response)/i;

export function isProductionEnv(env = process.env) {
  return env.NODE_ENV === "production";
}

export function getErrorStatus(err, fallback = 500) {
  const status = Number(err?.status || err?.statusCode || fallback);
  if (!Number.isInteger(status) || status < 400 || status > 599) return fallback;
  return status;
}

export function redactErrorForLog(value, depth = 0) {
  if (value == null) return value;
  if (depth > 4) return "[redacted]";
  if (typeof value === "string") {
    return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  }
  if (Array.isArray(value)) return value.map((entry) => redactErrorForLog(entry, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY_RE.test(key) ? "[redacted]" : redactErrorForLog(entry, depth + 1),
      ])
    );
  }
  return value;
}

export function buildSafeErrorResponse(err, { env = process.env, fallbackCode = "INTERNAL_ERROR" } = {}) {
  const status = getErrorStatus(err);
  const production = isProductionEnv(env);
  const code = err?.code || err?.errorCode || fallbackCode;
  const expose = err?.expose === true || status < 500;
  const message = production && !expose
    ? "Internal Server Error"
    : err?.safeMessage || err?.message || "Internal Server Error";

  const body = {
    ok: false,
    error: code,
    message,
  };

  if (!production && err?.meta) body.meta = redactErrorForLog(err.meta);
  return { status, body };
}
