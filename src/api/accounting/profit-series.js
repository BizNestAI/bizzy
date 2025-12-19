import express from "express";
import { supabase } from "../../services/supabaseAdmin.js";

const router = express.Router();
const ENV_MOCK = String(process.env.USE_MOCK_ACCOUNTING || "").toLowerCase() === "true";

function useMockAccounting(req) {
  const mode = (req.headers["x-data-mode"] || req.query?.data_mode || "").toLowerCase();
  if (mode === "demo" || mode === "mock") return true;
  if (mode === "live" || mode === "testing") return false;
  return ENV_MOCK;
}

function pad2(n) { return String(n).padStart(2, "0"); }
function monthKey(y, m) { return `${y}-${pad2(m)}-01`; }
function seqLastNMonths({ year, month, n = 12 }) {
  const out = [];
  let y = year;
  let m = month;
  for (let i = 0; i < n; i++) {
    out.unshift({ year: y, month: m });
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}
function buildMock(windowMonths) {
  const base = [7200, 8200, 10400, 9300, 8700, 11600, 12300, 9900, 13800, 14200, 15500, 15700];
  return windowMonths.map((m, i) => ({ year: m.year, month: m.month, profit: base[i % base.length] }));
}

router.get("/", async (req, res) => {
  try {
    const q = req.query || {};
    const business_id = q.business_id || q.businessId || req.headers["x-business-id"] || null;
    const end_year = Number(q.end_year || q.year || new Date().getFullYear());
    const end_month = Number(q.end_month || q.month || new Date().getMonth() + 1);
    const window = Math.max(1, Math.min(24, Number(q.window || 12)));

    if (!business_id) return res.status(400).json({ error: "Missing business_id" });

    const windowMonths = seqLastNMonths({ year: end_year, month: end_month, n: window });

    if (useMockAccounting(req)) {
      return res.json({ rows: buildMock(windowMonths), source: "mock" });
    }

    const keys = windowMonths.map(({ year, month }) => monthKey(year, month));
    const { data, error } = await supabase
      .from("financial_metrics")
      .select("month,total_revenue,total_expenses,net_profit")
      .eq("business_id", business_id)
      .in("month", keys);

    if (error) console.warn("[profit-series] supabase read error:", error?.message || error);

    const map = new Map();
    (data || []).forEach((r) => {
      const profit =
        r.net_profit != null
          ? Number(r.net_profit)
          : Number(r.total_revenue ?? 0) - Number(r.total_expenses ?? 0);
      map.set(r.month, profit);
    });

    const rows = windowMonths.map(({ year, month }) => {
      const key = monthKey(year, month);
      const val = map.get(key);
      return { year, month, profit: val == null ? 0 : Number(val) };
    });

    return res.json({ rows, source: "supabase" });
  } catch (err) {
    console.error("[profit-series] unexpected error:", err?.message || err);
    try {
      const now = new Date();
      const end_year = Number(req.query?.end_year || now.getFullYear());
      const end_month = Number(req.query?.end_month || now.getMonth() + 1);
      const window = Math.max(1, Math.min(24, Number(req.query?.window || 12)));
      return res.json({ rows: buildMock(seqLastNMonths({ year: end_year, month: end_month, n: window })), source: "mock" });
    } catch {
      return res.status(500).json({ error: "Failed to build profit series." });
    }
  }
});

export default router;
