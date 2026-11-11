// Process-local, bounded caches. Client identity and the full tenant/account/run
// scope isolate entries. Mutable progress expires quickly; errors are never cached.
export function createProcessingProgressCache({ now = Date.now, resultTtlMs = 2000, membershipTtlMs = 300000, maxEntries = 128, maxMembers = 20000 } = {}) {
  const clients = new WeakMap();
  function maps(db) {
    if (!clients.has(db)) clients.set(db, { results: new Map(), membership: new Map() });
    return clients.get(db);
  }
  async function read(map, key, load, ttl, weightLimit) {
    for (const [k, entry] of map) if (entry.expires <= now()) map.delete(k);
    const existing = map.get(key);
    if (existing) return structuredClone(await existing.promise);
    while (map.size >= maxEntries) map.delete(map.keys().next().value);
    // A hung loader cannot pin a scope's coalescing entry indefinitely.
    const entry = { expires: now() + 10000, weight: 0 };
    entry.promise = Promise.resolve().then(load);
    map.set(key, entry);
    try {
      const value = await entry.promise;
      entry.expires = now() + ttl;
      entry.weight = Array.isArray(value) ? value.length : 1;
      let weight = [...map.values()].reduce((sum, e) => sum + e.weight, 0);
      while (weight > weightLimit && map.size) {
        const oldest = map.keys().next().value;
        weight -= map.get(oldest).weight;
        map.delete(oldest);
      }
      return structuredClone(value);
    } catch (error) {
      if (map.get(key) === entry) map.delete(key);
      throw error;
    }
  }
  return {
    result: (db, scope, load) => read(maps(db).results, JSON.stringify(scope), load, resultTtlMs, maxEntries),
    membership: (db, scope, load) => read(maps(db).membership, JSON.stringify(scope), load, membershipTtlMs, maxMembers),
  };
}
