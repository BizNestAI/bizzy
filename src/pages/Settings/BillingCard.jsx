// src/pages/Settings/BillingCard.jsx
import React, { useMemo, useState, useEffect } from "react";
import { apiUrl, safeFetch } from "../../utils/safeFetch";

const BIZZI_ACCOUNTING_PLAN = {
  title: "Bizzi Accounting",
  subtitle: "For owner-operated and small trades businesses using QuickBooks Online.",
  price: "$349",
  interval: "/mo",
  description:
    "Bookkeeping automation, financial visibility, tax readiness, and a monthly human review layer in one subscription.",
  features: [
    "Ongoing transaction categorization",
    "Reconciliation monitoring",
    "Professional month-end books review",
    "Cash-flow visibility",
    "Job-profitability tracking",
    "Accounts-receivable monitoring",
    "Tax-deduction tracking",
    "Estimated tax and reserve planning",
    "Unlimited messaging",
    "Ability to book financial-review calls",
    "Dedicated accounting professional",
    "Human review of unusual activity",
  ],
};

/**
 * BillingCard – Checkout + Portal
 */
export default function BillingCard({ userId, businessId, status, readOnly = false }) {
  const [busyAction, setBusyAction] = useState(null);
  const [showPlanDetails, setShowPlanDetails] = useState(false);
  const [portalError, setPortalError] = useState("");
  const [checkoutError, setCheckoutError] = useState("");
  const [invoiceError, setInvoiceError] = useState("");
  const [paymentMethodError, setPaymentMethodError] = useState("");
  const [invoices, setInvoices] = useState([]);
  const [paymentMethod, setPaymentMethod] = useState(null);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [loadingPaymentMethod, setLoadingPaymentMethod] = useState(false);

  const statusValue = status?.subscription_status || "free";
  const trialEndsAt = status?.trial_end ? new Date(status.trial_end) : null;
  const periodEndsAt = status?.current_period_end ? new Date(status.current_period_end) : null;
  const trialDaysRemaining = trialEndsAt
    ? Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / 86400000))
    : null;
  const showPaymentFailed = status?.last_invoice_status === "payment_failed";
  const showTrialEndingSoon = statusValue === "trialing" && trialDaysRemaining != null && trialDaysRemaining < 5;
  const planTypeKey = "bizzi_human_review";

  const currentPlanName = useMemo(() => {
    if (status?.plan_type === planTypeKey) return BIZZI_ACCOUNTING_PLAN.title;
    if (status?.plan_label === "Bizzi + Human Review" || status?.plan_label === "Core") {
      return BIZZI_ACCOUNTING_PLAN.title;
    }
    if (status?.plan_label) return status.plan_label;
    if (statusValue === "free") return "Free";
    return "Custom";
  }, [planTypeKey, status?.plan_label, status?.plan_type, statusValue]);

  const accountStateLabel = useMemo(() => {
    const activeThrough = formatDate(periodEndsAt);
    const hasFutureEndDate =
      periodEndsAt instanceof Date &&
      !Number.isNaN(periodEndsAt.getTime()) &&
      periodEndsAt.getTime() > Date.now();

    if ((statusValue === "active" && status?.cancel_at_period_end) || (statusValue === "canceled" && hasFutureEndDate)) {
      return activeThrough === "—" ? "Canceled" : `Canceled: Active through ${activeThrough}`;
    }
    if (statusValue === "canceled") {
      return activeThrough === "—" ? "Canceled" : `Canceled: Active through ${activeThrough}`;
    }
    if (statusValue === "active") return "Active";
    if (statusValue === "trialing") return "Trial active";
    if (statusValue === "past_due") return "Payment update needed";
    if (statusValue === "unpaid") return "Payment required";
    if (statusValue === "incomplete" || statusValue === "incomplete_expired") return "Setup incomplete";
    return "Activation required";
  }, [periodEndsAt, status?.cancel_at_period_end, statusValue]);

  function formatDate(dateLike) {
    if (!dateLike) return "—";
    const dt = dateLike instanceof Date ? dateLike : new Date(dateLike);
    if (Number.isNaN(dt.getTime())) return "—";
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(dt);
  }

  function formatMoney(cents, currency = "USD") {
    if (cents == null || Number.isNaN(Number(cents))) return "—";
    const value = Number(cents) / 100;
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: String(currency || "USD").toUpperCase(),
      }).format(value);
    } catch {
      return `$${value.toFixed(2)}`;
    }
  }

  const canManagePortal = Boolean(status?.can_manage_in_portal || status?.stripe_customer_id);
  const canStartCheckout = Boolean(status?.can_start_checkout);
  const liveStatuses = new Set(["active", "trialing", "past_due"]);
  const hasLiveSubscription = liveStatuses.has(statusValue);
  const hasActiveCoreSubscription =
    statusValue === "active" &&
    (status?.plan_type === planTypeKey ||
      status?.plan_label === BIZZI_ACCOUNTING_PLAN.title ||
      status?.plan_label === "Core" ||
      status?.plan_label === "Bizzi + Human Review");
  const canManageSubscription = canManagePortal && hasActiveCoreSubscription;
  const nextBillingDateValue =
    statusValue === "canceled" || status?.cancel_at_period_end ? "—" : formatDate(periodEndsAt);

  useEffect(() => {
    if (!businessId) return;
    let alive = true;
    setLoadingInvoices(true);
    setInvoiceError("");
    safeFetch(apiUrl(`/api/billing/invoices?business_id=${businessId}`), {
      method: "GET",
      headers: {
        "x-business-id": businessId,
      },
    })
      .then((json) => {
        if (alive) setInvoices(Array.isArray(json?.rows) ? json.rows : []);
      })
      .catch((err) => {
        console.error("[billing][card] invoices load error", err);
        if (alive) setInvoiceError(err?.message || "Failed to load invoices.");
      })
      .finally(() => {
        if (alive) setLoadingInvoices(false);
      });
    return () => {
      alive = false;
    };
  }, [businessId, status?.stripe_customer_id, status?.subscription_status]);

  useEffect(() => {
    if (!businessId) return;
    let alive = true;
    setLoadingPaymentMethod(true);
    setPaymentMethodError("");
    safeFetch(apiUrl(`/api/billing/payment-method?business_id=${businessId}`), {
      method: "GET",
      headers: {
        "x-business-id": businessId,
      },
    })
      .then((json) => {
        if (alive) setPaymentMethod(json?.payment_method || null);
      })
      .catch((err) => {
        console.error("[billing][card] payment method load error", err);
        if (alive) setPaymentMethodError(err?.message || "Failed to load payment method.");
      })
      .finally(() => {
        if (alive) setLoadingPaymentMethod(false);
      });
    return () => {
      alive = false;
    };
  }, [businessId, status?.stripe_customer_id, status?.subscription_status]);

  async function startCheckout(planType) {
    if (readOnly) {
      setCheckoutError("Billing changes are unavailable in read-only Admin View.");
      return;
    }
    setBusyAction(`checkout_${planType}`);
    setCheckoutError("");
    try {
      const json = await safeFetch(apiUrl("/api/billing/create-checkout-session"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-business-id": businessId,
        },
        body: { user_id: userId, businessId, planType },
      });
      if (json?.url) {
        window.location.href = json.url;
        return;
      }
      setCheckoutError(json?.message || "Failed to start checkout.");
    } catch (err) {
      console.error("[billing][card] checkout error", err);
      setCheckoutError(err?.message || "Failed to start checkout.");
    } finally {
      setBusyAction(null);
    }
  }

  async function openPortal() {
    if (readOnly) {
      setPortalError("Billing changes are unavailable in read-only Admin View.");
      return;
    }
    setBusyAction("portal");
    setPortalError("");
    try {
      const json = await safeFetch(apiUrl("/api/billing/create-portal-session"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-business-id": businessId,
        },
        body: { user_id: userId, business_id: businessId },
      });
      if (json?.url) {
        window.location.href = json.url;
        return;
      }
      setPortalError(json?.message || "Failed to open billing portal.");
    } catch (err) {
      console.error("[billing][card] portal error", err);
      setPortalError(err?.message || "Failed to open billing portal.");
    } finally {
      setBusyAction(null);
    }
  }

  const isCurrentPlan = status?.plan_type === planTypeKey && hasLiveSubscription;
  const isCheckoutBusy = busyAction === `checkout_${planTypeKey}`;
  const planButtonState = (() => {
    if (isCurrentPlan) {
      return { label: "Current Plan", disabled: true, action: null, variant: "current" };
    }
    if (hasLiveSubscription && canManagePortal) {
      return {
        label: readOnly ? "Read Only" : busyAction === "portal" ? "Opening portal…" : "Manage in Billing Portal",
        disabled: readOnly || busyAction !== null,
        action: openPortal,
        variant: "portal",
      };
    }
    if (canStartCheckout) {
      return {
        label: readOnly ? "Read Only" : isCheckoutBusy ? "Starting checkout…" : "Activate Bizzi",
        disabled: readOnly || busyAction !== null,
        action: () => startCheckout(planTypeKey),
        variant: "activate",
      };
    }
    return {
      label: "Manage in Billing Portal",
      disabled: readOnly || !canManagePortal || busyAction !== null,
      action: openPortal,
      variant: "portal",
    };
  })();

  return (
    <div className="space-y-3">
      {(showPaymentFailed || showTrialEndingSoon) && (
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.035] p-3 text-sm text-white/80">
          {showPaymentFailed ? (
            <div className="text-amber-100">Payment issue detected. Update billing to keep Bizzi active.</div>
          ) : null}
          {showTrialEndingSoon ? (
            <div className="text-teal-100">
              Trial ending in {trialDaysRemaining} day{trialDaysRemaining === 1 ? "" : "s"}.
            </div>
          ) : null}
        </div>
      )}

      <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm uppercase tracking-[0.18em] text-white/45">Current Plan</div>
            <div className="mt-2 text-xl font-semibold text-white/90">{currentPlanName}</div>
          </div>
          <button
            type="button"
            onClick={() => setShowPlanDetails((prev) => !prev)}
            className="rounded-full border border-white/[0.08] px-3 py-1.5 text-xs font-semibold text-white/65 transition hover:bg-white/[0.04] hover:text-white/85"
          >
            {showPlanDetails ? "Hide details" : "Plan details"}
          </button>
        </div>

        <div className="mt-5 grid gap-4 border-t border-white/[0.07] pt-4 sm:grid-cols-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-white/40">Next billing date</div>
            <div className="mt-1 text-base font-semibold text-white/85">{nextBillingDateValue}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-white/40">Account state</div>
            <div className="mt-1 text-base font-semibold text-white/85">{accountStateLabel}</div>
          </div>
          <div className="sm:text-right">
            {planButtonState.variant === "current" ? (
              <div className="inline-flex rounded-full bg-emerald-300/12 px-3 py-1.5 text-sm font-semibold text-emerald-200">
                Current subscription
              </div>
            ) : (
              <button
                onClick={planButtonState.action}
                disabled={planButtonState.disabled}
                className={[
                  "inline-flex items-center justify-center rounded-full px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-55",
                  planButtonState.variant === "activate"
                    ? "bg-emerald-300 text-black hover:bg-emerald-200"
                    : "border border-white/[0.1] bg-white/[0.04] text-white/85 hover:bg-white/[0.08]",
                ].join(" ")}
              >
                {readOnly ? "Read Only" : planButtonState.variant === "activate" ? "Activate Bizzi" : planButtonState.label}
              </button>
            )}
          </div>
        </div>

        {showPlanDetails ? (
          <div className="mt-5 border-t border-white/[0.07] pt-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold text-white">{BIZZI_ACCOUNTING_PLAN.title}</h3>
                  {isCurrentPlan ? (
                    <span className="rounded-full bg-emerald-300/12 px-2.5 py-1 text-xs font-semibold text-emerald-200">
                      Current
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-white/60">
                  {BIZZI_ACCOUNTING_PLAN.description}
                </p>
              </div>
              <div className="flex items-end gap-2">
                <span className="text-4xl font-semibold tracking-normal text-white">
                  {BIZZI_ACCOUNTING_PLAN.price}
                </span>
                <span className="pb-1 text-base font-medium text-white/50">{BIZZI_ACCOUNTING_PLAN.interval}</span>
              </div>
            </div>
            <ul className="mt-5 grid gap-x-6 gap-y-2 text-sm leading-6 text-white/70 sm:grid-cols-2">
              {BIZZI_ACCOUNTING_PLAN.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2.5">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-300/85" aria-hidden="true" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            {checkoutError ? <p className="mt-3 text-xs text-amber-200/90">{checkoutError}</p> : null}
          </div>
        ) : null}
      </div>

      <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-4 sm:p-5">
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-white/90">Payment Method</div>
                <p className="mt-1 text-xs text-white/50">Card on file for renewals.</p>
              </div>
              {canManageSubscription ? (
                <button
                  onClick={openPortal}
                  disabled={readOnly || busyAction !== null}
                  className="inline-flex items-center rounded-full border border-white/[0.1] px-3 py-1.5 text-xs font-semibold text-white/75 transition hover:bg-white/[0.05] disabled:opacity-60"
                >
                  {busyAction === "portal" ? "Opening…" : "Manage"}
                </button>
              ) : null}
            </div>
            <div className="mt-3 text-sm text-white/75">
              {loadingPaymentMethod ? (
                <span className="text-white/45">Loading payment method…</span>
              ) : paymentMethod ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-white/85">
                    {String(paymentMethod.brand || "").toUpperCase()} ending in {paymentMethod.last4}
                  </span>
                  <span className="text-xs text-white/50">
                    Expires {paymentMethod.exp_month}/{paymentMethod.exp_year}
                  </span>
                </div>
              ) : (
                <span className="text-white/45">No payment method on file.</span>
              )}
            </div>
            {paymentMethodError ? <p className="mt-2 text-xs text-amber-200/90">{paymentMethodError}</p> : null}
            {!canManageSubscription && hasActiveCoreSubscription ? (
              <p className="mt-2 text-xs text-white/50">No billing portal available yet.</p>
            ) : null}
            {portalError ? <p className="mt-2 text-xs text-amber-200/90">{portalError}</p> : null}
          </div>

          <div className="border-t border-white/[0.07] pt-5 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
            <div className="text-sm font-semibold text-white/90">Recent Invoices</div>
            <p className="mt-1 text-xs text-white/50">Receipts and payment history.</p>
            <div className="mt-3 space-y-2">
              {loadingInvoices ? (
                <div className="text-sm text-white/45">Loading invoices…</div>
              ) : invoices && invoices.length ? (
                invoices.slice(0, 5).map((inv) => (
                  <div key={inv.id} className="flex flex-wrap items-center justify-between gap-2 text-sm text-white/75">
                    <div>
                      <div className="font-semibold text-white/85">Invoice {inv.number || inv.id}</div>
                      <div className="text-xs text-white/45">{formatDate(inv.created_at)}</div>
                    </div>
                    <div className="text-right">
                      <div>{inv.amount_paid ? "Paid" : "Due"} {formatMoney(inv.amount_paid || inv.amount_due, inv.currency)}</div>
                      <div className="text-xs text-white/45">{inv.status}</div>
                    </div>
                    {inv.hosted_invoice_url ? (
                      <a
                        href={inv.hosted_invoice_url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-full border border-white/[0.1] px-3 py-1 text-xs text-white/75 hover:bg-white/[0.05]"
                      >
                        View
                      </a>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="text-sm text-white/45">No invoices yet.</div>
              )}
            </div>
            {invoiceError ? <p className="mt-2 text-xs text-amber-200/90">{invoiceError}</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
