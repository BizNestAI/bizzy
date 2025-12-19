// src/hooks/useIntegrationManager.js
import { useCallback, useEffect, useMemo, useState } from "react";
import useGmailConnect from "./email/useGmailConnect";
import { apiUrl, safeFetch } from "../utils/safeFetch";
import { getDemoMode, setDemoMode } from "../services/demo/demoClient.js";

const STORAGE_KEY_PREFIX = "bizzy.integrations";
const STORAGE_EVENT = "bizzy:integrations:update";
const STORAGE_VERSION = 3;
const PLAID_LINK_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

const STATUS = {
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  AWAITING: "awaiting",
  CONNECTED: "connected",
  ERROR: "error",
};

export const INTEGRATION_META = {
  quickbooks: {
    label: "QuickBooks Online",
    description: "Sync revenue, expenses, and KPIs.",
    cta: "Connect QuickBooks",
    category: "accounting",
  },
  plaid: {
    label: "Plaid (Bank Sync)",
    description: "Link bank or brokerage accounts.",
    cta: "Connect Plaid",
    category: "finance",
  },
  gmail: {
    label: "Gmail",
    description: "Bring in email, tasks, and Bizzi AI replies.",
    cta: "Connect Gmail",
    category: "communications",
  },
  facebook: {
    label: "Facebook",
    description: "Track post performance and engagement.",
    cta: "Connect Facebook",
    category: "marketing",
  },
  instagram: {
    label: "Instagram",
    description: "Import reels, posts, and insights.",
    cta: "Connect Instagram",
    category: "marketing",
  },
  linkedin: {
    label: "LinkedIn",
    description: "Analyze audience growth and clicks.",
    cta: "Connect LinkedIn",
    category: "marketing",
  },
  jobber: {
    label: "Jobber",
    description: "Bring in jobs, stages, and AR.",
    cta: "Sync Jobber",
    category: "ops",
  },
};

const DEFAULT_STATE = Object.fromEntries(
  Object.keys(INTEGRATION_META).map((key) => [
    key,
    {
      status: key === "gmail" ? STATUS.CONNECTED : STATUS.DISCONNECTED,
      lastSync: key === "gmail" ? Date.now() : null,
      error: null,
    },
  ])
);
DEFAULT_STATE.__version = STORAGE_VERSION;

const noop = () => {};

function resolveBusinessId(explicitId) {
  if (explicitId) return explicitId;
  if (typeof window === "undefined") return "default";
  return (
    window.localStorage?.getItem("currentBusinessId") ||
    window.localStorage?.getItem("business_id") ||
    "default"
  );
}

function storageKey(businessId) {
  return `${STORAGE_KEY_PREFIX}.${businessId || "default"}`;
}

function withDefaults(raw = {}) {
  const next = { ...DEFAULT_STATE };
  Object.keys(INTEGRATION_META).forEach((key) => {
    if (raw[key]) {
      next[key] = { ...next[key], ...raw[key] };
    }
  });
  next.__version = STORAGE_VERSION;
  return next;
}

function readState(businessId) {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = window.localStorage?.getItem(storageKey(businessId));
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw);
    if (parsed.__version !== STORAGE_VERSION) return DEFAULT_STATE;
    return withDefaults(parsed);
  } catch {
    return DEFAULT_STATE;
  }
}

function writeState(businessId, state) {
  if (typeof window === "undefined") return;
  try {
    const payload = JSON.stringify(withDefaults(state));
    window.localStorage?.setItem(storageKey(businessId), payload);
    window.dispatchEvent(
      new CustomEvent(STORAGE_EVENT, { detail: { businessId } })
    );
  } catch {
    // ignore storage failures
  }
}

// Intentionally no-op: disable toast notifications for integration flows
function toast(_detail) {
  return;
}

let plaidScriptPromise = null;
function loadPlaidScript() {
  if (typeof window === "undefined") return Promise.reject(new Error("window unavailable"));
  if (window.Plaid) return Promise.resolve(window.Plaid);
  if (plaidScriptPromise) return plaidScriptPromise;
  plaidScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PLAID_LINK_SCRIPT;
    script.async = true;
    script.onload = () => {
      if (window.Plaid) resolve(window.Plaid);
      else reject(new Error("Plaid script loaded without Plaid"));
    };
    script.onerror = () => reject(new Error("Failed to load Plaid Link"));
    document.head.appendChild(script);
  }).catch((err) => {
    plaidScriptPromise = null;
    throw err;
  });
  return plaidScriptPromise;
}

