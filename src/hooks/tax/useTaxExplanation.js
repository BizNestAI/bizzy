import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getTaxCalculationChanges,
  getTaxCalculationComponents,
  getTaxCalculationConfidence,
  getTaxCalculationExplanation,
} from "../../services/tax/taxApiClient.js";

export function useTaxExplanation({
  businessId,
  runId,
  group,
  changedOnly,
  compareRunId,
  enabled = true,
} = {}) {
  const key = useMemo(
    () => JSON.stringify({ businessId, runId, group, changedOnly: !!changedOnly, compareRunId }),
    [businessId, runId, group, changedOnly, compareRunId]
  );
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const seq = useRef(0);

  const load = useCallback(async ({ signal } = {}) => {
    if (!enabled || !businessId || !runId) return null;
    const request = ++seq.current;
    const args = JSON.parse(key);
    setLoading(true);
    setError(null);
    try {
      const [explanation, components, confidence, changes] = await Promise.all([
        getTaxCalculationExplanation({ businessId, runId, group: args.group, changedOnly: args.changedOnly, signal }),
        getTaxCalculationComponents({ businessId, runId, group: args.group, signal }),
        getTaxCalculationConfidence({ businessId, runId, signal }),
        getTaxCalculationChanges({ businessId, runId, compareRunId: args.compareRunId, signal }),
      ]);
      const next = { explanation, components, confidence, changes };
      if (request === seq.current) setData(next);
      return next;
    } catch (err) {
      if (err?.code !== "request_aborted" && request === seq.current) setError(err);
      return null;
    } finally {
      if (request === seq.current) setLoading(false);
    }
  }, [businessId, runId, enabled, key]);

  useEffect(() => {
    const controller = new AbortController();
    load({ signal: controller.signal });
    return () => controller.abort();
  }, [load]);

  return {
    data,
    explanation: data?.explanation ?? null,
    components: data?.components?.components ?? data?.components ?? [],
    confidence: data?.confidence?.confidence ?? data?.confidence ?? null,
    changes: data?.changes ?? null,
    loading,
    error,
    refetch: load,
  };
}

export default useTaxExplanation;
