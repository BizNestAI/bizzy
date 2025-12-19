// /src/hooks/useDeductionsMatrix.js
import { useEffect, useMemo, useState } from "react";
import { getDemoData, shouldUseDemoData } from "../services/demo/demoClient.js";

const API_BASE = (() => {
  const raw = (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "");
  if (!raw) return "/api";
  return /(^|\/)api$/.test(raw) ? raw : `${raw}/api`;
})();

async function getAccessToken() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/^sb-.*-auth-token$/.test(k)) {
        const parsed = JSON.parse(localStorage.getItem(k) || "{}");
        return (
          parsed?.access_token ||
          parsed?.currentSession?.access_token ||
          parsed?.user?.access_token ||
          null
        );
      }
    }
  } catch {}
  return null;
}

/**
 * useDeductionsMatrix({ businessId, year })
 * Returns backend-composed matrix for the Deductions page:
 * {
 *   data: { meta, categories, grid, totals, series },
 *   months: [ "2025-01", ... "2025-12" ],
 *   currentMonth: "2025-09",
 *   loading, error, refetch, exportCsv()
 * }
 */
export function useDeductionsMatrix({ businessId, year }) {
  const [data, setData] = useState(null);
  const [months, setMonths] = useState([]);
  const [currentMonth, setCurrentMonth] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const useDemo = !businessId || shouldUseDemoData();

  async function fetchMatrix() {
    if (!businessId && !useDemo) return;
    if (useDemo) {
      const demo = getDemoData()?.tax?.deductionsMatrix || null;
      setData(demo);
      setMonths(demo?.meta?.month_list || []);
      setCurrentMonth(demo?.meta?.current_month || "");
      setLoading(false);
      setError("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const token = await getAccessToken();
      const res = await fetch(`${API_BASE}/tax/deductions/summary`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ businessId, year }),
      });
      const txt = await res.text();
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = JSON.parse(txt || "{}");
          if (j?.error) msg += `: ${j.error}`;
          if (res.status === 401 && !token) msg += " (missing access token)";
        } catch {}
        throw new Error(msg);
      }
      const json = txt ? JSON.parse(txt) : { ok: true, data: null };
      if (!json?.ok) throw new Error(json?.error || "Failed to load");
      setData(json.data || null);
      setMonths(json.data?.meta?.month_list || []);
      setCurrentMonth(json.data?.meta?.current_month || "");
    } catch (e) {
      setError(e?.message || "Failed to load");
      setData(null);
      setMonths([]);
      setCurrentMonth("");
    } finally {
      setLoading(false);
    }
  }

  async function exportCsv() {
    if (useDemo) {
      if (!data?.grid?.length) return;
      const header = ["Category", ...months, "YTD"];
      const rows = data.grid.map((row) => [
        row.category,
        ...months.map((m) => row.monthly?.[m] ?? 0),
        row.ytdTotal ?? 0,
      ]);
      rows.push([
        "TOTAL",
        ...months.map((m) => data.totals?.monthly?.[m] ?? 0),
        data.totals?.ytdTotal ?? 0,
      ]);
      const csv = [header, ...rows]
        .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
        .join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `deductions_${year || data?.meta?.year || "demo"}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return;
    }
    if (!businessId) return;
    try {
      const token = await getAccessToken();
      const url = new URL(`${API_BASE}/tax/deductions/export`, window.location.origin);
      url.searchParams.set("businessId", businessId);
      if (year) url.searchParams.set("year", String(year));

      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Export failed: ${res.status} ${t}`);
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `deductions_${year || new Date().getFullYear()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 8000);
    } catch (e) {
      alert(e?.message || "Failed to export deductions");
    }
  }

  useEffect(() => { fetchMatrix(); }, [businessId, year, useDemo]);

  const topCategory = useMemo(() => {
    if (!data?.grid?.length) return null;
    return data.grid.slice().sort((a, b) => (b.ytdTotal || 0) - (a.ytdTotal || 0))[0];
  }, [data]);

  const thisMonthTotal = useMemo(() => {
    if (!data?.totals?.monthly || !currentMonth) return 0;
    return data.totals.monthly[currentMonth] || 0;
  }, [data, currentMonth]);

  return {
    data,
    months,
    currentMonth,
    topCategory,
    thisMonthTotal,
    loading,
    error,
    refetch: fetchMatrix,
    exportCsv,
  };
}
