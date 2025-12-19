// src/hooks/email/useEmailThread.js
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

export default function useEmailThread({ accountId, threadId }) {
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchThread = useCallback(async () => {
    if (!accountId || !threadId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ accountId });
      const headers = await authedHeaders();
      const json = await safeFetch(apiUrl(`/api/email/threads/${threadId}?${params.toString()}`), { headers });
      setThread(json);
    } catch (e) {
      console.error(e);
      setError(e.message || "Error fetching thread");
    } finally {
      setLoading(false);
    }
  }, [accountId, threadId]);

  useEffect(() => { fetchThread(); }, [fetchThread]);

  return { thread, loading, error, refetch: fetchThread, setThread };
}
