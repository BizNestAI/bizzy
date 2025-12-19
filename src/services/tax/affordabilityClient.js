export async function checkAffordability(payload) {
  const resp = await fetch('/api/gpt/affordability-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error || `HTTP ${resp.status}`);
  return json; // { success, result, ... }
}
