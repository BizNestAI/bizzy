export function readBusinessId(req) {
  const b = req.body || {};
  const q = req.query || {};
  const h = req.headers || {};
  return (
    req.business?.id ||
    req.auth?.businessId ||
    req.user?.business_id ||
    b.business_id ||
    b.businessId ||
    q.business_id ||
    q.businessId ||
    h["x-business-id"] ||
    null
  );
}

export function ensureBusinessId(req, res) {
  const businessId = readBusinessId(req);
  if (!businessId) {
    res.status(400).json({ ok: false, error: "missing_business_id" });
    return null;
  }
  return businessId;
}
