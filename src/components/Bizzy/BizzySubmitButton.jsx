// /components/Bizzy/BizzySubmitButton.jsx
import React from "react";
import { ArrowUp } from "lucide-react";

export default function BizzySubmitButton({
  onClick,
  isLoading = false,
  size = 36,
  disabled = false,
  className = "",
  title,
  withGlow = false,                 // <- NEW: no glow by default
  glowColor = "rgba(124,58,237,0.24)", // if you ever enable withGlow
}) {
  const dim = `${size}px`;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || isLoading}
      aria-label={isLoading ? "Bizzi is thinking…" : "Send to Bizzi"}
      title={title ?? (isLoading ? "Bizzi is thinking…" : "Send to Bizzi")}
      className={[
        "relative inline-flex items-center justify-center rounded-full",
        "bg-white/8 border border-white/20 text-white/85 backdrop-blur",
        "transition-transform duration-200",
        disabled || isLoading
          ? "opacity-90 cursor-not-allowed"
          : "hover:scale-105 hover:border-[var(--accent-line)] hover:text-[var(--accent-contrast)] cursor-pointer",
        className,
      ].join(" ")}
      style={{ width: dim, height: dim, outline: "none", boxShadow: "none" }}
    >
      {/* OUTER HALO (disabled by default) */}
      {withGlow && (
        <div
          aria-hidden
          className="absolute -inset-2 rounded-full pointer-events-none"
          style={{ boxShadow: `0 0 14px ${glowColor}` }}
        />
      )}

      {/* Send icon */}
      <div className="relative z-10 flex items-center justify-center">
        <ArrowUp
          size={Math.floor(size * 0.58)}
          color="currentColor"
          strokeWidth={2.4}
          aria-hidden="true"
        />
      </div>
    </button>
  );
}
