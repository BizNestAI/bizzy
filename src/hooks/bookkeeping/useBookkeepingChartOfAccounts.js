import { useCallback, useEffect, useRef, useState } from "react";

// No shared browser cache: a response belongs to one business/access session and
// the server resolves its current realm/environment before reading any accounts.
export function useBookkeepingChartOfAccounts({ businessId, accessScope = "customer", demo = false, demoAccounts = [], load }) {
  const scope = JSON.stringify([businessId, accessScope]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const generation = useRef(0);
  const [state, setState] = useState({ scope: null, accounts: [], loading: true, error: "" });
  const reload = useCallback(async () => {
    if (demo || !businessId) return;
    const request = ++generation.current;
    setState({ scope, accounts: [], loading: true, error: "" });
    try {
      const result = await load(businessId);
      if (!Array.isArray(result?.accounts) || result.ok === false) throw new Error("Invalid Chart of Accounts response");
      if (currentScope.current !== scope || request !== generation.current) return;
      setState({ scope, accounts: result.accounts, loading: false, error: "", meta: result.meta });
    } catch {
      if (currentScope.current !== scope || request !== generation.current) return;
      setState({ scope, accounts: [], loading: false, error: "QuickBooks Chart of Accounts couldn't be loaded. Retry before categorizing." });
    }
  }, [businessId, demo, load, scope]);
  useEffect(() => () => { generation.current += 1; }, [scope]);
  const setAccounts = useCallback(updater => {
    setState(previous => previous.scope === scope && !previous.loading && !previous.error
      ? { ...previous, accounts: typeof updater === "function" ? updater(previous.accounts) : updater } : previous);
  }, [scope]);
  if (demo) return { accounts: demoAccounts, loading: false, error: "", reload, setAccounts, ready: true };
  const valid = state.scope === scope;
  return { accounts: valid ? state.accounts : [], loading: !valid || state.loading,
    error: valid ? state.error : "", reload, setAccounts, ready: valid && !state.loading && !state.error };
}
