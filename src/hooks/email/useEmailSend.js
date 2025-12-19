// src/hooks/email/useEmailSend.js
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

export default function useEmailSend() {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  const send = useCallback(async ({ accountId, to, cc, bcc, subject, body, threadId }) => {
    setSending(true);
    setError(null);
    try {
      const headers = await authedHeaders();
      const json = await safeFetch(apiUrl("/api/email/send"), {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId, to, cc, bcc, subject, body, threadId }),
      });
      return json;
    } catch (e) {
      console.error(e);
      setError(e.message || "Send failed");
      throw e;
    } finally {
      setSending(false);
    }
  }, []);

  return { send, sending, error };
}
