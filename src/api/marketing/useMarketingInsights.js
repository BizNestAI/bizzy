import { useEffect, useMemo, useState } from "react";

export function useMarketingInsights({ posts, campaigns, timeframe }) {
  const [state, setState] = useState({ loading: false, error: null, data: null });

  const payload = useMemo(() => ({ posts, campaigns, timeframe }), [posts, campaigns, timeframe]);

  useEffect(() => {
    let aborted = false;
    async function run() {
      setState({ loading: true, error: null, data: null });
      try {
        const r = await fetch("/api/generate-marketing-insights", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const json = await r.json();
        if (aborted) return;
        if (!r.ok || json?.error) {
          setState({ loading: false, error: json?.error?.message || "INSIGHTS_ERROR", data: null });
        } else {
          setState({ loading: false, error: null, data: json.data });
        }
      } catch {
        if (!aborted) setState({ loading: false, error: "NETWORK_ERROR", data: null });
      }
    }
    run();
    return () => { aborted = true; };
  }, [payload]);

  return state;
}
