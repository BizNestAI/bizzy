/* global process */
const DEFAULT_POLL_SECONDS = Number(process.env.INTERACTIVE_POSTING_COMMAND_POLL_SECONDS || 1);
const DEFAULT_MAX_BACKOFF_SECONDS = Number(process.env.INTERACTIVE_POSTING_COMMAND_MAX_BACKOFF_SECONDS || 300);

export function isMissingInteractivePostingCommandRpcError(err) {
  const code = String(err?.code || err?.status || "");
  const message = String(err?.message || err?.details || err || "");
  if (code === "42883" || code === "PGRST202" || code === "PGRST203") return true;
  return /claim_bookkeeping_interactive_posting_commands/i.test(message) &&
    /(could not find|function .* does not exist|schema cache|undefined function)/i.test(message);
}

export function nextInteractivePostingPollDelayMs(failureCount, {
  baseSeconds = DEFAULT_POLL_SECONDS,
  maxSeconds = DEFAULT_MAX_BACKOFF_SECONDS,
} = {}) {
  const baseMs = Math.max(1, Number(baseSeconds) || 1) * 1000;
  const maxMs = Math.max(baseMs, (Number(maxSeconds) || 300) * 1000);
  const exponent = Math.max(0, Number(failureCount || 1) - 1);
  return Math.min(maxMs, baseMs * (2 ** exponent));
}
