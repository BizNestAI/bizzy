// File: /src/components/Navigation/SubsectionTabs.jsx
import React from "react";
import { useNavigate, useLocation } from "react-router-dom";

export default function SubsectionTabs({ items = [], align = "center" }) {
  const navigate = useNavigate();
  const location = useLocation();

  if (!items.length) return null;

  const justify = align === "end" ? "justify-end" : align === "start" ? "justify-start" : "justify-center";

  return (
    <div className={`flex ${justify} mt-3 mb-2`}>
      <div
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/12 backdrop-blur"
        style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.35)", backgroundColor: "var(--header-overlay)" }}
      >
        {items.map((item, idx) => {
          const disabled = !!item.disableNavigate;
          const active = !disabled && (location.pathname === item.path || item.activePaths?.includes(location.pathname));
          return (
            <React.Fragment key={item.path}>
              <button
                type="button"
                onClick={(event) => {
                  if (disabled) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }
                  navigate(item.path);
                }}
                title={item.tooltip || undefined}
                aria-disabled={disabled ? "true" : undefined}
                className={`text-sm transition px-2 py-1 rounded-md ${
                  active
                    ? "text-[var(--text)] bg-[rgba(var(--accent-rgb),0.14)] border border-[rgba(var(--accent-rgb),0.45)] shadow-[0_0_12px_rgba(var(--accent-rgb),0.25)]"
                    : disabled
                    ? "text-white/35 cursor-not-allowed hover:text-white/45"
                    : "text-white/80 hover:text-white hover:bg-[rgba(var(--accent-rgb),0.08)]"
                } focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgba(var(--accent-rgb),0.45)]`}
              >
                {item.label}
              </button>
              {idx < items.length - 1 && <span className="text-white/35 text-sm">|</span>}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
