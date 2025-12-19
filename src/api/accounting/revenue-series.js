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

function buildMockSeries(windowMonths) {
  const base = [
    18000, 22000, 28000, 32000, 30000, 37000,
    41000, 39000, 44000, 46000, 48000, 50000,
  ];
  return windowMonths.map((m, i) => ({
    year: m.year,
    month: m.month,
    revenue: base[i % base.length],
  }));
}

router.get("/", async (req, res) => {
  try {
    const q = req.query || {};
    const business_id =
      q.business_id || q.businessId || req.headers["x-business-id"] || null;
    const end_year = Number(q.end_year || q.year || new Date().getFullYear());
    const end_month = Number(q.end_month || q.month || new Date().getMonth() + 1);
    const window = Math.max(1, Math.min(24, Number(q.window || 12))); // 1..24

    if (!business_id) {
      return res.status(400).json({ error: "Missing business_id" });
    }

    const windowMonths = seqLastNMonths({
      year: end_year,
      month: end_month,
      n: window,
    });

    // Mock path if allowed
    if (useMockAccounting(req)) {
      const rows = buildMockSeries(windowMonths);
      return res.json({ rows, source: "mock" });
    }

    // Supabase path
    const keys = windowMonths.map(({ year, month }) => monthKey(year, month));
    const { data: fmRows, error: fmErr } = await supabase
      .from("financial_metrics")
      .select("month,total_revenue")
      .eq("business_id", business_id)
      .in("month", keys);

    if (fmErr) {
      console.warn("[revenue-series] supabase read error:", fmErr?.message || fmErr);
    }

    const fmMap = new Map();
    (fmRows || []).forEach((r) => fmMap.set(r.month, Number(r.total_revenue ?? 0)));

    const rows = windowMonths.map(({ year, month }) => {
      const key = monthKey(year, month);
      const val = fmMap.get(key);
      return { year, month, revenue: val == null ? 0 : Number(val) };
    });

    return res.json({ rows, source: "supabase" });
  } catch (err) {
    console.error("[revenue-series] unexpected error:", err?.message || err);
    try {
      const now = new Date();
      const end_year = Number(req.query?.end_year || now.getFullYear());
      const end_month = Number(req.query?.end_month || now.getMonth() + 1);
      const window = Math.max(1, Math.min(24, Number(req.query?.window || 12)));
      return res.json({ rows: buildMockSeries(seqLastNMonths({ year: end_year, month: end_month, n: window })), source: "mock" });
    } catch {
      return res.status(500).json({ error: "Failed to build revenue series." });
    }
  }
});

export default router;
