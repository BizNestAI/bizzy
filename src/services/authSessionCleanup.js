const AUTH_STORAGE_KEYS = [
  "access_token",
  "user_id",
  "business_id",
  "currentBusinessId",
  "isProfileComplete",
  "bizzy:businessName",
  "bizzy:business_name",
  "bizzy:industry",
  "bizzy:has_viewed_integrations_page",
  "bizzy:visitedIntegrations",
  "bizzy:force_onboarding_complete",
  "bizzy:onboarding_completed_once",
  "bizzy:qb_connected",
  "bizzy:plaid_connected",
];

export function clearStoredAuthAndBusinessState() {
  if (typeof window === "undefined") return;
  for (const key of AUTH_STORAGE_KEYS) {
    try {
      window.localStorage?.removeItem(key);
    } catch {
      /* ignore */
    }
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
}
