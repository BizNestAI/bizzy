import express from "express";
import { supabase } from "../../services/supabaseAdmin.js";
import { qboEnvName } from "../../utils/qboEnv.js";
import { getHealthSeries } from "../../services/accounting/healthMonthlySnapshotService.js";

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
function monthKeyShort(y, m) { return `${y}-${pad2(m)}`; }

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
      req.business?.id || req.auth?.businessId || q.business_id || q.businessId || req.headers["x-business-id"] || null;
    const end_year = Number(q.end_year || q.year || new Date().getFullYear());
    const end_month = Number(q.end_month || q.month || new Date().getMonth() + 1);
    const window = Math.max(1, Math.min(24, Number(q.window || 12))); // 1..24

    if (!business_id) {
      return res.status(400).json({ error: "Missing business_id" });
    }

    const snapshotSeries = await getHealthSeries({ businessId: business_id, year: end_year, month: end_month, window });
    if ((snapshotSeries.revenue || []).some((row) => row.found)) {
      return res.json({
        rows: snapshotSeries.revenue.map(({ year, month, revenue }) => ({ year, month, revenue })),
        source: "monthly_review_qbo_pnl_snapshots",
      });
    }

    let windowMonths = seqLastNMonths({ year: end_year, month: end_month, n: window });

    // Mock path if allowed
    if (useMockAccounting(req)) {
      const rows = buildMockSeries(windowMonths);
      return res.json({ rows, source: "mock" });
    }

    // Supabase path
    const keyPairs = windowMonths.flatMap(({ year, month }) => [
      monthKey(year, month),
      monthKeyShort(year, month),
    ]);
    const keys = Array.from(new Set(keyPairs));
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

    const rowsRaw = windowMonths.map(({ year, month }) => {
      const keyA = monthKey(year, month);
      const keyB = monthKeyShort(year, month);
      const val = fmMap.has(keyA) ? fmMap.get(keyA) : fmMap.get(keyB);
      const found = fmMap.has(keyA) || fmMap.has(keyB);
      return { year, month, revenue: val == null ? 0 : Number(val), found };
    });

    // Sandbox/dev fallback: if latest month has no data, shift window back to last month with data
    const isSandbox = qboEnvName === "sandbox" || process.env.NODE_ENV !== "production";
    let rows = rowsRaw;
    if (isSandbox && rowsRaw.length) {
      const latest = rowsRaw[rowsRaw.length - 1];
      const latestHasData = latest.found && Number(latest.revenue || 0) !== 0;
      if (!latestHasData) {
        const lastWithData = [...rowsRaw].reverse().find(r => r.found && Number(r.revenue || 0) !== 0);
        if (lastWithData) {
          windowMonths = seqLastNMonths({
            year: lastWithData.year,
            month: lastWithData.month,
            n: window,
          });
          const updatedPairs = windowMonths.flatMap(({ year, month }) => [
            monthKey(year, month),
            monthKeyShort(year, month),
          ]);
          const updatedKeys = Array.from(new Set(updatedPairs));
          const { data: refetched } = await supabase
            .from("financial_metrics")
            .select("month,total_revenue")
            .eq("business_id", business_id)
            .in("month", updatedKeys);
          const refetchMap = new Map();
          (refetched || fmRows || []).forEach((r) => refetchMap.set(r.month, Number(r.total_revenue ?? 0)));
          rows = windowMonths.map(({ year, month }) => {
            const keyA = monthKey(year, month);
            const keyB = monthKeyShort(year, month);
            const val = refetchMap.has(keyA) ? refetchMap.get(keyA) : refetchMap.get(keyB);
            return { year, month, revenue: val == null ? 0 : Number(val) };
          });
        } else {
          rows = rowsRaw.map(({ year, month, revenue }) => ({ year, month, revenue }));
        }
      } else {
        rows = rowsRaw.map(({ year, month, revenue }) => ({ year, month, revenue }));
      }
    } else {
      rows = rowsRaw.map(({ year, month, revenue }) => ({ year, month, revenue }));
    }

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
