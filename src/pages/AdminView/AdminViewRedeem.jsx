import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminView } from "../../context/AdminViewContext.jsx";

function cleanRedeemUrl() {
  if (typeof window === "undefined") return;
  window.history.replaceState({}, document.title, "/admin-view/redeem");
}

export default function AdminViewRedeem() {
  const navigate = useNavigate();
  const { redeemHandoff } = useAdminView();
  const [status, setStatus] = useState("opening");
  const [error, setError] = useState("");
  const redeemStartedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function redeem() {
      if (redeemStartedRef.current) return;
      redeemStartedRef.current = true;
      const params = new URLSearchParams(window.location.search || "");
      const token = String(params.get("token") || "").trim();
      cleanRedeemUrl();

      if (!token) {
        setStatus("failed");
        setError("admin_view_handoff_missing");
        return;
      }

      try {
        const context = await redeemHandoff(token);
        if (cancelled) return;
        setStatus("opened");
        navigate("/dashboard/bizzi/chat", { replace: true, state: { adminView: true, businessId: context?.businessId || null } });
      } catch (err) {
        if (cancelled) return;
        setStatus("failed");
        setError(err?.code || err?.message || "admin_view_redeem_failed");
      }
    }

    redeem();
    return () => {
      cancelled = true;
    };
  }, [navigate, redeemHandoff]);

  return (
    <div className="min-h-screen bg-[#050606] px-6 py-10 text-white">
      <div className="mx-auto mt-[12vh] max-w-lg rounded-[18px] border border-white/12 bg-[#111312] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.48)]">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-200/80">Admin View</p>
        <h1 className="mt-3 text-2xl font-semibold">
          {status === "failed" ? "Admin View session could not be opened" : "Opening customer app"}
        </h1>
        <p className="mt-3 text-sm leading-6 text-white/62">
          {status === "failed"
            ? "The handoff link is invalid, expired, or has already been used. Return to Monthly Review and open a new Admin View session."
            : "Redeeming the one-time handoff and loading the read-only customer workspace."}
        </p>
        {error ? (
          <div className="mt-5 rounded-[12px] border border-rose-200/18 bg-rose-300/10 px-3 py-2 text-sm font-semibold text-rose-100">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
