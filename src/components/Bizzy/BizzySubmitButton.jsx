// /components/Bizzy/BizzySubmitButton.jsx
import React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Brain as PhBrain } from "@phosphor-icons/react"; // npm i @phosphor-icons/react

export default function BizzySubmitButton({
  onClick,
  isLoading = false,
  size = 36,
  disabled = false,
  className = "",
  title,
  Icon = PhBrain,
  withGlow = false,                 // <- NEW: no glow by default
  glowColor = "rgba(124,58,237,0.24)", // if you ever enable withGlow
}) {
  const dim = `${size}px`;
  const prefersReducedMotion = useReducedMotion();
  const spin =
    isLoading && !prefersReducedMotion
      ? {
          animate: { rotate: 360 },
          transition: { repeat: Infinity, duration: 1.6, ease: "linear" },
        }
      : {};

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || isLoading}
      aria-label={isLoading ? "Bizzi is thinking…" : "Send to Bizzi"}
      title={title ?? (isLoading ? "Bizzi is thinking…" : "Send to Bizzi")}
      className={[
        "relative inline-flex items-center justify-center rounded-full",
        "bg-black/80 border border-white/20 backdrop-blur",
        "transition-transform duration-200",
        disabled || isLoading ? "opacity-90 cursor-not-allowed" : "hover:scale-105 cursor-pointer",
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

      {/* Slim inner ring */}
      <div
        aria-hidden
        className="absolute inset-[2px] rounded-full"
        style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.28)" }}
      />

      {/* Inner canvas */}
      <div
        aria-hidden
        className="absolute rounded-full"
        style={{
          inset: "3px",
          background: "#0b0b0c",
          boxShadow:
            "inset 0 0 0 1px rgba(255,255,255,0.06), inset 0 -6px 14px rgba(0,0,0,0.35), inset 0 8px 22px rgba(255,255,255,0.05)",
        }}
      />

      {/* Icon (spins only while loading) */}
      <motion.div className="relative z-10" {...spin}>
        <Icon size={Math.floor(size * 0.72)} color="#EDEDED" weight="regular" />
      </motion.div>
    </button>
  );
}
