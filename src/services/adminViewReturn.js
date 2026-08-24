export const DEFAULT_ADMIN_VIEW_RETURN_URL = "https://admin.bizzios.com/monthly-review";
export const ADMIN_VIEW_RETURN_MESSAGE = "bizzi:admin-view-return";

export function getAdminViewReturnUrl(returnUrl) {
  const fallback = DEFAULT_ADMIN_VIEW_RETURN_URL;
  const raw = String(returnUrl || fallback).trim();
  try {
    const url = new URL(raw, typeof window !== "undefined" ? window.location.href : fallback);
    if (!/^https?:$/.test(url.protocol)) return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

export function notifyMonthlyReviewOpener(returnUrl) {
  if (typeof window === "undefined") return false;
  const target = getAdminViewReturnUrl(returnUrl);
  const opener = window.opener;
  if (!opener || opener.closed) return false;
  try {
    opener.postMessage({ type: ADMIN_VIEW_RETURN_MESSAGE, returnUrl: target, reload: true }, new URL(target).origin);
    opener.focus?.();
    return true;
  } catch {
    return false;
  }
}

export function closeOrNavigateToMonthlyReview(returnUrl, { preferClose = true } = {}) {
  if (typeof window === "undefined") return;
  const target = getAdminViewReturnUrl(returnUrl);
  if (preferClose) {
    try {
      window.close();
    } catch {
      // Fall through to navigation if close is blocked by browser policy.
    }
    setTimeout(() => {
      if (!window.closed) window.location.assign(target);
    }, 150);
    return;
  }
  window.location.assign(target);
}

export async function endAndReturnToMonthlyReview({ returnUrl, endAdminView, preferClose = true } = {}) {
  const target = getAdminViewReturnUrl(returnUrl);
  try {
    await endAdminView?.();
  } catch {
    // Local authority should still be cleared by the caller's Admin View context.
  }
  const openerNotified = notifyMonthlyReviewOpener(target);
  closeOrNavigateToMonthlyReview(target, { preferClose: preferClose && openerNotified });
}
