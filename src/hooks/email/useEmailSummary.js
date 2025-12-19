// src/hooks/email/useEmailSummary.js
import { useState, useCallback } from "react";
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

export default function useEmailSummary() {
  const [summarizing, setSummarizing] = useState(false);
  const [error, setError] = useState(null);

  const summarize = useCallback(async ({ accountId, threadId }) => {
    setSummarizing(true);
    setError(null);
    try {
      const headers = await authedHeaders();
      const json = await safeFetch(apiUrl("/api/email/summarize"), {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId, threadId }),
      });
      return json.summary;
    } catch (e) {
      console.error(e);
      setError(e.message || "Summarize failed");
      throw e;
    } finally {
      setSummarizing(false);
    }
  }, []);

  return { summarize, summarizing, error };
}
