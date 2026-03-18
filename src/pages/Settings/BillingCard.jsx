// src/pages/Settings/BillingCard.jsx
import React, { useMemo, useState, useEffect } from "react";
import { apiUrl, safeFetch } from "../../utils/safeFetch";

/**
 * BillingCard – Checkout + Portal
 */
export default function BillingCard({ userId, businessId, status }) {
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
  const showCancelScheduled = Boolean(status?.cancel_at_period_end);
  const planTypeKey = "bizzi_human_review";

  const currentPlanName = useMemo(() => {
    if (status?.plan_label) return status.plan_label;
    if (status?.plan_type === planTypeKey) return "Bizzi + Human Review";
    if (statusValue === "free") return "Free";
    return "Custom";
  }, [planTypeKey, status?.plan_label, status?.plan_type, statusValue]);

  const statusBadge = useMemo(() => {
    const map = {
      active: "border-emerald-400/30 bg-emerald-400/15 text-emerald-200",
      trialing: "border-teal-300/30 bg-teal-400/15 text-teal-200",
      past_due: "border-amber-300/40 bg-amber-400/15 text-amber-200",
      unpaid: "border-amber-300/40 bg-amber-400/15 text-amber-200",
      incomplete: "border-amber-300/40 bg-amber-400/15 text-amber-200",
      incomplete_expired: "border-white/20 bg-white/10 text-white/60",
      canceled: "border-white/20 bg-white/10 text-white/60",
      free: "border-white/15 bg-white/5 text-white/60",
    };
    return map[statusValue] || "border-white/15 bg-white/5 text-white/70";
  }, [statusValue]);

  const accessLevelLabel = useMemo(() => {
    if (status?.access_level === "full") return "Full access";
    if (status?.access_level === "limited") return "Limited access";
    if (status?.access_level === "read_only") return "Read-only access";
    return "Blocked";
  }, [status?.access_level]);

  function formatDate(dateLike) {
    if (!dateLike) return "—";
    const dt = dateLike instanceof Date ? dateLike : new Date(dateLike);
    if (Number.isNaN(dt.getTime())) return "—";
    return dt.toLocaleDateString();
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
        label: busyAction === "portal" ? "Opening portal…" : "Manage in Billing Portal",
        disabled: busyAction !== null,
        action: openPortal,
        variant: "portal",
      };
    }
    if (canStartCheckout) {
      return {
        label: isCheckoutBusy ? "Starting checkout…" : "Activate Bizzi",
        disabled: busyAction !== null,
        action: () => startCheckout(planTypeKey),
        variant: "activate",
      };
    }
    return {
      label: "Manage in Billing Portal",
      disabled: !canManagePortal || busyAction !== null,
      action: openPortal,
      variant: "portal",
    };
  })();

  return (
    <div className="space-y-4">
      {(showPaymentFailed || showTrialEndingSoon || showCancelScheduled) && (
        <div className="space-y-2 rounded-2xl border border-white/10 bg-white/5 p-3 text-sm text-white/80 shadow-[0_0_18px_rgba(16,185,129,0.08)]">
          {showPaymentFailed && (
            <div className="rounded-lg border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-amber-100">
              Payment issue detected. Update billing to keep Bizzi active.
            </div>
          )}
          {showTrialEndingSoon && (
            <div className="rounded-lg border border-teal-300/30 bg-teal-400/10 px-3 py-2 text-teal-100">
              Trial ending in {trialDaysRemaining} day{trialDaysRemaining === 1 ? "" : "s"}.
            </div>
          )}
          {showCancelScheduled && (
            <div className="rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-white/70">
              Cancellation scheduled at the end of the current period.
            </div>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5 shadow-[0_0_18px_rgba(16,185,129,0.08)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">Current Plan</div>
            <p className="text-sm text-white/60">Plan details and upcoming billing dates.</p>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm text-white/60">Plan</div>
              <div className="mt-1 text-lg font-semibold text-white/90">{currentPlanName}</div>
            </div>
            <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusBadge}`}>
              {statusValue}
            </span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="text-xs uppercase tracking-widest text-white/50">Next billing date</div>
              <div className="mt-1 text-base font-semibold text-white/90">
                {formatDate(periodEndsAt)}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="text-xs uppercase tracking-widest text-white/50">Trial ends</div>
              <div className="mt-1 text-base font-semibold text-white/90">
                {formatDate(trialEndsAt)}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="text-xs uppercase tracking-widest text-white/50">Access level</div>
              <div className="mt-1 text-base font-semibold text-white/90">{accessLevelLabel}</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="text-xs uppercase tracking-widest text-white/50">Cancellation</div>
              <div className="mt-1 text-base font-semibold text-white/90">
                {showCancelScheduled ? "Scheduled" : "—"}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowPlanDetails((prev) => !prev)}
            className="group w-full rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white/85 transition hover:bg-white/8"
          >
            <span className="flex items-center justify-center gap-2">
              Activate Bizzi
              <span className="text-xs text-white/60">{showPlanDetails ? "Hide details" : "View details"}</span>
              <span className="text-xs text-white/50">{showPlanDetails ? "▲" : "▼"}</span>
            </span>
          </button>
        </div>

        {showPlanDetails ? (
          <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6">
            <div className="text-center">
              <div className="text-lg font-semibold">Activate Bizzi</div>
              <p className="text-sm text-white/60">
                Start Bizzi with full AI workflow automation and a monthly human review layer.
              </p>
            </div>

            <div className="mt-5 flex justify-center">
              <div className="w-full max-w-2xl rounded-2xl border border-emerald-400/20 bg-black/20 p-6 shadow-[0_0_22px_rgba(16,185,129,0.15)]">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xl font-semibold">Bizzi + Human Review</div>
                    <div className="mt-2 flex items-end gap-2">
                      <span className="text-3xl font-semibold text-white">$169</span>
                      <span className="text-xs uppercase tracking-wide text-white/60">USD / month</span>
                    </div>
                    <div className="mt-3 text-sm text-white/70">
                      Bizzi automates your bookkeeping workflows, financial visibility, and tax readiness — with a monthly
                      human review layer for added accuracy and confidence.
                    </div>
                  </div>
                  {isCurrentPlan && (
                    <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2.5 py-1 text-xs font-semibold text-emerald-200">
                      Current plan
                    </span>
                  )}
                </div>

                <button
                  onClick={planButtonState.action}
                  disabled={planButtonState.disabled}
                  className={[
                    "mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full border px-4 py-2.5 text-sm font-semibold transition disabled:opacity-60",
                    planButtonState.variant === "activate"
                      ? "border-emerald-300/60 bg-emerald-300/90 text-black shadow-[0_0_12px_rgba(16,185,129,0.35)] hover:opacity-90"
                      : planButtonState.variant === "current"
                        ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                        : "border-white/15 bg-white/5 text-white/90 hover:bg-white/10",
                  ].join(" ")}
                >
                  {planButtonState.label}
                </button>

                <ul className="mt-5 grid gap-2 text-sm text-white/75 sm:grid-cols-2">
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-2 w-2 rounded-full bg-emerald-300/80" aria-hidden="true" />
                    Automated bookkeeping workflows
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-2 w-2 rounded-full bg-emerald-300/80" aria-hidden="true" />
                    Transaction categorization and organization
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-2 w-2 rounded-full bg-emerald-300/80" aria-hidden="true" />
                    Forecasting and financial visibility
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-2 w-2 rounded-full bg-emerald-300/80" aria-hidden="true" />
                    Trade-specific financial insights
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-2 w-2 rounded-full bg-emerald-300/80" aria-hidden="true" />
                    AI financial assistant
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-2 w-2 rounded-full bg-emerald-300/80" aria-hidden="true" />
                    Monthly human review layer
                  </li>
                </ul>
              </div>
            </div>

            {checkoutError ? (
              <p className="mt-3 text-xs text-amber-200/90">{checkoutError}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5 shadow-[0_0_18px_rgba(16,185,129,0.08)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">Billing Management</div>
            <p className="text-sm text-white/60">
              Update payment methods, download invoices, or cancel anytime in the Billing Portal.
            </p>
          </div>
          {canManagePortal ? (
            <button
              onClick={openPortal}
              disabled={busyAction !== null}
              className="inline-flex items-center gap-2 rounded-md border border-white/15 px-4 py-2 text-sm font-semibold text-white/90 transition hover:bg-white/5 disabled:opacity-60"
            >
              {busyAction === "portal" ? "Opening portal…" : "Manage Billing"}
            </button>
          ) : (
            <span className="text-xs text-white/50">No billing portal available yet.</span>
          )}
        </div>
        {portalError ? (
          <p className="mt-3 text-xs text-amber-200/90">{portalError}</p>
        ) : null}
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5 shadow-[0_0_18px_rgba(16,185,129,0.08)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">Payment Method</div>
            <p className="text-sm text-white/60">Card on file used for renewals.</p>
          </div>
        </div>
        <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-white/80">
          {loadingPaymentMethod ? (
            <span className="text-white/50">Loading payment method…</span>
          ) : paymentMethod ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold text-white/90">
                {String(paymentMethod.brand || "").toUpperCase()} ending in {paymentMethod.last4}
              </div>
              <div className="text-xs text-white/60">
                Expires {paymentMethod.exp_month}/{paymentMethod.exp_year}
              </div>
            </div>
          ) : (
            <span className="text-white/50">No payment method on file.</span>
          )}
        </div>
        {paymentMethodError ? (
          <p className="mt-2 text-xs text-amber-200/90">{paymentMethodError}</p>
        ) : null}
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5 shadow-[0_0_18px_rgba(16,185,129,0.08)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">Recent Invoices</div>
            <p className="text-sm text-white/60">Download receipts and payment history.</p>
          </div>
        </div>
        <div className="mt-3 space-y-2">
          {loadingInvoices ? (
            <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-white/50">
              Loading invoices…
            </div>
          ) : invoices && invoices.length ? (
            invoices.slice(0, 5).map((inv) => (
              <div
                key={inv.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-white/80"
              >
                <div>
                  <div className="text-white/90 font-semibold">Invoice {inv.number || inv.id}</div>
                  <div className="text-xs text-white/50">{formatDate(inv.created_at)}</div>
                </div>
                <div className="text-right">
                  <div className="text-white/80">
                    {inv.amount_paid ? "Paid" : "Due"} {formatMoney(inv.amount_paid || inv.amount_due, inv.currency)}
                  </div>
                  <div className="text-xs text-white/50">{inv.status}</div>
                </div>
                {inv.hosted_invoice_url ? (
                  <a
                    href={inv.hosted_invoice_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-md border border-white/10 px-3 py-1 text-xs text-white/80 hover:bg-white/5"
                  >
                    View
                  </a>
                ) : null}
              </div>
            ))
          ) : (
            <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-white/50">
              No invoices yet.
            </div>
          )}
        </div>
        {invoiceError ? (
          <p className="mt-2 text-xs text-amber-200/90">{invoiceError}</p>
        ) : null}
      </div>
    </div>
  );
}
