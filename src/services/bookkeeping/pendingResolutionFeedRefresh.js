export function invalidatePendingResolutionCaches(businessId, storage) {
  if (!storage) return;
  const prefix = `bizzi:books-review:transactions:${encodeURIComponent(businessId)}:`;
  try {
    const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i));
    keys.filter(key => key?.startsWith(prefix)).forEach(key => storage.removeItem(key));
  } catch { /* A failed cache must not turn a completed operation into failure. */ }
}

export async function refreshPendingResolutionFeeds({ counts, pending, needsReview }) {
  await counts();
  await Promise.all([pending(), needsReview()]);
}
