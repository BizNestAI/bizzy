// src/hooks/email/useEmailThreads.js
import { useEffect, useState, useCallback } from "react";
import { apiUrl, safeFetch } from "../../utils/safeFetch";
import { supabase } from "../../services/supabaseClient";

async function authedHeaders() {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token || "";
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "x-user-id": localStorage.getItem("user_id") || "",
    "x-business-id": localStorage.getItem("currentBusinessId") || localStorage.getItem("business_id") || "",
  };
}

export default function useEmailThreads({ accountId, label = "INBOX", q = "" }) {
  const [items, setItems] = useState([]);
  const [nextPageToken, setNextPageToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState(null);

  const load = useCallback(async (pageToken = null) => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ accountId, label });
      if (q) params.set("q", q);
      if (pageToken) params.set("pageToken", pageToken);

      const headers = await authedHeaders();
      const json = await safeFetch(apiUrl(`/api/email/threads?${params.toString()}`), { headers });

      if (pageToken) setItems((prev) => [...prev, ...(json.items || [])]);
      else setItems(json.items || []);

      setNextPageToken(json.nextPageToken || null);
    } catch (e) {
      console.error(e);
      setError(e.message || "Error loading threads");
    } finally {
      setLoading(false);
    }
  }, [accountId, label, q]);

  useEffect(() => { load(null); }, [load, refreshKey]);

  const loadMore = useCallback(() => { if (nextPageToken) load(nextPageToken); }, [nextPageToken, load]);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return { items, loading, error, loadMore, hasMore: !!nextPageToken, refresh };
}
