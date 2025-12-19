import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, Info, AlertTriangle, AlertOctagon, X } from "lucide-react";

/**
 * Toast shape:
 * { id, title, body, severity: 'info'|'success'|'warning'|'error', timeout }
 */

const ToastCtx = createContext({ pushToast: () => {} });

const COLORS = {
  info:    { ring: "ring-blue-400/40",    bg: "bg-blue-900/80",    text: "text-blue-100"    },
  success: { ring: "ring-emerald-400/40", bg: "bg-emerald-900/80", text: "text-emerald-100" },
  warning: { ring: "ring-yellow-400/40",  bg: "bg-yellow-900/80",  text: "text-yellow-100"  },
  error:   { ring: "ring-rose-400/40",    bg: "bg-rose-900/80",    text: "text-rose-100"    },
};

const ICON = {
  info: Info,
  success: CheckCircle,
  warning: AlertTriangle,
  error: AlertOctagon,
};

export function ToastProvider({ children, defaultTimeout = 4000, listenToWindow = true }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const remove = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const pushToast = useCallback((t) => {
    const id = ++idRef.current;
    const toast = {
      id,
      title: t.title || "Notice",
      body: t.body || "",
      severity: t.severity || "info",
      timeout: t.timeout ?? defaultTimeout,
    };
    setToasts((prev) => [...prev, toast]);
    if (toast.timeout > 0) {
      setTimeout(() => remove(id), toast.timeout);
    }
    return id;
  }, [defaultTimeout, remove]);

  // Listen to window "bizzy:toast" events (you already use this pattern)
  useEffect(() => {
    if (!listenToWindow) return;
    const handler = (e) => pushToast(e.detail || {});
    window.addEventListener("bizzy:toast", handler);
    return () => window.removeEventListener("bizzy:toast", handler);
  }, [listenToWindow, pushToast]);

  const value = useMemo(() => ({ pushToast }), [pushToast]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      {/* Container */}
      <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-3 w-[clamp(260px,28vw,360px)]">
        {toasts.map((t) => {
          const Icon = ICON[t.severity] || ICON.info;
          const c = COLORS[t.severity] || COLORS.info;
          return (
            <div
              key={t.id}
              className={`relative ${c.bg} ${c.text} ring-1 ${c.ring} backdrop-blur rounded-xl p-3 shadow-xl
                          animate-in fade-in slide-in-from-bottom-2 duration-200`}
            >
              <div className="flex items-start gap-3 pr-6">
                <Icon size={18} className="mt-0.5 opacity-90" />
                <div className="flex-1">
                  <div className="font-semibold leading-tight">{t.title}</div>
                  {t.body && <div className="text-xs opacity-90 mt-0.5 whitespace-pre-line">{t.body}</div>}
                </div>
                <button
                  className="absolute top-2 right-2 p-1 rounded hover:bg-white/10"
                  onClick={() => remove(t.id)}
                  aria-label="Dismiss"
                  title="Dismiss"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx); // { pushToast }
}
