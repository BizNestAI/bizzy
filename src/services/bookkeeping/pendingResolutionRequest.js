// Keep the same operation identity after timeouts, modal reopen and page reload.
// A changed action or attestation payload is a different deliberate operation.
export function pendingResolutionRequestKey({ businessId, transactionId, action, payload, storage = globalThis.sessionStorage, randomUUID = () => globalThis.crypto.randomUUID() }) {
  const slot = `bizzi:pending-resolution:${JSON.stringify([businessId, transactionId, action, payload])}`;
  if (!storage) throw new Error("Session storage is required to safely retry this operation.");
  const existing = storage.getItem(slot);
  if (existing) return existing;
  const key = randomUUID();
  storage.setItem(slot, key);
  return key;
}
