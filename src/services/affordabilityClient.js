// File: /src/services/affordabilityClient.js

export async function checkAffordability(payload) {
  const { userId, businessId, expenseName, amount, frequency, startDate, notes } = payload || {};
  if (!userId || !businessId || !expenseName || amount == null || !frequency) {
    throw new Error('Missing required fields for affordability check.');
  }

  const res = await fetch('/api/accounting/affordabilityCheck', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, businessId, expenseName, amount, frequency, startDate, notes }),
  });

  if (!res.ok) {
    // Bubble the server detail during dev
    let msg = `Affordability API ${res.status}`;
    try { const j = await res.json(); msg += `: ${j.error || j.detail || ''}`; } catch {}
    throw new Error(msg);
  }
  return res.json();
}
