const RESTORE_SUPPRESS_MS = 1200;

let installed = false;
let lastHiddenAt = 0;
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
    if (document.visibilityState === "hidden") {
      lastHiddenAt = Date.now();
      return;
    }

    if (lastHiddenAt > 0) {
      setRestoredClass();
    }
  };

  const handlePageShow = (event) => {
    if (event?.persisted) {
      setRestoredClass();
    }
  };

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
