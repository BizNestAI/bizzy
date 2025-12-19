// src/components/Bizzy/ChatSwitchToggle.jsx
import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useBizzyChatContext } from "../../context/BizzyChatContext";
import { ArrowLeft } from "lucide-react";

export default function ChatSwitchToggle({
  context,      // "chat" | "dashboard"  (where this toggle is rendered)
  className = "", 
  alignWithin = "section", // parent is positioned relative; we absolute-position inside it
  style = {},
}) {
  const { isCanvasOpen = false } = useBizzyChatContext();
  const navigate = useNavigate();
  const location = useLocation();

  // Don't render if a conversation is active; ChatCanvas has its own back button.
  if (isCanvasOpen) return null;

  const lastDash = localStorage.getItem("bizzy:lastDashboard") || "/dashboard/bizzy";
  const isChatHome = location.pathname.startsWith("/chat");

  const goToDash = () => navigate(lastDash, { replace: false });
  const goToChat = () => navigate("/chat", { replace: false });

  const label = context === "chat" ? "Dashboard" : "Chat";
  const onClick = context === "chat" ? goToDash : goToChat;

  return (
    <button
      onClick={onClick}
      className={[
        "absolute top-3 right-3 md:top-0 md:right-5",
        "inline-flex items-center gap-2 rounded-md",
        "px-3 py-1.5 text-sm",
        "hover:bg-white/10",
        "text-white/75 hover:text-white transition",
        className,
      ].join(" ")}
      style={style}
      title={label}
      aria-label={label}
    >
      <ArrowLeft size={16} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
