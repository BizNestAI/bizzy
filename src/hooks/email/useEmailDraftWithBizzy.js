// src/hooks/email/useEmailDraftWithBizzy.js
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

export default function useEmailDraftWithBizzy() {
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState(null);

  const draftWithBizzy = useCallback(async ({ accountId, threadId, prompt = "", tone = "professional" }) => {
    setDrafting(true);
    setError(null);
    try {
      const headers = await authedHeaders();
      const json = await safeFetch(apiUrl("/api/email/draft-with-bizzy"), {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId, threadId, prompt, tone }),
      });
      return json.body; // return draft text
    } catch (e) {
      console.error(e);
      setError(e.message || "Draft failed");
      throw e;
    } finally {
      setDrafting(false);
    }
  }, []);

  return { draftWithBizzy, drafting, error };
}
