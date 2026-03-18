// src/hooks/useBillingStatus.js
import { useEffect, useState } from "react";
import { apiUrl, safeFetch } from "../utils/safeFetch";

function resolveStatusValue(status) {
  const base = status?.subscription_status || "free";
  if (base === "free" && status?.trial_end) {
    const trialEnd = new Date(status.trial_end);
    if (!Number.isNaN(trialEnd.getTime()) && trialEnd.getTime() > Date.now()) {
      return "trialing";
    }
  }
  return base;
}

export default function useBillingStatus(businessId, userId, refreshKey = 0) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!businessId) {
        if (!cancelled) {
          setStatus(null);
          setError(null);
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const url = new URL(apiUrl("/api/billing/status"));
        url.searchParams.set("business_id", businessId);
        const data = await safeFetch(url.toString(), {
          headers: {
            "x-business-id": businessId,
            ...(userId ? { "x-user-id": userId } : {}),
          },
        });
        if (!cancelled) setStatus(data || null);
      } catch (e) {
        if (!cancelled) {
          setError(e);
          setStatus(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [businessId, userId, refreshKey]);

  const statusValue = resolveStatusValue(status);
  const planLabel = status?.plan_label || null;
  const canManageInPortal = Boolean(status?.can_manage_in_portal);
  const canStartCheckout = Boolean(status?.can_start_checkout);
  const hasSubscription = Boolean(status?.has_subscription || status?.stripe_subscription_id);

  const isTrialing = statusValue === "trialing";
  const isActive = statusValue === "active";
  const isPastDue = statusValue === "past_due";
  const isCanceled = statusValue === "canceled";
  const isBlocked = statusValue === "free";
  const isReadOnly = statusValue === "canceled";
  const isPaidOrTrial = isActive || isTrialing;

  let accessLevel = status?.access_level || null;
  if (!accessLevel) {
    if (isActive || isTrialing) accessLevel = "full";
    else if (isPastDue) accessLevel = "limited";
    else if (isCanceled) accessLevel = "read_only";
    else accessLevel = "blocked";
  }

  return {
    status,
    loading,
    error,
    setStatus,
    statusValue,
    accessLevel,
    planLabel,
    canManageInPortal,
    canStartCheckout,
    hasSubscription,
    isTrialing,
    isActive,
    isPastDue,
    isCanceled,
    isBlocked,
    isReadOnly,
    isPaidOrTrial,
  };
}
