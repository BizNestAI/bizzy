import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModuleDataState, unsafeModuleError } from '../src/services/modules/moduleDataState.js';
import { clearModuleSessionCache, dedupeModuleRead, readModuleSnapshot, writeModuleSnapshot, invalidateModuleSnapshots } from '../src/services/modules/moduleSessionCache.js';

for (const module of ['financials', 'jobs', 'tax']) {
 test(`${module}: cold, ready, stale refresh, failure, and scope change use one contract`, () => {
  assert.equal(resolveModuleDataState({}), 'initial_loading');
  assert.equal(resolveModuleDataState({ hasData: true }), 'ready');
  assert.equal(resolveModuleDataState({ hasData: true, fetching: true }), 'refreshing');
  assert.equal(resolveModuleDataState({ hasData: true, error: new Error('offline') }), 'error_with_cache');
  assert.equal(resolveModuleDataState({ error: new Error('offline') }), 'error_without_cache');
  assert.equal(resolveModuleDataState({ hasData: true, scopeMatches: false }), 'scope_changing');
 });
}
test('same-session return retains a usable empty snapshot and distinct business/year/account scopes never alias', () => {
 clearModuleSessionCache();
 const scope = { businessId: 'a', year: 2026, account: 'checking' };
 writeModuleSnapshot('financials', scope, []);
 assert.deepEqual(readModuleSnapshot('financials', scope).data, []);
 assert.equal(readModuleSnapshot('financials', { ...scope, businessId: 'b' }), null);
 assert.equal(readModuleSnapshot('financials', { ...scope, year: 2025 }), null);
 assert.equal(readModuleSnapshot('financials', { ...scope, account: 'credit' }), null);
});
test('logout and principal change prevent unsafe reuse and late response resurrection', async () => {
 clearModuleSessionCache();
 const scope = { businessId: 'a' }; let finish;
 writeModuleSnapshot('jobs', scope, { jobs: [] });
 const pending = dedupeModuleRead('jobs', scope, () => new Promise(resolve => { finish = resolve; }));
 await Promise.resolve();
 clearModuleSessionCache(); finish({ jobs: ['old-session'] });
 await assert.rejects(pending, error => error.code === 'module_scope_invalidated');
 assert.equal(readModuleSnapshot('jobs', scope), null);
});
test('simultaneous same-scope requests deduplicate and a departing consumer cannot abort another', async () => {
 clearModuleSessionCache(); let finish; let calls = 0;
 const controller = new AbortController(); const scope = { businessId: 'a', resource: 'jobs' };
 const load = () => { calls += 1; return new Promise(resolve => { finish = resolve; }); };
 const first = dedupeModuleRead('jobs', scope, load, { signal: controller.signal });
 const second = dedupeModuleRead('jobs', scope, load);
 await Promise.resolve(); controller.abort();
 await assert.rejects(first); finish({ jobs: [] });
 assert.deepEqual(await second, { jobs: [] }); assert.equal(calls, 1);
});
test('mutation invalidation affects only the named module and business, and invalidates old responses', async () => {
 clearModuleSessionCache(); const a = { businessId: 'a' }; const b = { businessId: 'b' }; let finish;
 writeModuleSnapshot('jobs', a, []); writeModuleSnapshot('tax', a, []); writeModuleSnapshot('jobs', b, []);
 const read = dedupeModuleRead('jobs', a, () => new Promise(resolve => { finish = resolve; }));
 await Promise.resolve(); invalidateModuleSnapshots('jobs', 'a'); finish([]);
 await assert.rejects(read, error => error.code === 'module_scope_invalidated');
 assert.equal(readModuleSnapshot('jobs', a), null);
 assert.ok(readModuleSnapshot('tax', a)); assert.ok(readModuleSnapshot('jobs', b));
});
test('scope or authorization failures are unsafe; a transient offline error allows visibly stale data', () => {
 assert.equal(unsafeModuleError({ status: 403 }), true);
 assert.equal(unsafeModuleError({ status: 401 }), true);
 assert.equal(unsafeModuleError({ code: 'module_scope_invalidated' }), true);
 assert.equal(unsafeModuleError(new Error('offline')), false);
});
test('a retained module read has an explicit deadline',async()=>{
 await assert.rejects(dedupeModuleRead('jobs',{businessId:'deadline'},()=>new Promise(()=>{}),{timeoutMs:10}),error=>error.code==='module_read_timeout');
});
