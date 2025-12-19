// Quick manual check for bookkeeping endpoints
// Usage: TOKEN="<jwt>" BUSINESS_ID="<uuid>" node scripts/manual/checkBookkeeping.js

const baseUrl = process.env.BASE_URL || "http://localhost:5050";
const token = process.env.TOKEN || "";
const businessId = process.env.BUSINESS_ID || "";

if (!token || !businessId) {
  console.error("Set TOKEN and BUSINESS_ID env vars to call the bookkeeping endpoints.");
  process.exit(1);
}

async function call(path, opts = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-business-id": businessId,
      ...(opts.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

(async () => {
  console.log("➡️  GET /api/accounting/uncategorized");
  const uncats = await call("/api/accounting/uncategorized");
  console.log(uncats);

  console.log("➡️  POST /api/accounting/uncategorized/suggest (first 3 txns)");
  const sample = Array.isArray(uncats.json?.items) ? uncats.json.items.slice(0, 3) : [];
  const suggest = await call("/api/accounting/uncategorized/suggest", {
    method: "POST",
    body: JSON.stringify({ transactions: sample, businessId }),
  });
  console.log(suggest);

  console.log("➡️  GET /api/accounting/bookkeeping-health");
  const health = await call("/api/accounting/bookkeeping-health");
  console.log(health);
})();
