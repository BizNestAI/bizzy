// File: /src/hooks/useBizzyAffordability.js
import { useState, useCallback } from 'react';
import { checkAffordability } from '../services/affordabilityClient';

export function useBizzyAffordability() {
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState(null);
  const [data, setData]     = useState(null);

  const run = useCallback(async (payload) => {
    setLoading(true); setError(null);
    try {
      const res = await checkAffordability(payload);
      setData(res);
      return res;
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  return { run, loading, error, data };
}
