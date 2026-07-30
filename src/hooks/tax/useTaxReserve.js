import { useCallback, useEffect, useRef, useState } from "react";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";
import { buildMockTaxFixture } from "../../services/demo/mockTaxFixture.js";
import {
  createTaxReserveAccount,
  deactivateTaxReserveAccount,
  getTaxReserve,
  getTaxReserveAccounts,
  refreshTaxReserveAccount,
  setPrimaryTaxReserveAccount,
  updateTaxReserveAccount,
} from "../../services/tax/taxApiClient.js";

export function useTaxReserve({ businessId, year = new Date().getFullYear(), asOfDate, enabled = true } = {}) {
  const [reserve, setReserve] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const seq = useRef(0);
  const isDemo = shouldUseDemoData();

  const load = useCallback(async ({ signal } = {}) => {
    if (isDemo) {
      const fixture = buildMockTaxFixture({ year });
      setReserve(fixture.reserve);
      setAccounts(fixture.reserveAccounts);
      setLoading(false);
      setError(null);
      return { reserve: fixture.reserve, accounts: fixture.reserveAccounts };
    }
    if (!enabled || !businessId) return null;
    const request = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const [nextReserve, accountPayload] = await Promise.all([
        getTaxReserve({ businessId, year, asOfDate, signal }),
        getTaxReserveAccounts({ businessId, signal }),
      ]);
      if (request === seq.current) {
        setReserve(nextReserve);
        setAccounts(accountPayload?.rows || []);
      }
      return { reserve: nextReserve, accounts: accountPayload?.rows || [] };
    } catch (err) {
      if (err?.code !== "request_aborted" && request === seq.current) setError(err);
      return null;
    } finally {
      if (request === seq.current) setLoading(false);
    }
  }, [businessId, year, asOfDate, enabled, isDemo]);

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
    reserve,
    accounts,
    loading,
    saving,
    error,
    refetch: load,
    createAccount: (account) => mutate(() => createTaxReserveAccount({ businessId, account })),
    updateAccount: (accountId, patch) => mutate(() => updateTaxReserveAccount({ businessId, accountId, patch })),
    setPrimaryAccount: (accountId) => mutate(() => setPrimaryTaxReserveAccount({ businessId, accountId })),
    refreshBalance: (accountId) => mutate(() => refreshTaxReserveAccount({ businessId, accountId })),
    deactivateAccount: (accountId) => mutate(() => deactivateTaxReserveAccount({ businessId, accountId })),
  };
}

export default useTaxReserve;
