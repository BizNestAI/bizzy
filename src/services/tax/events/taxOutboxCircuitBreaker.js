const RPC = "claim_tax_bookkeeping_change_outbox";

export function isMissingTaxOutboxRpc(error) {
  const code = String(error?.code || "");
  const message = `${error?.message || ""} ${error?.details || ""}`;
  return code === "PGRST202" || code === "42883" ||
    ((Number(error?.status) === 404 || /schema cache|does not exist|could not find/i.test(message)) && message.includes(RPC));
}

// Only the outbox is gated; healthy recalculation/projection queues keep running.
export function createTaxOutboxCircuitBreaker({ run, now = Date.now, logger = console, retryMs = 15 * 60 * 1000 }) {
  const cooldown = Math.min(60 * 60 * 1000, Math.max(5 * 60 * 1000, Number(retryMs) || 15 * 60 * 1000));
  let retryAt = 0;
  let reported = false;
  return async (options) => {
    if (now() < retryAt) return { processed: 0, skipped: true, reason: "missing_outbox_rpc" };
    try {
      const result = await run(options);
      retryAt = 0;
      reported = false;
      return result;
    } catch (error) {
      if (!isMissingTaxOutboxRpc(error)) throw error;
      retryAt = now() + cooldown;
      if (!reported) {
        reported = true;
        logger.error("[tax-bookkeeping-outbox] configuration error; claim RPC missing", { code: error?.code || "404", retry_ms: cooldown });
      }
      return { processed: 0, skipped: true, reason: "missing_outbox_rpc" };
    }
  };
}
