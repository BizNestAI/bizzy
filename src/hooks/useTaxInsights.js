// /src/hooks/useTaxInsights.js
import { useEffect, useState } from "react";
import { getDemoData, shouldUseDemoData } from "../services/demo/demoClient.js";

/** Always resolve to ".../api" even if VITE_API_BASE is "http://localhost:5050" */
const API_BASE = (() => {
  const raw = (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "");
  if (!raw) return "/api";
  return /(^|\/)api$/.test(raw) ? raw : `${raw}/api`;
})();

async function getAccessToken() {
  try {
    // If you have a supabase client available here, prefer it:
    // const { data } = await supabase.auth.getSession();
    // return data?.session?.access_token || null;

    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/^sb-.*-auth-token$/.test(k)) {
        const parsed = JSON.parse(localStorage.getItem(k) || "{}");
        return (
          parsed?.access_token ||
          parsed?.currentSession?.access_token ||
          parsed?.user?.access_token ||
          null
        );
      }
    }
  } catch {}
  return null;
}

export function useTaxInsights({ businessId, watchKey }) {
  const [tips, setTips] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function fetchTips() {
    if (!businessId || shouldUseDemoData()) {
      const demo = getDemoData();
      setTips(demo?.tax?.insights || []);
      setLoading(false);
      setError("");
      return;
    }
    setLoading(true);
    setError("");

    try {
      const token = await getAccessToken();

      const res = await fetch(`${API_BASE}/tax/generate-tax-insights`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ businessId }),
      });

      const txt = await res.text();
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = JSON.parse(txt || "{}");
          if (j?.error) msg += `: ${j.error}`;
          if (res.status === 401 && !token) msg += " (missing access token)";
        } catch {}
        throw new Error(msg);
      }

      // Backend returns { ok, data }
      const json = txt ? JSON.parse(txt) : { ok: true, data: [] };
      const data = Array.isArray(json?.data) ? json.data : [];
      setTips(data);
    } catch (e) {
      setError(e?.message || "Failed to load insights");
      setTips([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchTips();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, watchKey]);

  return { tips, loading, error, refetch: fetchTips };
}
