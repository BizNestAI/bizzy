// /src/hooks/useTaxInsights.js
// Deprecated Prompt 29 compatibility hook.
// Active Tax pages use canonical run/confidence/explanation data and the global InsightsRail.
import { useCallback, useEffect, useState } from "react";
import { getDemoData, shouldUseDemoData } from "../services/demo/demoClient.js";

export function useTaxInsights({ businessId, watchKey }) {
  const [tips, setTips] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchTips = useCallback(async () => {
    if (shouldUseDemoData()) {
      const demo = getDemoData();
      setTips(demo?.tax?.insights || []);
      setLoading(false);
      setError("");
      return;
    }

    if (!businessId) {
      setTips([]);
      setLoading(false);
      setError("");
      return;
    }

    setTips([]);
    setLoading(false);
    setError("Tax suggestions moved to the global InsightsRail.");
  }, [businessId]);

  useEffect(() => {
    fetchTips();
  }, [fetchTips, watchKey]);

  return { tips, loading, error, refetch: fetchTips };
}
