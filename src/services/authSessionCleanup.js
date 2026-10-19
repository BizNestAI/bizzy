const AUTH_STORAGE_KEYS = [
  "access_token",
  "user_id",
  "business_id",
  "currentBusinessId",
  "isProfileComplete",
  "bizzy:businessName",
  "bizzy:business_name",
  "bizzy:industry",
  "bizzy:lastSeedPrompt",
  "bizzy:session-user",
];

const CUSTOMER_CACHE_PREFIXES = [
  "bizzy:seed:",
  "bizzy:hiddenSeed:",
  "bizzy:lastSeedPrompt:",
  "bizzy:pending-chat:",
  "bizzy:read:",
  "bizzy:insight:animated:",
  "bizzy:business-quick-prompts:",
  "bizzy:chatGreeting:",
  "bizzy:greeting:lastTyped:",
];

function removeCustomerCacheEntries(storage) {
  if (!storage) return;
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && CUSTOMER_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

export function clearStoredAuthAndBusinessState() {
  if (typeof window === "undefined") return;
  for (const key of AUTH_STORAGE_KEYS) {
    try {
      window.localStorage?.removeItem(key);
    } catch {
      /* ignore */
    }
  }
  try { removeCustomerCacheEntries(window.localStorage); } catch { /* ignore */ }
  try { removeCustomerCacheEntries(window.sessionStorage); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("bizzy:auth-cleared"));
}

export function markStoredSessionIdentity(userId) {
  if (typeof window === "undefined") return;
  try {
    if (userId) window.localStorage?.setItem("bizzy:session-user", String(userId));
    else window.localStorage?.removeItem("bizzy:session-user");
  } catch {
    /* ignore */
  }
}

export function clearStoredBusinessState() {
  if (typeof window === "undefined") return;
  for (const key of AUTH_STORAGE_KEYS.filter((item) => item !== "access_token" && item !== "user_id")) {
    try {
      window.localStorage?.removeItem(key);
    } catch {
      /* ignore */
    }
  }
  window.dispatchEvent(new CustomEvent("bizzy:business-changed", { detail: { businessId: null } }));
}
