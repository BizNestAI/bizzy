// src/components/Integrations/SyncButton.jsx
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, PlugZap, Check, ChevronDown } from "lucide-react";
import useIntegrationManager, { INTEGRATION_META } from "../../hooks/useIntegrationManager";

const STATUS_TEXT = {
  connected: "Connected",
  connecting: "Syncing…",
  awaiting: "Awaiting confirmation",
  error: "Retry",
  disconnected: "Sync now",
};

export default function SyncButton({
  providers = [],
  label,
  size = "md",
  onConnected,
  className = "",
  icon: Icon = PlugZap,
  variant = "chrome",
  forceDisconnected = false,
}) {
  const providerKey = useMemo(() => {
    try {
      return JSON.stringify(Array.isArray(providers) ? providers : []);
    } catch {
      return "[]";
    }
  }, [providers]);

  const list = useMemo(() => {
    try {
      const parsed = JSON.parse(providerKey);
      const arr = Array.isArray(parsed) && parsed.length ? parsed : ["quickbooks"];
      return Array.from(new Set(arr));
    } catch {
      return ["quickbooks"];
    }
  }, [providerKey]);
  const primary = list[0];
  const manager = useIntegrationManager();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuMounted, setMenuMounted] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const triggerRef = useRef(null);
  const menuPosition = useRef({ top: 0, left: 0 });
  const [, forceRender] = useState(0);
  const menuIdRef = useRef(`sync-menu-${Math.random().toString(36).slice(2)}`);

  const statuses = useMemo(
    () =>
      list.reduce((acc, key) => {
        acc[key] = manager.getStatus(key);
        return acc;
      }, {}),
    [list, manager]
  );

  const displayStatuses = useMemo(
    () =>
      list.reduce((acc, key) => {
        const status = statuses[key];
        if (forceDisconnected && status?.status !== "connecting") {
          acc[key] = { ...status, status: "disconnected" };
        } else {
          acc[key] = status;
        }
        return acc;
      }, {}),
    [forceDisconnected, list, statuses]
  );

  const anyConnecting = list.some((p) => displayStatuses[p]?.status === "connecting");
  const allConnected = list.every((p) => displayStatuses[p]?.status === "connected");
  // We no longer surface an "Awaiting" pill in the UI; statuses still tracked internally.

  const pills = {
    chrome:
      "rounded-full border border-white/12 bg-white/5 text-white/90 hover:bg-white/10",
    accent:
      "rounded-full border border-[color-mix(in_srgb,var(--accent)_45%,transparent)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]",
  };

  const paddings = size === "sm" ? "px-2.5 py-1.25 text-[12px]" : "px-3 py-1.5 text-[13px]";

  const updateMenuPosition = useCallback(() => {
    if (typeof window === "undefined" || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const width = 260;
    const top = rect.bottom + window.scrollY + 8;
    const viewportLeft = window.scrollX + 16;
    const viewportRight = window.scrollX + window.innerWidth - 16;
    let left = rect.right + window.scrollX - width;
    if (left < viewportLeft) left = viewportLeft;
    if (left + width > viewportRight) left = viewportRight - width;
    menuPosition.current = { top, left, width };
    forceRender((t) => t + 1);
  }, [forceRender]);

  useLayoutEffect(() => {
    if (menuOpen) updateMenuPosition();
  }, [menuOpen, updateMenuPosition]);

  useEffect(() => {
    let timeout;
    if (menuOpen) {
      setMenuMounted(true);
      requestAnimationFrame(() => setMenuVisible(true));
    } else if (menuMounted) {
      setMenuVisible(false);
      timeout = setTimeout(() => setMenuMounted(false), 180);
    }
    return () => timeout && clearTimeout(timeout);
  }, [menuOpen, menuMounted]);

  useEffect(() => {
    if (!menuMounted) return undefined;
    const handleGlobal = (event) => {
      const btn = triggerRef.current;
      const menuEl = document.getElementById(menuIdRef.current);
      if (btn?.contains(event.target) || menuEl?.contains(event.target)) return;
      setMenuOpen(false);
    };
    const handleReposition = () => updateMenuPosition();
    document.addEventListener("mousedown", handleGlobal);
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    return () => {
      document.removeEventListener("mousedown", handleGlobal);
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [menuMounted, updateMenuPosition]);

  const handlePrimary = async () => {
    if (list.length > 1) {
      setMenuOpen((v) => !v);
      return;
    }
    await triggerConnect(primary);
  };

  const triggerConnect = async (provider) => {
    try {
      await manager.connect(provider);
      onConnected?.(provider);
      setMenuOpen(false);
    } catch {
      // errors are surfaced via toast; keep button enabled
    }
  };

  const renderLabel = () => {
    if (label) return label;
    if (list.length === 1) {
      const meta = INTEGRATION_META[primary];
      return meta?.cta || "Sync";
    }
    return "Sync Accounts";
  };

  if (allConnected) {
    return (
      <div
        className={`inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/12 text-emerald-100 px-3 py-1.5 text-[13px] font-medium ${className}`}
      >
        <Check size={16} /> Synced
      </div>
    );
  }

  return (
    <div className={`relative inline-flex items-center ${className}`}>
      <button
        type="button"
        ref={triggerRef}
        onClick={handlePrimary}
        disabled={anyConnecting}
        className={`inline-flex items-center gap-2 font-medium transition ${pills[variant] || pills.chrome} ${paddings}`}
        style={{ minHeight: size === "sm" ? 30 : 34 }}
      >
        {anyConnecting ? (
          <Loader2 size={16} className="animate-spin" />
        ) : allConnected ? (
          <Check size={16} className="text-emerald-400" />
        ) : (
          <Icon size={16} className="opacity-80" />
        )}
        <span>{renderLabel()}</span>
        {list.length > 1 ? <ChevronDown size={14} className="opacity-70" /> : null}
      </button>
      {menuMounted && typeof document !== "undefined"
        ? createPortal(
            <div
              id={menuIdRef.current}
              className="fixed z-[2000]"
              style={{
                top: menuPosition.current.top,
                left: menuPosition.current.left,
                width: menuPosition.current.width || 260,
              }}
            >
              <div
                className={`rounded-2xl border border-white/10 bg-app/95 p-2 shadow-[0_20px_45px_rgba(0,0,0,0.45)] backdrop-blur transition-all duration-200 ease-out origin-top-right ${
                  menuVisible
                    ? "opacity-100 scale-100 translate-y-0"
                    : "opacity-0 scale-95 -translate-y-1"
                }`}
              >
                {list.map((provider) => {
                  const meta = INTEGRATION_META[provider];
                  const status = displayStatuses[provider];
                  const busy = status?.status === "connecting";
                  const text = STATUS_TEXT[status?.status] || "Sync";
                  return (
                    <button
                      key={provider}
                      onClick={() => triggerConnect(provider)}
                      disabled={busy}
                      className="w-full text-left rounded-xl px-3 py-2 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/40"
                    >
                      <div className="flex items-center justify-between text-sm font-semibold">
                        <span>{meta?.label || provider}</span>
                        {busy ? (
                          <Loader2 size={14} className="animate-spin text-white/70" />
                        ) : status?.status === "connected" ? (
                          <Check size={14} className="text-emerald-400" />
                        ) : null}
                      </div>
                      <div className="text-[11px] text-white/60">
                        {meta?.description || text}
                      </div>
                      <div className="text-[11px] text-white/50 mt-1">{text}</div>
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
