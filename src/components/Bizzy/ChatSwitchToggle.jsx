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
  // Hide on ChatHome entirely
  const isChatHome = location.pathname.startsWith("/dashboard/bizzi/chat") || location.pathname.startsWith("/chat");
  if (isChatHome) return null;

  const lastDash = localStorage.getItem("bizzy:lastDashboard") || "/dashboard/bizzi";

  const goToDash = () => navigate(lastDash, { replace: false });
  const goToChat = () => navigate("/dashboard/bizzi/chat", { replace: false });

  const label = context === "chat" ? "Dashboard" : "Chat";
  const onClick = context === "chat" ? goToDash : goToChat;
  const defaultStyle = { ...style };

  return (
    <button
      onClick={onClick}
      className={[
        "inline-flex items-center gap-2 rounded-md border border-transparent bg-transparent hover:bg-white/6",
        "px-2.5 py-1 text-sm",
        "text-white/75 hover:text-white transition-colors",
        className,
      ].join(" ")}
      style={defaultStyle}
      title={label}
      aria-label={label}
    >
      <ArrowLeft size={16} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
