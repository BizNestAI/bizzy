import React from "react";
import { Info, CheckCircle, AlertTriangle, AlertOctagon, X } from "lucide-react";

const VAR = {
  info:    { ring: "ring-blue-400/30",    bg: "bg-blue-900/40",    text: "text-blue-100",    Icon: Info },
  success: { ring: "ring-emerald-400/30", bg: "bg-emerald-900/40", text: "text-emerald-100", Icon: CheckCircle },
  warning: { ring: "ring-yellow-400/30",  bg: "bg-yellow-900/40",  text: "text-yellow-100",  Icon: AlertTriangle },
  error:   { ring: "ring-rose-400/30",    bg: "bg-rose-900/40",    text: "text-rose-100",    Icon: AlertOctagon },
};

export default function Banner({ variant = "info", title, children, onClose, className = "" }) {
  const v = VAR[variant] || VAR.info;
  const Icon = v.Icon;
  return (
    <div className={`relative ${v.bg} ${v.text} ring-1 ${v.ring} rounded-xl p-3 ${className}`}>
      <div className="flex items-start gap-3 pr-6">
        <Icon size={18} className="mt-0.5 opacity-90" />
        <div className="flex-1">
          {title && <div className="font-semibold leading-tight">{title}</div>}
          {children && <div className="text-xs opacity-90 mt-0.5">{children}</div>}
        </div>
        {onClose && (
          <button
            className="absolute top-2 right-2 p-1 rounded hover:bg-white/10"
            onClick={onClose}
            aria-label="Dismiss"
            title="Dismiss"
          >
            <X size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
