const snapshots = new Map();
const pending = new Map();
let generation = 0;
const versions = new Map();

export function moduleSessionIdentity() {
  try { const principal = globalThis.localStorage?.getItem('bizzy:session-user') || globalThis.localStorage?.getItem('user_id') || 'anonymous'; return `${principal}:${globalThis.window?.sessionStorage?.getItem('bizzi:admin_view_session') ? 'admin' : 'customer'}:${globalThis.localStorage?.getItem('bizzy:dataMode') || 'auto'}`; }
  catch { return 'anonymous'; }
}
const stable = value => JSON.stringify(value, Object.keys(value || {}).sort());
const keyFor = (module, scope) => `${module}:${moduleSessionIdentity()}:${stable(scope)}`;
const ownerKey = (module, scope) => `${module}:${scope.businessId || ''}`;
const staleError = () => Object.assign(new Error('This module scope changed. Reload its data.'), { code: 'module_scope_invalidated' });
export function moduleCacheGeneration() { return generation; }
export function moduleCacheVersion(module, businessId) { return versions.get(`${module}:${businessId || ""}`) || 0; }
export function readModuleSnapshot(module, scope) { return snapshots.get(keyFor(module, scope)) || null; }
export function writeModuleSnapshot(module, scope, data) {
  const entry = { module, scope, data, updatedAt: Date.now() };
  snapshots.set(keyFor(module, scope), entry);
  return entry;
}
export function invalidateModuleSnapshots(module, businessId) {
  const owners = new Set([`${module}:${businessId || ''}`]);
  for (const [key, entry] of snapshots) if (entry.module === module && (!businessId || entry.scope.businessId === businessId)) {
    owners.add(ownerKey(module, entry.scope)); snapshots.delete(key);
  }
  for (const [key, entry] of pending) if (entry.module === module && (!businessId || entry.scope.businessId === businessId)) {
    owners.add(ownerKey(module, entry.scope)); entry.controller.abort(); pending.delete(key);
  }
  for (const owner of owners) versions.set(owner, (versions.get(owner) || 0) + 1);
}
export function clearModuleSessionCache() {
  generation += 1;
  snapshots.clear(); versions.clear();
  try {
    const storage = globalThis.window?.sessionStorage;
    const keys = Array.from({ length: storage?.length || 0 }, (_, i) => storage.key(i));
    for (const key of keys) if (key?.startsWith('bizzi:books-review:')) storage.removeItem(key);
  } catch { /* Storage can be disabled; the in-memory epoch still changes. */ }
  for (const entry of pending.values()) entry.controller.abort();
  pending.clear();
}
export function observeModuleRead(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
// The shared request owns cancellation and a deadline. Unmounting one consumer
// cannot cancel a prefetch or another component awaiting the same read.
export function dedupeModuleRead(module, scope, load, { signal, timeoutMs = 20000 } = {}) {
  const key = keyFor(module, scope);
  if (pending.has(key)) return observeModuleRead(pending.get(key).promise, signal);
  const epoch = generation;
  const owner = ownerKey(module, scope);
  const version = versions.get(owner) || 0;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(Object.assign(new Error('The module request timed out. Try again.'), { code: 'module_read_timeout' }));
  }, timeoutMs); });
  const entry = { module, scope, controller };
  entry.promise = Promise.race([Promise.resolve().then(() => load(controller.signal)), timeout]).then(value => {
    if (epoch !== generation || version !== (versions.get(owner) || 0)) throw staleError();
    return value;
  }).finally(() => { clearTimeout(timer); if (pending.get(key) === entry) pending.delete(key); });
  pending.set(key, entry);
  return observeModuleRead(entry.promise, signal);
}
if (typeof window !== 'undefined' && window.addEventListener) {
  for (const event of ['bizzy:auth-cleared', 'bizzy:auth-principal-changed', 'bizzy:admin-view-cleared']) window.addEventListener(event, clearModuleSessionCache);
}
