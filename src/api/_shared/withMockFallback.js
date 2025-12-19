// src/api/_shared/withMockFallback.js
export async function withMockFallback(fetchReal, fetchMock, { connected, label = 'service', log = console } = {}) {
  try {
    if (connected) return await fetchReal();
    log.info?.(`[${label}] not connected → using mock`);
  } catch (err) {
    log.warn?.(`[${label}] real fetch failed → using mock`, err?.message);
  }
  return await fetchMock();
}
