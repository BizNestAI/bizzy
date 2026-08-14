const RESTORE_SUPPRESS_MS = 1200;

let installed = false;
let lastVisibleAt = 0;
let restoreTimer = null;

function setRestoredClass() {
  if (typeof document === "undefined") return;
  lastVisibleAt = Date.now();
  document.documentElement.classList.add("bizzy-tab-restored");

  if (restoreTimer) window.clearTimeout(restoreTimer);
  restoreTimer = window.setTimeout(() => {
    document.documentElement.classList.remove("bizzy-tab-restored");
    restoreTimer = null;
  }, RESTORE_SUPPRESS_MS);
}

export function installTabVisibilityMotionGuard() {
  if (installed || typeof document === "undefined" || typeof window === "undefined") return;
  installed = true;

  const handlePageShow = (event) => {
    if (event?.persisted) {
      setRestoredClass();
    }
  };

  // Normal tab switching should not make the app feel like it refreshed.
  // Only suppress motion when the browser restores a page from bfcache.
  window.addEventListener("pageshow", handlePageShow);
}

export function shouldSuppressTabRestoreMotion(windowMs = RESTORE_SUPPRESS_MS) {
  if (typeof document === "undefined") return false;
  return (
    document.documentElement.classList.contains("bizzy-tab-restored") ||
    (lastVisibleAt > 0 && Date.now() - lastVisibleAt < windowMs)
  );
}
