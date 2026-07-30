import { useCallback, useEffect, useRef, useState } from "react";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";
import { buildMockTaxFixture } from "../../services/demo/mockTaxFixture.js";
import {
  createTaxProfile,
  getTaxProfile,
  getTaxProfileMemory,
  initializeTaxProfile,
  setTaxProfileMemory,
  updateTaxProfile,
} from "../../services/tax/taxApiClient.js";

export function useTaxProfile({ businessId, year = new Date().getFullYear(), enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const seq = useRef(0);
  const isDemo = shouldUseDemoData();

  const load = useCallback(async ({ signal } = {}) => {
    if (isDemo) {
      const profile = buildMockTaxFixture({ year }).overview.profile;
      const next = { profile, completeness: profile.completeness, warnings: [], suggestedDefaults: {} };
      setData(next);
      setLoading(false);
      setError(null);
      return next;
    }
    if (!enabled || !businessId) return null;
    const request = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const next = await getTaxProfile({ businessId, year, signal });
      if (request === seq.current) setData(next);
      return next;
    } catch (err) {
      if (err?.code !== "request_aborted" && request === seq.current) setError(err);
      return null;
    } finally {
      if (request === seq.current) setLoading(false);
    }
  }, [businessId, year, enabled, isDemo]);

  useEffect(() => {
    const controller = new AbortController();
    load({ signal: controller.signal });
    return () => controller.abort();
  }, [load]);

  const mutate = useCallback(async (operation) => {
    setSaving(true);
    setError(null);
    try {
      const next = await operation();
      setData(next);
      return next;
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setSaving(false);
    }
  }, []);

  return {
    data,
    profile: data?.profile ?? data ?? null,
    completeness: data?.completeness ?? data?.profile?.completeness ?? null,
    warnings: data?.warnings ?? [],
    loading,
    saving,
    error,
    refetch: load,
    initialize: (input = {}) => mutate(() => isDemo
      ? Promise.resolve({ profile: { ...buildMockTaxFixture({ year }).overview.profile, source: input.source || "demo" }, completeness: buildMockTaxFixture({ year }).overview.profile.completeness })
      : initializeTaxProfile({ businessId, year, ...input })),
    create: (profile = {}) => mutate(() => isDemo
      ? Promise.resolve({ profile: { ...buildMockTaxFixture({ year }).overview.profile, ...profile }, completeness: buildMockTaxFixture({ year }).overview.profile.completeness })
      : createTaxProfile({ businessId, year, profile })),
    update: (patch = {}) => mutate(() => isDemo
      ? Promise.resolve({ profile: { ...buildMockTaxFixture({ year }).overview.profile, ...patch }, completeness: buildMockTaxFixture({ year }).overview.profile.completeness, warnings: [] })
      : updateTaxProfile({ businessId, year, patch })),
    loadMemory: (params = {}) => getTaxProfileMemory({ businessId, ...params }),
    setMemory: (params = {}) => setTaxProfileMemory({ businessId, ...params }),
  };
}

export default useTaxProfile;
