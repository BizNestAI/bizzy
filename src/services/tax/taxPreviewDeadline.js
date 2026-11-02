// Race the promise itself: AbortSignal is advisory and auth/database adapters
// may remain pending after cancellation. Late results are always ignored.
export async function withTaxPreviewDeadline(task, { signal, timeoutMs = 12_000 } = {}) {
  let timer;
  let onAbort;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal?.aborted) throw Object.assign(new Error("Request cancelled."), { code: "request_aborted" });
        return task();
      }),
      new Promise((_, reject) => {
        onAbort = () => reject(Object.assign(new Error("Request cancelled."), { code: "request_aborted" }));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => reject(Object.assign(new Error("This question couldn’t be loaded in time."), {
          code: "grouped_decision_preview_timeout", retryable: true,
        })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
