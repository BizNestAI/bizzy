import React from "react";

export default function UserMessageBubble({ children, className = "" }) {
  return (
    <div className={["bizzy-user-message", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}
