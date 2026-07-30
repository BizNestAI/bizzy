// Transitional compatibility facade. New deductions UI should use
// src/hooks/tax/useTaxDeductions.js directly.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getDemoData, shouldUseDemoData } from "../services/demo/demoClient.js";
import { exportTaxDeductions, getTaxDeductionsOverview } from "../services/tax/taxApiClient.js";

const TODAY_ISO = new Date().toISOString().slice(0, 7);
const TODAY_YEAR = new Date().getFullYear();

export function useDeductionsMatrix({ businessId, year }) {
  const [data, setData] = useState(null);
  const [months, setMonths] = useState([]);
  const [currentMonth, setCurrentMonth] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);
  const useDemo = shouldUseDemoData();

  const fetchMatrix = useCallback(async ({ signal } = {}) => {
    if (!businessId && !useDemo) {
      setData(null);
      setMonths([]);
      setCurrentMonth("");
      setLoading(false);
      return null;
    }
    if (useDemo) {
      const demo = getDemoData()?.tax?.deductionsMatrix || null;
      const demoData = demo ? { ...demo, meta: { ...(demo.meta || {}), source: "demo" } } : null;
      const demoMonths = demoData?.meta?.month_list || [];
      setData(demoData);
      setMonths(demoMonths);
      setCurrentMonth(resolveCurrentMonth({ monthList: demoMonths, reported: demoData?.meta?.current_month }));
      setLoading(false);
      setError("");
      return demoData;
    }

    const request = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const overview = await getTaxDeductionsOverview({ businessId, year, signal });
      const matrix = adaptDeductionsOverviewToMatrix(overview);
      if (request === seq.current) {
        setData(matrix);
        const monthList = matrix?.meta?.month_list || [];
        setMonths(monthList);
        setCurrentMonth(resolveCurrentMonth({ monthList, reported: matrix?.meta?.current_month }));
      }
      return matrix;
    } catch (e) {
      if (e?.code !== "request_aborted" && request === seq.current) {
        setError(e?.message || "Failed to load");
        setData(null);
        setMonths([]);
        setCurrentMonth("");
      }
      return null;
    } finally {
      if (request === seq.current) setLoading(false);
    }
  }, [businessId, year, useDemo]);

  async function exportCsv() {
    if (useDemo) return exportDemoCsv({ data, months, year });
    if (!businessId) return;
    try {
      const result = await exportTaxDeductions({ businessId, year });
      downloadBlob(result.blob, result.filename || `deductions_${year || new Date().getFullYear()}.csv`);
    } catch (e) {
      setError(e?.message || "Failed to export deductions");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    fetchMatrix({ signal: controller.signal });
    return () => controller.abort();
  }, [fetchMatrix]);

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

export function adaptDeductionsOverviewToMatrix(overview) {
  if (!overview) return null;
  const monthList = resolveMonthList(overview);
  const grid = (overview.categories || []).map((category) => {
    const monthly = Object.fromEntries(monthList.map((month) => [
      month,
      category.monthly?.[month]?.deductibleAmount ?? category.monthly?.[month]?.estimatedDeductibleAmount ?? 0,
    ]));
    const ytdTotal = category.estimatedDeductibleAmount ?? category.confirmedDeductibleAmount ?? 0;
    return {
      category: category.displayName || category.taxCategory,
      taxCategory: category.taxCategory,
      monthly,
      ytdTotal,
      confidenceLevel: category.confidenceLevel || "unavailable",
      needsReviewAmount: category.needsReviewAmount ?? 0,
      transactionCount: category.transactionCount ?? 0,
      warnings: category.warnings || [],
    };
  });
  const totalsMonthly = Object.fromEntries(monthList.map((month) => [
    month,
    overview.totals?.byMonth?.[month]?.estimatedDeductibleAmount ?? 0,
  ]));
  return {
    meta: {
      businessId: overview.meta?.businessId || null,
      year: overview.meta?.taxYear ?? null,
      current_month: String(overview.meta?.asOfDate || "").slice(0, 7),
      month_list: monthList,
      source: overview.meta?.source || "transaction_tax_classifications",
      canonical: true,
    },
    categories: overview.categories || [],
    grid,
    totals: {
      monthly: totalsMonthly,
      ytdTotal: overview.totals?.estimatedDeductibleAmount ?? 0,
      needsReviewAmount: overview.totals?.needsReviewAmount ?? 0,
      nondeductibleAmount: overview.totals?.nondeductibleAmount ?? 0,
    },
    series: monthList.map((month) => ({ month, amount: totalsMonthly[month] ?? 0 })),
    coverage: overview.coverage,
    warnings: overview.warnings || [],
    setupState: overview.setupState || null,
  };
}

function resolveMonthList(overview) {
  const months = new Set(Object.keys(overview.totals?.byMonth || {}));
  for (const category of overview.categories || []) {
    Object.keys(category.monthly || {}).forEach((month) => months.add(month));
  }
  const sorted = [...months].filter(Boolean).sort();
  if (sorted.length) return sorted;
  const taxYear = overview.meta?.taxYear || new Date().getFullYear();
  return Array.from({ length: 12 }, (_, index) => `${taxYear}-${String(index + 1).padStart(2, "0")}`);
}

function resolveCurrentMonth({ monthList = [], reported = "" }) {
  const firstYear = Number(String(monthList?.[0] || "").slice(0, 4));
  if (firstYear && firstYear !== TODAY_YEAR) return "";
  if (monthList.includes(TODAY_ISO)) return TODAY_ISO;
  const closest = monthList.filter((m) => typeof m === "string" && m <= TODAY_ISO).pop();
  if (closest) return closest;
  if (reported && monthList.includes(reported)) return reported;
  return monthList[monthList.length - 1] || "";
}

function exportDemoCsv({ data, months, year }) {
  if (!data?.grid?.length) return;
  const header = ["Category", ...months, "YTD"];
  const rows = data.grid.map((row) => [
    row.category,
    ...months.map((month) => row.monthly?.[month] ?? 0),
    row.ytdTotal ?? 0,
  ]);
  rows.push(["TOTAL", ...months.map((month) => data.totals?.monthly?.[month] ?? 0), data.totals?.ytdTotal ?? 0]);
  const csv = [header, ...rows]
    .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  downloadBlob(new Blob([csv], { type: "text/csv" }), `deductions_${year || data?.meta?.year || "demo"}.csv`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default useDeductionsMatrix;
