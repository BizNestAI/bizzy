import { AsyncLocalStorage } from "node:async_hooks";
const scope = new AsyncLocalStorage();
// Read sharing is request/sweep-local, never a cross-request freshness cache.
export function withTaxSourceReadScope(run) {
  return scope.getStore() ? run() : scope.run(new WeakMap(), run);
}
export function taxSourceRead(client, key, read) {
  const clients = scope.getStore();
  if (!clients) return read();
  let reads = clients.get(client);
  if (!reads) { reads = new Map(); clients.set(client, reads); }
  if (!reads.has(key)) reads.set(key, Promise.resolve().then(read));
  return reads.get(key);
}
