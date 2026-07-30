import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";
import { buildMockTaxFixture } from "../../services/demo/mockTaxFixture.js";
import { getTaxOverview } from "../../services/tax/taxApiClient.js";
import { resolveTaxDataMode, TAX_DATA_MODES } from "../../services/tax/taxDataMode.js";

export function useTaxOverview({
  businessId,
  year = new Date().getFullYear(),
  asOfDate,
  include = [],
  enabled = true,
  appDemoState,
} = {}) {
  const includeKey = useMemo(() => canonicalIncludeKey(include), [include]);
  const mode = resolveTaxDataMode({
    businessId,
    appDemoState: appDemoState ?? (shouldUseDemoData() ? TAX_DATA_MODES.DEMO : undefined),
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const requestSeq = useRef(0);
  const mounted = useRef(false);
  const abortRef = useRef(null);
  const dataRef = useRef(null);
  const [todayKey, setTodayKey] = useState(() => currentLocalIsoDate());
  const effectiveAsOfDate = asOfDate || currentTaxAsOfDate(year, todayKey);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    let timeoutId = null;
    const schedule = () => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2);
      timeoutId = window.setTimeout(() => {
        setTodayKey(currentLocalIsoDate());
        schedule();
      }, Math.max(1_000, next.getTime() - now.getTime()));
    };
    if (typeof window !== "undefined") schedule();
    return () => {
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, []);

  const load = useCallback(async ({ refresh = false, preserve = true } = {}) => {
    if (!enabled || mode === TAX_DATA_MODES.DISABLED) {
      if (!preserve) setData(null);
      setLoading(false);
      setRefreshing(false);
      return null;
    }

    if (mode === TAX_DATA_MODES.DEMO) {
      const demo = buildMockTaxFixture({ year }).overview;
      setData(demo);
      setError(null);
      setLoading(false);
      setRefreshing(false);
      setLastUpdated(new Date());
      return demo;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++requestSeq.current;
    const isInitial = !dataRef.current;
    setError(null);
    if (isInitial || !preserve) setLoading(true);
    else setRefreshing(true);

    try {
      const next = await getTaxOverview({
        businessId,
        year,
        asOfDate: effectiveAsOfDate,
        include: includeKey ? includeKey.split(",") : [],
        refresh,
        signal: controller.signal,
      });
      if (!mounted.current || seq !== requestSeq.current) return null;
      setData(next);
      setLastUpdated(new Date());
      return next;
    } catch (err) {
      if (err?.code === "request_aborted" || controller.signal.aborted) return null;
      if (!mounted.current || seq !== requestSeq.current) return null;
      setError(err);
      if (!preserve) setData(null);
      return null;
    } finally {
      if (mounted.current && seq === requestSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [enabled, mode, businessId, year, effectiveAsOfDate, includeKey]);

  useEffect(() => {
    mounted.current = true;
    load({ refresh: false, preserve: true });
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, [load]);

  const refetch = useCallback(() => load({ refresh: false, preserve: true }), [load]);
  const refreshCalculation = useCallback(() => load({ refresh: true, preserve: true }), [load]);

  return {
    data,
    meta: data?.meta ?? null,
    readiness: data?.readiness ?? null,
    summary: data?.summary ?? null,
    profile: data?.profile ?? null,
    actuals: data?.actuals ?? null,
    projection: data?.projection ?? null,
    federal: data?.federal ?? null,
    state: data?.state ?? null,
    payments: data?.payments ?? null,
    safeHarbor: data?.safeHarbor ?? null,
    reserve: data?.reserve ?? null,
    deadlines: data?.deadlines ?? [],
    confidence: data?.confidence ?? null,
    warnings: data?.warnings ?? [],
    assumptions: data?.assumptions ?? [],
    unsupportedItems: data?.unsupportedItems ?? [],
    supportedButDeferred: data?.supportedButDeferred ?? [],
    explanationSummary: data?.explanationSummary ?? null,
    links: data?.links ?? {},
    loading,
    refreshing,
    error,
    errorCode: error?.code || null,
    refetch,
    refreshCalculation,
    lastUpdated,
    isLive: mode === TAX_DATA_MODES.LIVE,
    isDemo: mode === TAX_DATA_MODES.DEMO,
    isPartial: data?.meta?.status === "partial" || data?.readiness?.status === "partial",
    isUnavailable: mode === TAX_DATA_MODES.DISABLED || data?.readiness?.status === "unavailable",
    setupState: data?.readiness?.setupState ?? null,
  };
}

function canonicalIncludeKey(include) {
  const list = Array.isArray(include) ? include : String(include || "").split(",");
  return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))].sort().join(",");
}

function currentLocalIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function currentTaxAsOfDate(taxYear, today = currentLocalIsoDate()) {
  const year = Number(taxYear) || new Date().getFullYear();
  if (String(today).startsWith(`${year}-`)) return today;
  return `${year}-12-31`;
}

export default useTaxOverview;
