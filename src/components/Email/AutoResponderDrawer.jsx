// src/components/email/AutoResponderDrawer.jsx
import React, { useEffect } from "react";
import { X } from "lucide-react";
import AutoResponderPanel from "./AutoResponderPanel";

/**
 * Props:
 * - open: boolean
 * - onClose: () => void
 * - accountId: string
 */
export default function AutoResponderDrawer({ open, onClose, accountId }) {
  // close on Esc
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && open && onClose?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      {/* backdrop */}
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      {/* panel */}
      <div
        className={`absolute right-0 top-0 h-full w-full max-w-md bg-[#0a0b0f] border-l border-zinc-800
                    transition-transform ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center justify-between p-3 border-b border-zinc-800">
          <div className="text-sm font-semibold text-zinc-200">Autoresponders</div>
          <button onClick={onClose} className="text-zinc-300 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="p-3 h-[calc(100%-44px)] overflow-y-auto">
          <AutoResponderPanel accountId={accountId} />
        </div>
      </div>
    </div>
  );
}
