export const TOAST_DEFAULT_TIMEOUT = 4500;
export const TOAST_SEVERITIES = new Set(["success", "warning", "error", "info"]);

export function normalizeToast(detail = {}, id = "toast") {
  const severity = TOAST_SEVERITIES.has(detail.severity) ? detail.severity : "info";
  const action = detail.action && typeof detail.action === "object"
    ? { label: detail.action.label || "View", onClick: detail.action.onClick }
    : detail.actionLabel
      ? { label: detail.actionLabel, onClick: detail.onAction }
      : null;
  return {
    ...detail,
    id,
    severity,
    title: detail.title || "Notice",
    description: detail.description ?? detail.body ?? "",
    action,
    timeout: detail.timeout ?? TOAST_DEFAULT_TIMEOUT,
    dedupeKey: detail.dedupeKey || [severity, detail.operationId, detail.transactionId, detail.title, detail.description ?? detail.body].filter(Boolean).join(":"),
  };
}

export function shouldReduceToastMotion(matchMedia = globalThis?.window?.matchMedia) {
  return Boolean(matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

export function createToastCountdown({ timeout, onElapsed, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let remaining = timeout;
  let startedAt = 0;
  let timer = null;
  return {
    resume() {
      if (timeout <= 0 || timer !== null) return;
      startedAt = now();
      timer = setTimer(() => {
        timer = null;
        remaining = 0;
        onElapsed();
      }, remaining);
    },
    pause() {
      if (timer === null) return;
      clearTimer(timer);
      timer = null;
      remaining = Math.max(0, remaining - (now() - startedAt));
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    remaining() { return remaining; },
  };
}

export function appendUniqueToast(current, toast) {
  return current.some((item) => item.dedupeKey === toast.dedupeKey) ? current : [...current, toast];
}
