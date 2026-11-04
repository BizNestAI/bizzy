// Launch policy: one report at a time per worker, paced between reports.
// Provider Retry-After longer than one minute defers this evaluation rather than
// retrying early. No source-refresh failure is treated as a successful evaluation.
export const SOURCE_REFRESH_POLICY = Object.freeze({
  concurrency: 1,
  paceMs: 250,
  attempts: 3,
  timeoutMs: 30000,
  maxInlineRetryMs: 60000
});
export const waitForSource = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function retryOperatingReport(fetchReport, args, {
  wait = waitForSource,
  random = Math.random
} = {}) {
  for (let attempt = 0; attempt < SOURCE_REFRESH_POLICY.attempts; attempt++) {
    try {
      return await fetchReport(args);
    } catch (error) {
      const status = Number(error?.details?.provider_status ?? error?.status);
      const retryable = status === 429 || status >= 500 && status <= 599;
      const providerDelay = Number(error?.details?.retry_after_ms || 0);
      if (!retryable || attempt + 1 === SOURCE_REFRESH_POLICY.attempts || providerDelay > SOURCE_REFRESH_POLICY.maxInlineRetryMs) throw error;
      await wait(Math.max(providerDelay, 500 * 2 ** attempt + Math.floor(random() * 250)));
    }
  }
}
