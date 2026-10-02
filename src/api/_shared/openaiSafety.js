export const SECONDARY_AI_TIMEOUT_MS = 20_000;
export const SECONDARY_AI_MAX_RETRIES = 1;

export function secondaryAiRequestOptions(timeout = SECONDARY_AI_TIMEOUT_MS) {
  return { timeout, maxRetries: SECONDARY_AI_MAX_RETRIES };
}

export function safeProviderLog(error) {
  return {
    name: String(error?.name || 'ProviderError').slice(0, 80),
    code: String(error?.code || 'provider_failure').slice(0, 80),
    status: Number.isInteger(error?.status) ? error.status : null,
  };
}
