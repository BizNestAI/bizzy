const SENSITIVE_QBO_KEYS = /^(access_token|refresh_token|oauth_token|authorization|authorization_code|code|client_secret|qb_client_secret|quickbooks_client_secret)$/i;
const SENSITIVE_QBO_TEXT = /(access_token|refresh_token|client_secret|authorization|bearer\s+[a-z0-9._-]+)/i;

export function redactQboSecrets(value, depth = 0) {
  if (depth > 6) return "[redacted]";
  if (value == null) return value;
  if (typeof value === "string") {
    return SENSITIVE_QBO_TEXT.test(value) ? "[redacted]" : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactQboSecrets(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_QBO_KEYS.test(key) ? "[redacted]" : redactQboSecrets(item, depth + 1),
      ])
    );
  }
  return value;
}

export function safeQboClientError(code = "QBO_CONNECTION_FAILED") {
  return { error: code };
}
