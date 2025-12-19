// src/hooks/email/useAutoResponderRules.js
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

export default function useAutoResponderRules({ accountId }) {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const fetchRules = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      const headers = await authedHeaders();
      const json = await safeFetch(apiUrl(`/api/email/autoresponder?accountId=${encodeURIComponent(accountId)}`), { headers });
      setRules(json.rules || []);
    } catch (e) {
      console.error(e);
      setError(e.message || "Error loading rules");
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  const saveRule = useCallback(async (rule) => {
    setSaving(true);
    setError(null);
    try {
      const headers = await authedHeaders();
      await safeFetch(apiUrl("/api/email/autoresponder"), {
        method: rule.id ? "PUT" : "POST",
        headers,
        body: JSON.stringify({ ...rule, accountId }),
      });
      await fetchRules();
      return true;
    } catch (e) {
      console.error(e);
      setError(e.message || "Error saving rule");
      throw e;
    } finally {
      setSaving(false);
    }
  }, [accountId, fetchRules]);

  const deleteRule = useCallback(async (id) => {
    setSaving(true);
    setError(null);
    try {
      const headers = await authedHeaders();
      await safeFetch(apiUrl("/api/email/autoresponder"), {
        method: "DELETE",
        headers,
        body: JSON.stringify({ id, accountId }),
      });
      await fetchRules();
      return true;
    } catch (e) {
      console.error(e);
      setError(e.message || "Error deleting rule");
      throw e;
    } finally {
      setSaving(false);
    }
  }, [accountId, fetchRules]);

  useEffect(() => { fetchRules(); }, [fetchRules]);

  return { rules, loading, saving, error, fetchRules, saveRule, deleteRule };
}
