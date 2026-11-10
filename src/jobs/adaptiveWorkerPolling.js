export function createPollBackoff({ baseMs = 1000, maxMs = 30000 } = {}) {
  const base = Math.max(1000, Number(baseMs) || 1000);
  const maximum = Math.max(base, Number(maxMs) || 30000);
  let delay = base;
  return {
    reset() { delay = base; return delay; },
    next() { delay = Math.min(maximum, delay * 2); return delay; },
  };
}

// Schedule only after completion: slow or failed sweeps cannot accumulate.
export function createAdaptivePollLoop({ run, hasWork, onError, baseMs = 1000, maxMs = 30000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const backoff = createPollBackoff({ baseMs, maxMs });
  let timer = null;
  let running = false;
  let stopped = true;
  let generation = 0;
  const isCurrent = (epoch) => !stopped && epoch === generation;
  function schedule(delay, epoch) {
    if (!isCurrent(epoch)) return;
    clearTimer(timer);
    timer = setTimer(() => {
      if (!isCurrent(epoch)) return;
      timer = null;
      return tick(epoch);
    }, delay);
    timer?.unref?.();
  }
  async function tick(epoch = generation) {
    if (!isCurrent(epoch)) return;
    if (running) {
      // A restarted generation waits for the previous sweep without overlapping it.
      schedule(Math.max(1000, Number(baseMs) || 1000), epoch);
      return;
    }
    clearTimer(timer);
    timer = null;
    running = true;
    let delay;
    try {
      const result = await run();
      if (!isCurrent(epoch)) return;
      delay = hasWork(result) ? backoff.reset() : backoff.next();
    } catch (error) {
      if (!isCurrent(epoch)) return;
      delay = backoff.next();
      onError(error);
    } finally {
      running = false;
      schedule(delay, epoch);
    }
  }
  return {
    start() { if (stopped) { stopped = false; generation++; schedule(backoff.reset(), generation); } },
    stop() { stopped = true; generation++; clearTimer(timer); timer = null; },
    tick,
  };
}
