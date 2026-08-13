const SECRET_KEY_RE = /(access[_-]?token|public[_-]?token|processor[_-]?token|client[_-]?secret|plaid[_-]?secret|authorization|bearer|secret|password|key)$/i;

export function redactPlaidSecrets(value, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return "[redacted-depth]";
  if (typeof value === "string") {
    if (/access-sandbox-|access-development-|access-production-|public-sandbox-|processor-/i.test(value)) {
      return "[redacted]";
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactPlaidSecrets(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SECRET_KEY_RE.test(key) ? "[redacted]" : redactPlaidSecrets(entry, depth + 1),
      ])
    );
  }
  return value;
}

export function safePlaidErrorPayload(err) {
  const plaid = err?.response?.data || err?.data || null;
  return {
    error_code: plaid?.error_code || err?.code || null,
    error_type: plaid?.error_type || null,
    display_message: plaid?.display_message || null,
    request_id: plaid?.request_id || null,
  };
}

export function safePlaidClientMessage(err, fallback = "Plaid request failed.") {
  const plaid = err?.response?.data || err?.data || null;
  return plaid?.display_message || plaid?.error_code || err?.code || fallback;
}
