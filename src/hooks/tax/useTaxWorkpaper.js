import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";
import { buildMockTaxFixture } from "../../services/demo/mockTaxFixture.js";
import { getTaxCalculationWorkpaper } from "../../services/tax/taxApiClient.js";
import { resolveTaxDataMode, TAX_DATA_MODES } from "../../services/tax/taxDataMode.js";

export function useTaxWorkpaper({
  businessId,
  year = new Date().getFullYear(),
  runId = null,
  throughDate = null,
  section = null,
  enabled = true,
  appDemoState,
} = {}) {
  const mode = resolveTaxDataMode({
    businessId,
    appDemoState: appDemoState ?? (shouldUseDemoData() ? TAX_DATA_MODES.DEMO : undefined),
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const mounted = useRef(false);
  const abortRef = useRef(null);
  const sectionKey = useMemo(() => section || null, [section]);

  const load = useCallback(async () => {
    if (!enabled || mode === TAX_DATA_MODES.DISABLED) {
      setData(null);
      setLoading(false);
      return null;
    }
    if (mode === TAX_DATA_MODES.DEMO) {
      const demo = buildMockTaxFixture({ year }).overview.workpaper;
      setData(filterDemoSection(demo, sectionKey));
      setError(null);
      setLoading(false);
      return demo;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const next = await getTaxCalculationWorkpaper({
        businessId,
        year,
        runId,
        throughDate,
        section: sectionKey,
        signal: controller.signal,
      });
      if (!mounted.current) return null;
      setData(next);
      return next;
    } catch (err) {
      if (controller.signal.aborted) return null;
      if (!mounted.current) return null;
      setError(err);
      return null;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [businessId, enabled, mode, runId, sectionKey, throughDate, year]);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, [load]);

  return {
    data,
    loading,
    error,
    refetch: load,
    isDemo: mode === TAX_DATA_MODES.DEMO,
    isLive: mode === TAX_DATA_MODES.LIVE,
  };
}

function filterDemoSection(workpaper, section) {
  if (!section || !workpaper) return workpaper;
  return {
    ...workpaper,
    sections: (workpaper.sections || []).filter((row) => row.code === section),
  };
}

export default useTaxWorkpaper;
