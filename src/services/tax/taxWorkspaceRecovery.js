import { withTaxPreviewDeadline } from "./taxPreviewDeadline.js";

// Discover a published replacement first; otherwise request one rebuild and
// poll. A cache-bypassed read of the same completed projection is not recovery.
export async function recoverTaxWorkspaceProjection({ previousProjectionId, readWorkspace, requestRebuild, signal,
  timeoutMs = 8_000, pollMs = 500 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const replacement = (value) => value?.projectionId && value.projectionId !== previousProjectionId
    && value.sourceFingerprint && value.projection?.status === "complete";
  try {
    return await withTaxPreviewDeadline(async () => {
      let value = await readWorkspace({ signal: controller.signal });
      if (controller.signal.aborted) return;
      if (replacement(value)) return value;
      await requestRebuild({ previousProjectionId, signal: controller.signal });
      while (!controller.signal.aborted) {
        value = await readWorkspace({ signal: controller.signal });
        if (controller.signal.aborted) return;
        if (replacement(value)) return value;
        await pause(pollMs, controller.signal);
      }
    }, { signal: controller.signal, timeoutMs });
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", abort);
  }
}

function pause(ms, signal) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
