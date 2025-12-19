// /src/insights/InsightsUnreadContext.jsx
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiUrl, safeFetch } from "../utils/safeFetch";
import { supabase } from "../services/supabaseClient";
import { countMockInsights } from "./mockInsights";
import useDemoMode from "../hooks/useDemoMode";

const Ctx = createContext({
  unreadByModule: {},
  markModuleAsRead: () => {},
});

/* ---------- alias helpers ---------- */
function aliasOf(mod) {
  if (mod === "email") return "inbox";
  if (mod === "calendar") return "sch";
  if (mod === "ops") return "jobs";
  return null;
}

/* ---------- normalize/flatten keys ---------- */
/** folds module:businessId → module and sums any duplicates */
function normalizeCounts(raw = {}) {
  const totals = {};
  Object.entries(raw).forEach(([k, v]) => {
    const base = (k || "").split(":")[0];
    const n = Number(v || 0);
    totals[base] = (totals[base] || 0) + (Number.isFinite(n) ? n : 0);
  });
  return totals;
}

/* ---------- optional prewarm ---------- */
/** fetch unread counts once for all modules (recommended in prod) */
const ENABLE_UNREAD_FETCH =
  String(
    (typeof import.meta !== "undefined" && import.meta.env?.VITE_ENABLE_INSIGHTS_UNREAD) ||
    (typeof process !== "undefined" && process.env?.VITE_ENABLE_INSIGHTS_UNREAD) ||
    ""
  ).toLowerCase() === "true";
let unreadEndpointUnavailable = !ENABLE_UNREAD_FETCH;
async function fetchUnreadCounts(businessId) {
  if (unreadEndpointUnavailable) return {};
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token || "";
  const headers = {
    "x-business-id": businessId || "",
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  // If you don’t have this endpoint yet, it will 404/throw and we fall back to zeros.
  const url = new URL(apiUrl("/api/insights/unread-counts"));
  if (businessId) url.searchParams.set("businessId", businessId);
  try {
    const resp = await safeFetch(url.toString(), { headers });
    // expected shape: { counts: { accounting: 2, marketing: 1, email: 3, ... } }
    return resp?.counts || {};
  } catch (e) {
    // endpoint not available or not hooked up in sandbox; fail closed and suppress repeated noise
    unreadEndpointUnavailable = e?.status === 404 || e?.status === 400 || unreadEndpointUnavailable;
    if (!unreadEndpointUnavailable) {
      console.warn("[insights] unread-counts unavailable, defaulting to zero:", e?.message || e);
    }
    return {};
  }
}

export function InsightsUnreadProvider({ businessId, children }) {
  const [counts, setCounts] = useState({});         // raw map as emitted/returned
  const countsRef = useRef({});

  const isDev = (import.meta?.env?.MODE || process.env.NODE_ENV) !== "production";
  const demoMode = useDemoMode?.();
  const allowMock = demoMode === "demo";

  useEffect(() => {
    if (!allowMock) {
      setCounts({});
      countsRef.current = {};
    }
  }, [allowMock]);

  /* 1) Prewarm once so badges show immediately (prod) */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!ENABLE_UNREAD_FETCH) {
          return;
        }
        if (isDev && allowMock) {
          const devCounts = countMockInsights();
          if (!alive) return;
          setCounts((prev) => {
            const next = { ...prev };
            Object.entries(devCounts).forEach(([mod, cnt]) => {
              next[mod] = cnt;
              const alias = aliasOf(mod);
              if (alias) next[alias] = cnt;
            });
            countsRef.current = next;
            return next;
          });
          return;
        }
        if (!businessId) return;
        const initial = await fetchUnreadCounts(businessId);
        if (!alive) return;
        setCounts((prev) => {
          const next = { ...prev, ...initial };
          countsRef.current = next;
          return next;
        });
      } catch {
        // ignore; stores will emit as rails mount
      }
    })();
    return () => {
      alive = false;
    };
  }, [businessId, isDev, allowMock]);

  /* 2) Listen to store emissions (insights:unread) */
  useEffect(() => {
    const onUnread = (e) => {
      const { moduleKey, businessId: evtBiz, count } = e?.detail || {};
      if (!moduleKey) return;
      if (evtBiz && businessId && evtBiz !== businessId) return; // ignore other businesses
      setCounts((prev) => {
        const next = { ...prev, [moduleKey]: Number(count || 0) };
        // if the store emits canonical, also keep alias mirrored (and vice versa later)
        const alias = aliasOf(moduleKey);
        if (alias) next[alias] = Number(count || 0);
        countsRef.current = next;
        return next;
      });
    };
    window.addEventListener("insights:unread", onUnread);
    return () => window.removeEventListener("insights:unread", onUnread);
  }, [businessId]);

  /* 3) Sidebar calls this to clear badges on navigation */
  const markModuleAsRead = (mod) => {
    if (!mod) return;
    setCounts((prev) => {
      const next = { ...prev, [mod]: 0 };
      const alias = aliasOf(mod);
      if (alias) next[alias] = 0;
      countsRef.current = next;
      return next;
    });
  };

  /* Expose normalized counts */
  const unreadByModule = useMemo(() => normalizeCounts(counts), [counts]);

  const value = useMemo(
    () => ({ unreadByModule, markModuleAsRead }),
    [unreadByModule]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useInsightsUnread() {
  return useContext(Ctx);
}
