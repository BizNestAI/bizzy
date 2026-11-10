import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { backgroundWorkerStartupDecision, startBackgroundWorkers } from '../src/jobs/backgroundWorkerStartup.js';
import { createAdaptivePollLoop, createPollBackoff } from '../src/jobs/adaptiveWorkerPolling.js';
import { isMissingInteractivePostingCommandRpcError, nextInteractivePostingPollDelayMs } from '../src/jobs/interactivePostingCommandWorkerDiagnostics.js';
import { createTaxOutboxCircuitBreaker, isMissingTaxOutboxRpc } from '../src/services/tax/events/taxOutboxCircuitBreaker.js';

const railway = { NODE_ENV: 'production', RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_PROJECT_ID: 'project', RAILWAY_SERVICE_ID: 'service' };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function timers() {
  const pending = new Map();
  let id = 0;
  return {
    pending,
    setTimeout(fn, ms) { const key = ++id; pending.set(key, { fn, ms }); return key; },
    clearTimeout(key) { pending.delete(key); },
    async fire() { const [key, job] = pending.entries().next().value; pending.delete(key); await job.fn(); await flush(); },
    delay() { return [...pending.values()].at(-1)?.ms; },
  };
}

test('startup is fail closed locally, including production Supabase and NODE_ENV alone; overrides and global disable', () => {
  for (const env of [{}, { NODE_ENV: 'development', SUPABASE_URL: 'https://zwufvvrmjbymgyjntdzk.supabase.co' }, { NODE_ENV: 'production' }, { ...railway, NODE_ENV: 'development' }, { ...railway, RAILWAY_ENVIRONMENT_NAME: 'staging' }, { ...railway, RAILWAY_PROJECT_ID: '' }, { ...railway, RAILWAY_SERVICE_ID: '' }]) {
    assert.equal(backgroundWorkerStartupDecision(env).enabled, false);
  }
  assert.equal(backgroundWorkerStartupDecision(railway).enabled, true);
  assert.equal(backgroundWorkerStartupDecision({ ...railway, RAILWAY_DEPLOYMENT_ID: '' }).enabled, true);
  assert.equal(backgroundWorkerStartupDecision({ ...railway, RAILWAY_DEPLOYMENT_ID: 'optional' }).enabled, true);
  assert.equal(backgroundWorkerStartupDecision({ BACKGROUND_WORKERS_OVERRIDE: 'true' }).enabled, true);
  assert.equal(backgroundWorkerStartupDecision({ ...railway, BACKGROUND_WORKERS_OVERRIDE: 'false' }).enabled, false);
  assert.equal(backgroundWorkerStartupDecision({ ...railway, BACKGROUND_WORKERS_OVERRIDE: 'typo' }).enabled, false);
  assert.equal(backgroundWorkerStartupDecision({ ...railway, BACKGROUND_WORKERS_OVERRIDE: 'true', DISABLE_BACKGROUND_WORKERS: 'true' }).enabled, false);
  assert.equal(backgroundWorkerStartupDecision({ BACKGROUND_WORKERS_OVERRIDE: 'true', DISABLE_BACKGROUND_WORKERS: 'true' }).enabled, false);
});

test('Railway production without a deployment ID starts workers; development without an override does not', () => {
  let starts = 0;
  const workers = [() => { starts++; }];
  const logger = { info() {} };
  assert.equal(startBackgroundWorkers({ workers, env: railway, logger }).enabled, true);
  assert.equal(starts, 1);
  assert.equal(startBackgroundWorkers({ workers, env: { ...railway, NODE_ENV: 'development' }, logger }).enabled, false);
  assert.equal(starts, 1);
});

