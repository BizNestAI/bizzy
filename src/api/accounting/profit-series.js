import express from "express";
import { supabase } from "../../services/supabaseAdmin.js";
import { qboEnvName } from "../../utils/qboEnv.js";

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
function buildMock(windowMonths) {
  const base = [7200, 8200, 10400, 9300, 8700, 11600, 12300, 9900, 13800, 14200, 15500, 15700];
  return windowMonths.map((m, i) => ({ year: m.year, month: m.month, profit: base[i % base.length] }));
}

router.get("/", async (req, res) => {
  try {
    const q = req.query || {};
    const business_id = req.business?.id || req.auth?.businessId || q.business_id || q.businessId || req.headers["x-business-id"] || null;
    const end_year = Number(q.end_year || q.year || new Date().getFullYear());
    const end_month = Number(q.end_month || q.month || new Date().getMonth() + 1);
    const window = Math.max(1, Math.min(24, Number(q.window || 12)));

    if (!business_id) return res.status(400).json({ error: "Missing business_id" });

    let windowMonths = seqLastNMonths({ year: end_year, month: end_month, n: window });

    if (useMockAccounting(req)) {
      return res.json({ rows: buildMock(windowMonths), source: "mock" });
    }

    const keyPairs = windowMonths.flatMap(({ year, month }) => [
      monthKey(year, month),
      monthKeyShort(year, month),
    ]);
    const keys = Array.from(new Set(keyPairs));
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

    const rowsRaw = windowMonths.map(({ year, month }) => {
      const keyA = monthKey(year, month);
      const keyB = monthKeyShort(year, month);
      const hasA = map.has(keyA);
      const hasB = map.has(keyB);
      const val = hasA ? map.get(keyA) : map.get(keyB);
      return { year, month, profit: val == null ? 0 : Number(val), found: hasA || hasB };
    });

    // Sandbox/dev fallback: if the latest month has no data, shift window back to last month with data
    const isSandbox = qboEnvName === "sandbox" || process.env.NODE_ENV !== "production";
    let rows = rowsRaw;
    if (isSandbox && rowsRaw.length) {
      const latest = rowsRaw[rowsRaw.length - 1];
      const latestHasData = latest.found && Number(latest.profit || 0) !== 0;
      if (!latestHasData) {
        const lastWithData = [...rowsRaw].reverse().find(r => r.found && Number(r.profit || 0) !== 0);
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
            .select("month,total_revenue,total_expenses,net_profit")
            .eq("business_id", business_id)
            .in("month", updatedKeys);
          const refetchMap = new Map(map);
          (refetched || []).forEach((r) => {
            const profit =
              r.net_profit != null
                ? Number(r.net_profit)
                : Number(r.total_revenue ?? 0) - Number(r.total_expenses ?? 0);
            refetchMap.set(r.month, profit);
          });
          rows = windowMonths.map(({ year, month }) => {
            const keyA = monthKey(year, month);
            const keyB = monthKeyShort(year, month);
            const hasA = refetchMap.has(keyA);
            const hasB = refetchMap.has(keyB);
            const val = hasA ? refetchMap.get(keyA) : refetchMap.get(keyB);
            return { year, month, profit: val == null ? 0 : Number(val) };
          });
        } else {
          rows = rowsRaw.map(({ year, month, profit }) => ({ year, month, profit }));
        }
      } else {
        rows = rowsRaw.map(({ year, month, profit }) => ({ year, month, profit }));
      }
    } else {
      rows = rowsRaw.map(({ year, month, profit }) => ({ year, month, profit }));
    }

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
