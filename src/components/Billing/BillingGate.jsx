import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import useBillingStatus from "../../hooks/useBillingStatus";

const DEFAULT_MESSAGE = "Activate Bizzi to enable automated workflows.";

export function getBillingAccess(statusValue) {
  const normalized = statusValue || "free";
  if (normalized === "trialing" || normalized === "active") {
    return { access: "full", canRunAI: true, isReadOnly: false, isBlocked: false };
  }
  if (normalized === "past_due") {
    return { access: "limited", canRunAI: true, isReadOnly: false, isBlocked: false };
  }
  if (normalized === "canceled") {
    return { access: "read_only", canRunAI: false, isReadOnly: true, isBlocked: false };
  }
  if (normalized === "unpaid" || normalized === "incomplete" || normalized === "incomplete_expired") {
    return { access: "blocked", canRunAI: false, isReadOnly: false, isBlocked: true };
  }
  return { access: "blocked", canRunAI: false, isReadOnly: false, isBlocked: true };
}

export function resolveStatusValue(status) {
  const base = status?.subscription_status || "free";
  if (base === "free" && status?.trial_end) {
    const trialEnd = new Date(status.trial_end);
    if (!Number.isNaN(trialEnd.getTime()) && trialEnd.getTime() > Date.now()) {
      return "trialing";
    }
  }
  return base;
}

export default function BillingGate({
  businessId,
  userId,
  status: statusProp,
  message = DEFAULT_MESSAGE,
  ctaLabel = "Manage Billing",
  ctaHref = "/dashboard/settings?tab=Billing",
  hideBanner = false,
  children,
}) {
  const shouldFetch = !statusProp;
  const { status: fetchedStatus, accessLevel } = useBillingStatus(
    shouldFetch ? businessId : null,
    shouldFetch ? userId : null
  );
  const status = statusProp || fetchedStatus;
  const statusValue = resolveStatusValue(status);
  const access = useMemo(() => {
    const level = status?.access_level || accessLevel || null;
    if (level === "full") return { access: "full", canRunAI: true, isReadOnly: false, isBlocked: false };
    if (level === "limited") return { access: "limited", canRunAI: true, isReadOnly: false, isBlocked: false };
    if (level === "read_only") return { access: "read_only", canRunAI: false, isReadOnly: true, isBlocked: false };
    if (level === "blocked") return { access: "blocked", canRunAI: false, isReadOnly: false, isBlocked: true };
    return getBillingAccess(statusValue);
  }, [status?.access_level, accessLevel, statusValue]);
  const navigate = useNavigate();

  const goToBilling = () => {
    try {
      navigate(ctaHref);
    } catch (e) {
      window.location.href = ctaHref;
    }
  };

  const gateBanner = (() => {
    if (hideBanner) return null;
    if (statusValue === "past_due") {
      return (
        <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100 shadow-[0_0_18px_rgba(251,191,36,0.12)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold">Payment issue detected.</div>
              <div className="text-amber-100/80 text-xs">You still have temporary access while you update billing.</div>
            </div>
            <button
              type="button"
              onClick={goToBilling}
              className="rounded-full border border-amber-300/60 bg-amber-400/20 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-400/30"
            >
              {ctaLabel}
            </button>
          </div>
        </div>
      );
    }

    if (statusValue === "unpaid" || statusValue === "incomplete" || statusValue === "incomplete_expired") {
      return (
        <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100 shadow-[0_0_18px_rgba(251,191,36,0.12)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold">Billing setup incomplete.</div>
              <div className="text-amber-100/80 text-xs">
                Complete your subscription setup or update payment details to activate Bizzi.
              </div>
            </div>
            <button
              type="button"
              onClick={goToBilling}
              className="rounded-full border border-amber-300/60 bg-amber-400/20 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-400/30"
            >
              {ctaLabel}
            </button>
          </div>
        </div>
      );
    }

    if (access.isBlocked || access.isReadOnly) {
      let copy = "Complete billing setup to unlock automated workflows.";
      if (access.isReadOnly) copy = "Read-only access is enabled until billing is reactivated.";
      else if (statusValue === "free") copy = "Activate Bizzi to unlock automated workflows.";
      return (
        <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100 shadow-[0_0_18px_rgba(16,185,129,0.12)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold">{message}</div>
              <div className="text-emerald-100/70 text-xs">
                {copy}
              </div>
            </div>
            <button
              type="button"
              onClick={goToBilling}
              className="rounded-full border border-emerald-300/60 bg-emerald-400/20 px-3 py-1.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-400/30"
            >
              {ctaLabel}
            </button>
          </div>
        </div>
      );
    }

    return null;
  })();

  if (typeof children === "function") {
    return children({ status, statusValue, ...access, gateBanner });
  }

  return (
    <div className="space-y-3">
      {gateBanner}
      {children}
    </div>
  );
}