test('actual server registration starts all expected stubs only on Railway; local HTTP listen remains outside gate', () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const registration = source.slice(source.indexOf('startBackgroundWorkers({ workers:'), source.indexOf('\nexport default app;'));
  const expected = ['startForecastCron', 'startBooksPostingCron', 'startInteractivePostingCommandWorker', 'startBookkeepingProcessingWorker', 'startOperatorRequestSummaryCron', 'startPlaidDailySyncCron', 'startContractorCfoInsightsCron', 'startTaxClassificationWorker', 'startTaxRecalculationWorker', 'startTaxScheduler', 'startQboJobCostingSyncCron', 'startQboFinancialHealthCron', 'startMonthlyFinancialPulseCron', 'startReconciliationCron'];
  assert.ok(source.indexOf('app.listen(PORT') < source.indexOf('startBackgroundWorkers({ workers:'));
  for (const env of [{}, railway, { ...railway, DISABLE_RECON_CRON: 'true' }]) {
    const calls = [], logs = [];
    const context = { process: { env }, console: { info() {} }, startBackgroundWorkers: (options) => startBackgroundWorkers({ ...options, env, logger: { info: (m) => logs.push(m) } }) };
    for (const name of expected) context[name] = () => calls.push(name);
    vm.runInNewContext(registration, context);
    assert.deepEqual(calls, env === railway ? expected : env.DISABLE_RECON_CRON ? expected.slice(0, -1) : []);
    assert.equal(logs.length, 1);
  }
});

