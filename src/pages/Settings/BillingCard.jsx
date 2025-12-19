// src/pages/Settings/BillingCard.jsx
import React, { useState } from "react";
import { apiUrl } from "../../utils/safeFetch";

/**
 * BillingCard – Checkout + Portal
 */
export default function BillingCard({ userId, businessId, status }) {
  const [busy, setBusy] = useState(false);

  async function startCheckout() {
    try {
      setBusy(true);
      const res = await fetch(apiUrl("/api/billing/create-checkout-session"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, business_id: businessId }),
      });
      const json = await res.json();
      if (json?.url) window.location.href = json.url;
      else throw new Error(json?.error || "No checkout URL returned");
    } catch (err) {
      console.error("checkout error", err);
      alert("Failed to start checkout.");
    } finally {
      setBusy(false);
    }
  }

  async function openPortal() {
    try {
      setBusy(true);
      const res = await fetch(apiUrl("/api/billing/create-portal-session"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      });
      const json = await res.json();
      if (json?.url) window.location.href = json.url;
      else throw new Error(json?.error || "No portal URL returned");
    } catch (err) {
      console.error("portal error", err);
      alert("Failed to open billing portal.");
    } finally {
      setBusy(false);
    }
  }

  const active = status?.status === "active";
  const trialing = status?.status === "trialing";

  return (
    <div className="rounded-2xl border border-white/10 p-4 sm:p-5 bg-white/5">
      <div className="text-lg font-semibold mb-2">Subscription & Billing</div>

      {status ? (
        <p className="text-sm text-white/70 mb-3">
          Status: <b>{status.status}</b>
          {status?.nextCharge && <> · Next charge: <b>{new Date(status.nextCharge).toLocaleDateString()}</b></>}
        </p>
      ) : (
        <p className="text-sm text-white/70 mb-3">
          Start your subscription to unlock Bizzi Biz. We bill on the 1st of each month.
        </p>
      )}

      {!active ? (
        <button
          onClick={startCheckout}
          disabled={busy}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-[var(--accent)] text-black hover:opacity-90 shadow-[0_0_12px_var(--accent)]"
        >
          {trialing ? "Continue Trial → Subscribe" : busy ? "Redirecting…" : "Subscribe"}
        </button>
      ) : (
        <button
          onClick={openPortal}
          disabled={busy}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-white/15 hover:bg-white/5"
        >
          {busy ? "Opening…" : "Manage Billing"}
        </button>
      )}
    </div>
  );
}
