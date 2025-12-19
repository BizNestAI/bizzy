import React from "react";
import { useNavigate } from "react-router-dom";

export default function LiveModePlaceholder({
  title = "Connect your accounts to view live data",
  message = "Live Mode is on. Sync your accounting, marketing, banking, and job tools to bring real data into this dashboard.",
  cta = "Open Settings/Sync",
}) {
  const navigate = useNavigate();
  return (
    <div className="w-full min-h-[420px] flex items-center justify-center px-4">
      <div className="max-w-2xl rounded-3xl border border-white/10 bg-gradient-to-b from-white/10 to-white/[0.03] p-8 text-center shadow-[0_45px_120px_rgba(0,0,0,0.55)]">
        <h2 className="text-2xl font-semibold text-white mb-3">{title}</h2>
        <p className="text-sm text-white/70 mb-6">{message}</p>
        <button
          onClick={() => navigate("/dashboard/settings?tab=integrations")}
          className="inline-flex items-center justify-center rounded-full bg-white text-black font-semibold px-5 py-2 text-sm hover:bg-white/90 transition"
        >
          {cta}
        </button>
      </div>
    </div>
  );
}
