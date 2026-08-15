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

  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      setRestoredClass();
    }
  };

  const handlePageShow = (event) => {
    if (event?.persisted) {
      setRestoredClass();
    }
  };

  // Normal tab switching should not make the app feel like it refreshed.
  // Suppress page-entry motion when Chrome resumes the tab or restores bfcache.
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pageshow", handlePageShow);
}

export function shouldSuppressTabRestoreMotion(windowMs = RESTORE_SUPPRESS_MS) {
  if (typeof document === "undefined") return false;
  return (
    document.documentElement.classList.contains("bizzy-tab-restored") ||
    (lastVisibleAt > 0 && Date.now() - lastVisibleAt < windowMs)
  );
}
