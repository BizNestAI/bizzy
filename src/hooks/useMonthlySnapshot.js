// /src/hooks/useMonthlySnapshot.js
import { useEffect, useMemo, useState } from "react";
import { getDemoData, shouldUseDemoData } from "../services/demo/demoClient.js";
import apiBaseUrl from "../utils/apiBase.js";

const API_BASE = apiBaseUrl ? `${apiBaseUrl.replace(/\/+$/, "")}/api` : "/api";

async function getAccessToken() {
  try {
    // Prefer supabase client if available:
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

export function useMonthlySnapshot({
  businessId,
  year = new Date().getFullYear(),
  month, // "YYYY-MM"
  watchKey,
}) {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const body = useMemo(
    () => ({ businessId, year, month, archive: true }),
    [businessId, year, month]
  );

  async function fetchSnapshot() {
    if (!businessId || shouldUseDemoData()) {
      const demo = getDemoData();
      if (demo?.tax?.monthlySnapshot) {
        setSnapshot(demo.tax.monthlySnapshot);
        setError("");
      } else {
        setSnapshot(null);
        setError("No business selected");
      }
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");

    try {
      const token = await getAccessToken();

      const res = await fetch(`${API_BASE}/tax/generate-monthly-tax-snapshot`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });

      const text = await res.text();
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = JSON.parse(text || "{}");
          if (j?.error) msg += `: ${j.error}`;
          if (res.status === 401 && !token) msg += " (missing access token)";
        } catch {}
        throw new Error(msg);
      }

      // Backend returns { ok, data }
      const json = text ? JSON.parse(text) : { ok: true, data: null };
      if (json?.error) throw new Error(json.error);
      setSnapshot(json?.data ?? null);
    } catch (e) {
      console.error("Monthly snapshot fetch failed:", e);
      setSnapshot(null);
      setError(e?.message || "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, year, month, watchKey]);

  return { snapshot, loading, error, refetch: fetchSnapshot };
}
