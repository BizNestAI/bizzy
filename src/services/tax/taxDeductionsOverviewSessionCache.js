export const TAX_OVERVIEW_SESSION_CACHE_PREFIX = "bizzi:tax:verified:";

export function readVerifiedTaxOverviewSessionCache(cacheKey) {
  try {
    const raw = storageRef()?.getItem(storageKey(cacheKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Number.isFinite(Number(parsed?.ts)) || parsed?.value == null) return null;
    return { ts: Number(parsed.ts), value: parsed.value };
  } catch {
    return null;
  }
}

export function writeVerifiedTaxOverviewSessionCache(cacheKey, entry) {
  try {
    storageRef()?.setItem(storageKey(cacheKey), JSON.stringify(entry));
  } catch {
    // Storage availability and quota must never prevent a verified network response.
  }
}

export function removeVerifiedTaxOverviewSessionCache(cacheKey) {
  try {
    storageRef()?.removeItem(storageKey(cacheKey));
  } catch {
    // Best-effort cleanup for browsers that deny storage access.
  }
}

export function clearVerifiedTaxOverviewSessionCache(predicate = null) {
  const storage = storageRef();
  if (!storage) return;
  try {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(TAX_OVERVIEW_SESSION_CACHE_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => {
      const cacheKey = key.slice(TAX_OVERVIEW_SESSION_CACHE_PREFIX.length);
      if (!predicate || predicate(cacheKey)) storage.removeItem(key);
    });
  } catch {
    // Best-effort tenant/logout cleanup for browsers that deny storage access.
  }
}

function storageRef() {
  try {
    return globalThis.sessionStorage || globalThis.window?.sessionStorage || null;
  } catch {
    return null;
  }
}

function storageKey(cacheKey) {
  return `${TAX_OVERVIEW_SESSION_CACHE_PREFIX}${cacheKey}`;
}
