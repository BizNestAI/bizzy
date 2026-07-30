import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";
import { buildMockTaxFixture } from "../../services/demo/mockTaxFixture.js";
import {
  createTaxPayment,
  getTaxPayments,
  updateTaxPayment,
  voidTaxPayment,
} from "../../services/tax/taxApiClient.js";

export function useTaxPayments({
  businessId,
  year = new Date().getFullYear(),
  filters = {},
  enabled = true,
} = {}) {
  const filterKey = useMemo(() => JSON.stringify(stableObject(filters)), [filters]);
  const [payments, setPayments] = useState({ rows: [] });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const seq = useRef(0);
  const isDemo = shouldUseDemoData();

  const load = useCallback(async ({ signal } = {}) => {
    if (isDemo) {
      const next = buildMockTaxFixture({ year }).payments;
      setPayments(next);
      setLoading(false);
      setError(null);
      return next;
    }
    if (!enabled || !businessId) return null;
    const request = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const parsedFilters = filterKey ? JSON.parse(filterKey) : {};
      const next = await getTaxPayments({ businessId, year, ...parsedFilters, signal });
      if (request === seq.current) setPayments(next || { rows: [] });
      return next;
    } catch (err) {
      if (err?.code !== "request_aborted" && request === seq.current) setError(err);
      return null;
    } finally {
      if (request === seq.current) setLoading(false);
    }
  }, [businessId, year, filterKey, enabled, isDemo]);

  useEffect(() => {
    const controller = new AbortController();
    load({ signal: controller.signal });
    return () => controller.abort();
  }, [load]);

  const mutate = useCallback(async (operation) => {
    setSaving(true);
    setError(null);
    try {
      const result = await operation();
      await load();
      return result;
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [load]);

  return {
    payments,
    rows: payments?.rows || [],
    loading,
    saving,
    error,
    refetch: load,
    createPayment: (payment) => mutate(() => createTaxPayment({ businessId, year, payment })),
    updatePayment: (paymentId, patch) => mutate(() => updateTaxPayment({ businessId, year, paymentId, patch })),
    voidPayment: (paymentId, reason) => mutate(() => voidTaxPayment({ businessId, year, paymentId, reason })),
  };
}

function stableObject(value) {
  if (!value || typeof value !== "object") return {};
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = value[key];
    return acc;
  }, {});
}

export default useTaxPayments;
