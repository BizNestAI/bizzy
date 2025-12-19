// File: /src/hooks/bizzyAffordabilityHook.js
// (client-side helper; no direct DB access)

export async function handleAffordabilityQuery({ userId, businessId, parsedInput }) {
  const payload = {
    userId,
    businessId,
    expenseName: parsedInput?.expenseName,
    amount: parsedInput?.amount,
    frequency: parsedInput?.frequency || 'one-time',
    startDate: parsedInput?.startDate || null,
    notes: parsedInput?.notes || '',
  };

  const res = await fetch('/api/accounting/affordabilityCheck', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Affordability API ${res.status}: ${text}`);
  }
  return res.json(); // { success, result, source, usingMock }
}