async function openPlaidLink(linkToken) {
  if (typeof window === "undefined") throw new Error("Plaid unavailable in SSR");
  const Plaid = await loadPlaidScript();
  return new Promise((resolve, reject) => {
    const handler = Plaid.create({
      token: linkToken,
      onSuccess: async (public_token, metadata) => {
        try {
          await safeFetch(apiUrl("/api/investments/plaid/exchange-public-token"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: { public_token, institution_name: metadata?.institution?.name },
          });
          await safeFetch(apiUrl("/api/investments/sync"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });
          resolve({ connected: true });
        } catch (err) {
          reject(err);
        } finally {
          handler?.destroy?.();
        }
      },
      onExit: (err) => {
        handler?.destroy?.();
        if (err) reject(new Error(err.display_message || err.error_code || "Plaid exited"));
        else resolve({ status: STATUS.DISCONNECTED });
      },
    });
    handler.open();
  });
}

export default function useIntegrationManager(options = {}) {
  const resolvedBusinessId = resolveBusinessId(options.businessId);
  const [state, setState] = useState(() => readState(resolvedBusinessId));
  const { connect: connectGmail = noop } = useGmailConnect();
  const qbStatus = state?.quickbooks?.status || DEFAULT_STATE.quickbooks.status;

  useEffect(() => {
    setState(readState(resolvedBusinessId));
  }, [resolvedBusinessId]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handler = (event) => {
      const target = event?.detail?.businessId;
      if (!target || target === resolvedBusinessId) {
        setState(readState(resolvedBusinessId));
      }
    };
    window.addEventListener(STORAGE_EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(STORAGE_EVENT, handler);
      window.removeEventListener("storage", handler);
    };
  }, [resolvedBusinessId]);

  // Parse OAuth callback query params (e.g., qb=connected) and mark status
  const updateProvider = useCallback(
    (provider, patch) => {
      setState((prev) => {
        const next = {
          ...prev,
          [provider]: { ...prev[provider], ...patch },
        };
        writeState(resolvedBusinessId, next);
        return next;
      });
    },
    [resolvedBusinessId]
  );

  // Parse OAuth callback query params (e.g., qb=connected) and mark status
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search || "");
    const qbFlag = (params.get("qb") || "").toLowerCase();
    const integrationParam = (params.get("integration") || "").toLowerCase();
    const paramBusinessId = params.get("business_id") || params.get("businessId") || null;

    if (integrationParam === "quickbooks") {
      if (qbFlag === "connected" && (!paramBusinessId || paramBusinessId === resolvedBusinessId)) {
        updateProvider("quickbooks", {
          status: STATUS.CONNECTED,
          lastSync: Date.now(),
          error: null,
        });
        // Force live mode once QB is connected unless user explicitly picked demo
        try {
          if (getDemoMode() !== "demo") setDemoMode("live");
        } catch {
          /* ignore */
        }
      } else if (qbFlag === "callback_failed") {
        updateProvider("quickbooks", { status: STATUS.ERROR, error: "QuickBooks connect failed." });
      }

      // Clean query params from the URL to avoid stale status on refresh
      if (window.history?.replaceState) {
        ["qb", "integration", "business_id", "businessId"].forEach((k) => params.delete(k));
        const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}${window.location.hash || ""}`;
        window.history.replaceState({}, "", next);
      }
    }
  }, [resolvedBusinessId, updateProvider]);

  // If QuickBooks is connected (persisted in local storage), force live unless user chose demo
  useEffect(() => {
    if (qbStatus === STATUS.CONNECTED) {
      try {
        if (getDemoMode() !== "demo") setDemoMode("live");
      } catch {
        /* ignore */
      }
    }
  }, [qbStatus]);

  const runAction = useCallback(
    async (provider) => {
      switch (provider) {
        case "quickbooks": {
          const urlObj = new URL(apiUrl("/auth/quickbooks"));
          urlObj.searchParams.set("business_id", resolvedBusinessId || "default");
          const url = urlObj.toString();
          if (typeof window !== "undefined") {
            window.location.assign(url); // keep same tab to avoid duplicate Bizzi tabs
            toast({
              title: "QuickBooks",
              body: "Finish the OAuth flow in the Intuit window.",
            });
          }
          return { status: STATUS.AWAITING };
        }
        case "gmail": {
          await connectGmail(resolvedBusinessId);
          return { status: STATUS.AWAITING };
        }
        case "plaid": {
          const tokenResp = await safeFetch(apiUrl("/api/investments/plaid/create-link-token"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });
          const linkToken =
            tokenResp?.link_token || tokenResp?.linkToken || tokenResp?.token;
          if (!linkToken) throw new Error("Plaid link token unavailable");
          if (tokenResp?.mode === "mock" || tokenResp?.fallback) {
            toast({ title: "Plaid demo connected", body: "Using mock investment data." });
            return { connected: true };
          }
          return openPlaidLink(linkToken);
        }
        case "jobber": {
          await safeFetch("/api/jobs/integrations/jobber/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });
          toast({
            title: "Jobber sync queued",
            body: "We’ll pull your pipeline into Bizzi shortly.",
          });
          return { connected: true };
        }
        case "housecall": {
          await safeFetch("/api/jobs/integrations/housecall/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });
          toast({
            title: "Housecall Pro sync queued",
            body: "Imports kick off in the background.",
          });
          return { connected: true };
        }
        case "facebook":
        case "instagram":
        case "linkedin": {
          const url = apiUrl(`/auth/social/${provider}`);
          if (typeof window !== "undefined") {
            window.open(url, "_blank", "noopener,noreferrer");
            toast({
              title: `Connect ${INTEGRATION_META[provider].label}`,
              body: "Finish the login flow in the new window.",
            });
          }
          return { status: STATUS.AWAITING };
        }
        default:
          throw new Error(`Unsupported provider: ${provider}`);
      }
    },
    [connectGmail, resolvedBusinessId]
  );

  const connect = useCallback(
    async (provider) => {
      if (!INTEGRATION_META[provider]) return null;
      updateProvider(provider, { status: STATUS.CONNECTING, error: null });
      try {
        const result = await runAction(provider);
        if (result?.connected) {
          updateProvider(provider, {
            status: STATUS.CONNECTED,
            lastSync: Date.now(),
            error: null,
          });
        } else if (result?.status) {
          updateProvider(provider, { status: result.status, error: null });
        } else {
          updateProvider(provider, { status: STATUS.DISCONNECTED, error: null });
        }
        return result;
      } catch (err) {
        updateProvider(provider, {
          status: STATUS.ERROR,
          error: err?.message || "Failed to connect",
        });
        throw err;
      }
    },
    [runAction, updateProvider]
  );

  const disconnect = useCallback(
    async (provider) => {
      if (!INTEGRATION_META[provider]) return;
      try {
        if (provider === "quickbooks") {
          if (!resolvedBusinessId) throw new Error("missing_business_id");
          await safeFetch(apiUrl("/auth/disconnect"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: { business_id: resolvedBusinessId },
          });
        }
      } catch (e) {
        console.warn(`[integrations] ${provider} disconnect failed`, e?.message || e);
      } finally {
        updateProvider(provider, { status: STATUS.DISCONNECTED, error: null });
      }
    },
    [resolvedBusinessId, updateProvider]
  );

  const markConnected = useCallback(
    (provider, { lastSync = Date.now(), silent = false } = {}) => {
      if (!INTEGRATION_META[provider]) return;
      updateProvider(provider, { status: STATUS.CONNECTED, lastSync, error: null });
      if (!silent) {
        // intentionally no toast
      }
    },
    [updateProvider]
  );

  const markStatus = useCallback(
    (provider, status) => {
      if (!INTEGRATION_META[provider]) return;
      updateProvider(provider, { status, error: null });
    },
    [updateProvider]
  );

  const isConnecting = useCallback(
    (provider) => state?.[provider]?.status === "connecting",
    [state]
  );

  const getStatus = useCallback(
    (provider) => state?.[provider] || DEFAULT_STATE[provider],
    [state]
  );

  const anyConnecting = useMemo(
    () => Object.values(state || {}).some((s) => s.status === "connecting"),
    [state]
  );

  return {
    state,
    connect,
    disconnect,
    isConnecting,
    anyConnecting,
    getStatus,
    meta: INTEGRATION_META,
    businessId: resolvedBusinessId,
    markConnected,
    markStatus,
  };
}