test('adaptive cadence reaches 30s for idle/errors and resets on work', () => {
  const b = createPollBackoff();
  assert.deepEqual(Array.from({ length: 6 }, () => b.next()), [2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(b.reset(), 1000);
  assert.equal(b.next(), 2000);
});

test('merchant production adapter backs off, resets for scanned work, preserves overlap flag and skips empty timeline logs', async () => {
  const source = readFileSync(new URL('../src/jobs/booksPost.cron.js', import.meta.url), 'utf8');
  const adapter = source.slice(source.indexOf('  createAdaptivePollLoop({'), source.indexOf('  setInterval(() => {\n    if (vendorRuleLearningQueueRunning)'));
  const clock = timers(); let response = { merchant_approval_operations: { scanned: 0 } }, calls = 0, reject = false, release;
  const context = vm.createContext({ queueIntervalMs: 1000, merchantApprovalQueueRunning: false, createAdaptivePollLoop: (o) => createAdaptivePollLoop({ ...o, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout }), runMerchantApprovalQueueOnce: async () => { calls++; if (release) await new Promise((r) => { release.resolve = r; }); if (reject) throw new Error('stub failure'); return response; }, log: { error() {} }, sanitizedErrorClass: () => 'stub' });
  vm.runInContext(adapter, context);
  await clock.fire(); assert.equal(clock.delay(), 2000);
  await clock.fire(); assert.equal(clock.delay(), 4000);
  response = { merchant_approval_operations: { scanned: 1 } };
  await clock.fire(); assert.equal(clock.delay(), 1000);
  reject = true; await clock.fire(); assert.equal(clock.delay(), 2000);
  reject = false; release = {};
  const pending = clock.fire(); await flush(); assert.equal(context.merchantApprovalQueueRunning, true);
  assert.equal(clock.pending.size, 0); // nothing can overlap while awaiting the sweep
  release.resolve(); await pending; assert.equal(context.merchantApprovalQueueRunning, false);
  assert.equal(calls, 5);
  assert.match(source, /for \(const operationId of options\?\.targeted \?/);
});

test('adaptive scheduler prevents concurrent tick and does not reschedule after stop during a sweep', async () => {
  const clock = timers(); let release, calls = 0;
  const loop = createAdaptivePollLoop({ setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, run: async () => { calls++; await new Promise((r) => { release = r; }); return {}; }, hasWork: () => false, onError() {} });
  loop.start(); const pending = clock.fire(); await flush();
  await loop.tick(); assert.equal(calls, 1);
  loop.stop(); release(); await pending; assert.equal(clock.pending.size, 0);
});

test('stop/restart invalidates the old sweep and leaves only the current generation polling', async () => {
  for (const timerFiresBeforeCompletion of [false, true]) {
    for (const oldSweepFails of [false, true]) {
      const clock = timers(); let finishOld, calls = 0, errors = 0, classifications = 0;
      const loop = createAdaptivePollLoop({
        setTimer: clock.setTimeout, clearTimer: clock.clearTimeout,
        run: async () => {
          calls++;
          if (calls === 1) return new Promise((resolve, reject) => { finishOld = () => oldSweepFails ? reject(new Error('stale failure')) : resolve({ work: false }); });
          return { work: calls === 3 };
        },
        hasWork: (result) => { classifications++; return result.work; },
        onError: () => { errors++; },
      });
      loop.start();
      const oldSweep = clock.fire(); await flush();
      assert.equal(calls, 1);
      loop.stop(); loop.start(); loop.start();
      assert.equal(clock.pending.size, 1);
      if (timerFiresBeforeCompletion) {
        await clock.fire();
        assert.equal(calls, 1); // old sweep still owns the overlap guard
        assert.equal(clock.pending.size, 1);
      }
      const currentTimer = [...clock.pending.keys()][0];
      finishOld(); await oldSweep;
      assert.deepEqual([...clock.pending.keys()], [currentTimer]);
      assert.equal(clock.delay(), 1000);
      assert.equal(errors, 0); assert.equal(classifications, 0); // stale completion cannot mutate backoff
      await clock.fire(); assert.equal(calls, 2); assert.equal(clock.delay(), 2000);
      assert.equal(clock.pending.size, 1);
      await clock.fire(); assert.equal(calls, 3); assert.equal(clock.delay(), 1000);
      assert.equal(clock.pending.size, 1);
      loop.stop(); assert.equal(clock.pending.size, 0);
    }
  }
});

// Evaluate the actual worker with every static import replaced by an explicit
// stub/pure helper. Unknown imports, dynamic imports and network access fail closed.
function isolatedWorker(path, bindings, runtime, exports) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8');
  source = source.replace(/import\s+\{([\s\S]*?)\}\s+from\s+["'][^"']+["'];/g, (_match, names) => {
    for (const name of names.split(',').map((n) => n.trim()).filter(Boolean)) {
      assert.ok(Object.hasOwn(bindings, name), 'Unstubbed worker import: ' + name);
    }
    return '';
  });
  source = source.replace(/export default /g, 'const defaultExport = ').replace(/export (async )?function /g, '$1function ');
  const forbidden = () => { throw new Error('Production/provider I/O forbidden in containment tests'); };
  const context = vm.createContext({ ...bindings, ...runtime, fetch: forbidden });
  return new vm.Script(source + '\n;({' + exports.join(',') + '})', { importModuleDynamically: forbidden }).runInContext(context);
}

async function interactiveHarness() {
  const clock = timers(); let rows = [], error = null, claimCount = 0, processed = 0, release;
  const forbidden = () => { throw new Error('Production/provider I/O forbidden in containment tests'); };
  const worker = isolatedWorker('../src/jobs/interactivePostingCommands.worker.js', {
    createPollBackoff, isMissingInteractivePostingCommandRpcError, nextInteractivePostingPollDelayMs,
    supabase: new Proxy({}, { get: forbidden }), postSingleBookkeepingTransactionNow: forbidden,
    appendInteractivePostingCommandEvent: forbidden,
    claimInteractivePostingCommands: async () => { claimCount++; if (release) await new Promise((r) => { release.resolve = r; }); if (error) throw error; return rows; },
    processInteractivePostingCommand: async () => { processed++; return { ok: true }; },
  }, { process: { env: {}, pid: 1 }, console: { info() {}, warn() {}, error() {} }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, queueMicrotask: forbidden }, ['startInteractivePostingCommandWorker', 'stopInteractivePostingCommandWorker']);
  return { worker, clock, setRows: (v) => { rows = v; }, setError: (v) => { error = v; }, counts: () => ({ claimCount, processed }), hold: () => { release = {}; return release; } };
}

test('actual interactive worker idles/errors to 30s, resumes fast on claims, preserves missing-RPC backoff and stop/overlap', async () => {
  const h = await interactiveHarness(); h.worker.startInteractivePostingCommandWorker();
  for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) { await h.clock.fire(); assert.equal(h.clock.delay(), delay); }
  h.setRows([{ operation_id: 'stub-only' }]); await h.clock.fire(); assert.equal(h.clock.delay(), 1000);
  assert.equal(h.counts().processed, 1); // synthetic processing only; posting stub throws if called
  h.setRows([]); h.setError({ code: 'NETWORK_ERROR' });
  for (const delay of [2000, 4000, 8000, 16000, 30000]) { await h.clock.fire(); assert.equal(h.clock.delay(), delay); }
  h.setError({ code: 'PGRST202' });
  for (let i = 0; i < 12; i++) await h.clock.fire();
  assert.equal(h.clock.delay(), 300000);
  h.setError(null); h.setRows([{ operation_id: 'stub-only' }]); await h.clock.fire(); assert.equal(h.clock.delay(), 1000);
  const hold = h.hold(); const pending = h.clock.fire(); await flush();
  assert.equal(h.clock.pending.size, 0); const before = h.counts().claimCount;
  h.worker.startInteractivePostingCommandWorker(); assert.equal(h.counts().claimCount, before);
  await h.worker.stopInteractivePostingCommandWorker(); hold.resolve(); await pending; assert.equal(h.clock.pending.size, 0);
});

test('tax missing-RPC breaker logs once, skips for 15m, retries boundedly, resets after recovery, propagates ordinary failures', async () => {
  let now = 0, calls = 0, logs = 0, error = { code: 'PGRST202', message: 'missing claim_tax_bookkeeping_change_outbox' };
  const run = createTaxOutboxCircuitBreaker({ now: () => now, logger: { error() { logs++; } }, run: async () => { calls++; if (error) throw error; return { processed: 0 }; } });
  await run(); for (let i = 0; i < 14; i++) { now += 60000; await run(); }
  assert.equal(calls, 1); assert.equal(logs, 1);
  now = 900000; await run(); assert.equal(calls, 2); assert.equal(logs, 1);
  error = null; now += 900000; await run();
  error = { status: 404, message: 'Could not find claim_tax_bookkeeping_change_outbox in schema cache' }; await run(); assert.equal(logs, 2);
  assert.equal(isMissingTaxOutboxRpc({ status: 404, message: 'unrelated route' }), false);
  now += 900000; error = new Error('ordinary failure'); await assert.rejects(run(), /ordinary failure/);
});

test('actual tax worker gates only missing outbox, keeps healthy queues running and prevents overlapping sweeps', async () => {
  let now = 0, interval, warnings = 0, configLogs = 0, recalcs = 0, projections = 0, outboxes = 0, release;
  const forbidden = () => { throw new Error('Production/provider I/O forbidden'); };
  const worker = isolatedWorker('../src/services/tax/events/taxRecalculationWorker.service.js', {
    supabase: new Proxy({}, { get: forbidden }),
    createTaxOutboxCircuitBreaker: (options) => createTaxOutboxCircuitBreaker({ ...options, now: () => now, logger: { error() { configLogs++; } } }),
    processPendingTaxRecalculationRequests: async () => { recalcs++; if (release) await new Promise((resolve) => { release.resolve = resolve; }); return { processed: 0 }; },
    processTaxWorkspaceProjectionRequests: async () => { projections++; return { processed: 0 }; },
    processTaxBookkeepingChangeOutbox: async () => { outboxes++; throw { code: 'PGRST202' }; },
  }, {
    process: { env: {}, pid: 1 }, console: { info() {}, warn() { warnings++; } },
    setInterval: (fn) => { interval = fn; return 1; }, clearInterval() {},
  }, ['startTaxRecalculationWorker', 'stopTaxRecalculationWorker']);
  worker.startTaxRecalculationWorker(); await flush();
  for (let i = 1; i < 15; i++) { now = i * 60000; interval(); await flush(); }
  assert.equal(recalcs, 15); assert.equal(projections, 15); assert.equal(outboxes, 1);
  assert.equal(configLogs, 1); assert.equal(warnings, 0);
  now = 900000; interval(); await flush(); assert.equal(outboxes, 2); assert.equal(configLogs, 1);
  release = {}; interval(); await flush(); const before = recalcs;
  interval(); await flush(); assert.equal(recalcs, before);
  release.resolve(); await flush(); worker.stopTaxRecalculationWorker();
});
