const ADMIN_HOSTS = new Set(["admin.bizzios.com"]);
const CUSTOMER_HOSTS = new Set(["app.bizzios.com"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

function parseHosts(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function resolveApplicationSurface(hostname = "") {
  const host = String(hostname || "").trim().toLowerCase();
  const env = (typeof import.meta !== "undefined" && import.meta.env) || {};
  const adminHosts = new Set([...ADMIN_HOSTS, ...parseHosts(env.VITE_BIZZI_ADMIN_HOSTS)]);
  const customerHosts = new Set([...CUSTOMER_HOSTS, ...parseHosts(env.VITE_BIZZI_CUSTOMER_HOSTS)]);

  if (adminHosts.has(host)) return "admin";
  if (LOCAL_HOSTS.has(host) || host.endsWith(".localhost")) return "development";
  if (customerHosts.has(host)) return "customer";
  return "customer";
}

export function getCurrentApplicationSurface() {
  const hostname = typeof window !== "undefined" ? window.location.hostname : "";
  return resolveApplicationSurface(hostname);
}

export function getAdminRoutePath(route, surface = getCurrentApplicationSurface()) {
  const prefix = surface === "development" ? "/admin" : "";
  const routes = {
    root: prefix || "/",
    login: `${prefix}/login`,
    monthlyReview: `${prefix}/monthly-review`,
  };
  return routes[route] || routes.root;
}

export function isProductionAdminSurface(surface = getCurrentApplicationSurface()) {
  return surface === "admin";
}
