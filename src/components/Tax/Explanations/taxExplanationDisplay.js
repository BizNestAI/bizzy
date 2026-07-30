export function formatMoney(value, fallback = "Not available") {
  if (value == null || Number.isNaN(Number(value))) return fallback;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value));
}

export function formatNumber(value, fallback = "Not available") {
  if (value == null || Number.isNaN(Number(value))) return fallback;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Number(value));
}

export function formatPercent(value, fallback = "Not available") {
  if (value == null || Number.isNaN(Number(value))) return fallback;
  const n = Number(value);
  return `${Math.round((Math.abs(n) <= 1 ? n * 100 : n) * 10) / 10}%`;
}

export function formatDate(value, fallback = "Not available") {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function labelize(value) {
  if (!value) return "Not available";
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}

export function dedupeByCode(items = []) {
  const seen = new Set();
  return normalizeList(items).filter((item) => {
    const key = item?.code || item?.key || item?.message || JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function routeForAction(action = {}) {
  const route = action.route || action.href || action.path;
  if (!route) return null;
  const normalized = route.startsWith("/") ? route : `/${route}`;
  const ROUTE_MAP = {
    "/tax/deductions/review": "/dashboard/tax",
    "/tax/deductions": "/dashboard/tax",
    "/tax/payments": "/dashboard/tax",
    "/tax/profile": "/dashboard/tax",
    "/tax/reserve": "/dashboard/tax",
    "/tax/setup": "/dashboard/tax",
  };
  return ROUTE_MAP[normalized] || normalized;
}

export function severityBucket(item = {}) {
  const severity = String(item.severity || item.materiality || item.level || "").toLowerCase();
  if (["fatal", "blocking", "critical", "high"].includes(severity)) return "blocking";
  if (["major", "medium", "material"].includes(severity)) return "material";
  if (["deferred", "unsupported"].includes(severity) || item.deferred === true) return "deferred";
  return "informational";
}

export function boundedRefs(refs = [], limit = 6) {
  const list = normalizeList(refs);
  return { visible: list.slice(0, limit), hiddenCount: Math.max(0, list.length - limit), total: list.length };
}

export function safeFormulaValue(value) {
  if (value == null) return "Not available";
  if (typeof value === "number") return Number.isFinite(value) ? formatNumber(value) : "Not available";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
