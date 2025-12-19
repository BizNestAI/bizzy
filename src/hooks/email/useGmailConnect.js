// src/hooks/email/useGmailConnect.js
import { useState, useCallback } from "react";
import { safeFetch, apiUrl } from "../../utils/safeFetch";
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

export default function useGmailConnect() {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  const connect = useCallback(async (businessId = null) => {
    setConnecting(true);
    setError(null);
    try {
      const headers = await authedHeaders();
      const qs = businessId ? `?business_id=${encodeURIComponent(businessId)}` : "";
      const { url } = await safeFetch(apiUrl(`/api/email/connect${qs}`), { headers });
      if (!url) throw new Error("OAuth URL not returned");
      window.location.assign(url);
    } catch (e) {
      console.error(e);
      setError(e.message || "Failed to create OAuth URL");
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async (accountId) => {
    if (!accountId) return;
    setError(null);
    try {
      const headers = await authedHeaders();
      await safeFetch(apiUrl("/api/email/disconnect"), {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId }),
      });
      return true;
    } catch (e) {
      console.error(e);
      setError(e.message || "Failed to disconnect");
      throw e;
    }
  }, []);

  return { connect, disconnect, connecting, error };
}
