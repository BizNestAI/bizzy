import React from "react";

export default function ChatCanvasToggle({ accent = "#22c55e", onClose }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 12px",
        borderRadius: 10,
        marginBottom: 10,
        border: `1px solid ${accent}38`,
        background: "rgba(12,15,18,0.6)",
        boxShadow: `0 0 12px ${accent}16`
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 8, height: 8, borderRadius: 8,
            background: accent, boxShadow: `0 0 10px ${accent}aa`
          }}
        />
        <div style={{ color: "#fff", fontWeight: 600 }}>Bizzi Conversation</div>
      </div>

      <button
        onClick={onClose}
        style={{
          color: "#cbd5e1",
          fontSize: 13,
          border: `1px solid ${accent}25`,
          padding: "4px 10px",
          borderRadius: 8,
          background: "transparent"
        }}
        onMouseEnter={e => e.currentTarget.style.background = `${accent}14`}
        onMouseLeave={e => e.currentTarget.style.background = "transparent"}
        title="Back to dashboard"
      >
        ↩ Back to Dashboard
      </button>
    </div>
  );
}
