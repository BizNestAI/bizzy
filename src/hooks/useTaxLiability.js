// /src/hooks/useTaxLiability.js
import { useEffect, useState } from "react";
import { getDemoData, shouldUseDemoData } from "../services/demo/demoClient.js";
import apiBaseUrl from "../utils/apiBase.js";

const API_BASE = apiBaseUrl ? `${apiBaseUrl.replace(/\/+$/, "")}/api` : "/api";

async function getAccessToken() {
  try {
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

export function useTaxLiability(businessId, { year = new Date().getFullYear() } = {}) {
  const [data, setData] = useState(null); // { trend, quarterly, cashFlowOverlay, meta, summary, ... }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const buildDemoPayload = () => {
    const demo = getDemoData();
    const tax = demo?.tax || {};
    return {
      trend: tax.trend || [],
      quarterly: tax.quarterly || [],
      cashFlowOverlay: tax.cashFlowOverlay || [],
      summary: tax.summary || {},
      safeHarbor: tax.safeHarbor || {},
      meta: { source: "demo" },
    };
  };

  async function fetchLiability() {
    if (!businessId || shouldUseDemoData()) {
      setData(buildDemoPayload());
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true); setError("");
    try {
      const token = await getAccessToken();
      const res = await fetch(`${API_BASE}/tax/calculate-tax-liability`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ businessId, year, projectionOverride: {} }),
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
      const json = txt ? JSON.parse(txt) : { ok: true, data: null };
      setData(json?.data ?? null);
    } catch (e) {
      setData(null);
      setError(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchLiability(); }, [businessId, year]);

  return { data, loading, error, refetch: fetchLiability };
}
