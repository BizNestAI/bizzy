// Unified JSON fetch with envelope handling
export async function apiFetch(path, { method = 'GET', headers = {}, body, userId, businessId } = {}) {
  let authHeader = headers.Authorization || headers.authorization;
  if (!authHeader && typeof window !== 'undefined') {
    const stored = window.localStorage?.getItem('access_token');
    if (stored) authHeader = `Bearer ${stored}`;
  }

  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(userId ? { 'x-user-id': userId } : {}),
      ...(businessId ? { 'x-business-id': businessId } : {}),
      ...(authHeader ? { Authorization: authHeader } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }

  if (!res.ok) {
    const msg = json?.error?.message || json?.error || `HTTP ${res.status}`;
    return { data: null, error: new Error(msg), meta: json?.meta || null, status: res.status };
  }
  return { data: json?.data ?? json, error: null, meta: json?.meta || null, status: res.status };
}
