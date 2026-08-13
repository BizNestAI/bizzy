export function normalizeSupabaseProjectUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  if (/\/(?:rest|auth)\/v1$/i.test(normalizedPath)) {
    parsed.pathname = normalizedPath.replace(/\/(?:rest|auth)\/v1$/i, "") || "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  }

  return trimmed;
}

export function getAuthRedirectTo(path = "/auth/confirm", origin) {
  const baseOrigin =
    origin ||
    (typeof window !== "undefined" && window.location?.origin) ||
    "http://localhost:5173";

  return new URL(path, baseOrigin).href;
}
