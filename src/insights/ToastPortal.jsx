import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, AlertTriangle, Check, Info, X } from "lucide-react";
import { appendUniqueToast, createToastCountdown, normalizeToast, shouldReduceToastMotion } from "./toastModel.js";

const VARIANTS = {
  success: { Icon: Check, accent: "text-emerald-300", icon: "border-emerald-300/25 bg-emerald-400/10" },
  warning: { Icon: AlertTriangle, accent: "text-amber-300", icon: "border-amber-300/25 bg-amber-400/10" },
  error: { Icon: AlertCircle, accent: "text-rose-300", icon: "border-rose-300/25 bg-rose-400/10" },
  info: { Icon: Info, accent: "text-slate-300", icon: "border-sky-300/20 bg-sky-400/10" },
};

function ToastCard({ toast, onDismiss }) {
  const variant = VARIANTS[toast.severity] || VARIANTS.info;
  const { Icon } = variant;
  const countdownRef = useRef(null);
  const [exiting, setExiting] = useState(false);
  const reduceMotion = shouldReduceToastMotion();

  const finishDismiss = useCallback(() => {
    setExiting(true);
    window.setTimeout(() => onDismiss(toast.id), reduceMotion ? 0 : 150);
  }, [onDismiss, reduceMotion, toast.id]);

  const resume = useCallback(() => {
    countdownRef.current?.resume();
  }, []);

  const pause = useCallback(() => {
    countdownRef.current?.pause();
  }, []);

  useEffect(() => {
    const countdown = createToastCountdown({ timeout: toast.timeout, onElapsed: finishDismiss, setTimer: window.setTimeout, clearTimer: window.clearTimeout });
    countdownRef.current = countdown;
    countdown.resume();
    return () => countdown.cancel();
  }, [finishDismiss, toast.timeout]);

  const role = toast.severity === "error" ? "alert" : "status";
  return (
    <section
      role={role}
      aria-live={toast.severity === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      data-toast-variant={toast.severity}
      data-state={exiting ? "closed" : "open"}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocusCapture={pause}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) resume();
      }}
      className={`pointer-events-auto relative w-full overflow-hidden rounded-[15px] border border-white/[0.09] bg-[#171a19]/[0.98] p-4 text-slate-100 shadow-[0_14px_34px_rgba(0,0,0,0.38)] backdrop-blur-sm motion-reduce:transition-none ${
        exiting
          ? "translate-x-2 opacity-0 transition-[opacity,transform] duration-150 ease-in"
          : "animate-[bizzi-toast-in_200ms_cubic-bezier(0.16,1,0.3,1)]"
      }`}
    >
      <div className="flex items-start gap-3 pr-6">
        <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${variant.icon} ${variant.accent}`} aria-hidden="true">
          <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold leading-5 text-slate-50">{toast.title}</h2>
          {toast.description ? <p className="mt-0.5 text-[13px] leading-[18px] text-slate-300/75">{toast.description}</p> : null}
          {toast.action?.label ? (
            <button
              type="button"
              onClick={async () => {
                pause();
                try {
                  await toast.action.onClick?.(toast);
                } finally {
                  finishDismiss();
                }
              }}
              className={`mt-2 rounded-md px-0.5 py-0.5 text-[13px] font-medium ${variant.accent} outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-emerald-300/55 focus-visible:ring-offset-2 focus-visible:ring-offset-[#171a19]`}
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        onClick={finishDismiss}
        aria-label="Dismiss notification"
        className="absolute right-2.5 top-2.5 inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400/65 outline-none transition-colors hover:bg-white/[0.06] hover:text-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-300/55 motion-reduce:transition-none"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </section>
  );
}

export default function ToastPortal() {
  const [el] = useState(() => document.createElement("div"));
  const [toasts, setToasts] = useState([]);
  const nextIdRef = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  useEffect(() => {
    el.dataset.bizziToastViewport = "true";
    document.body.appendChild(el);
    const handler = (event) => {
      const toast = normalizeToast(event.detail || {}, `toast-${++nextIdRef.current}`);
      setToasts((current) => appendUniqueToast(current, toast));
    };
    window.addEventListener("bizzy:toast", handler);
    return () => {
      el.remove();
      window.removeEventListener("bizzy:toast", handler);
    };
  }, [el]);

  return createPortal(
    <div
      className="pointer-events-none fixed right-[max(16px,env(safe-area-inset-right))] top-[84px] z-[50020] flex w-[min(370px,calc(100vw-32px))] flex-col gap-2 max-sm:left-[max(12px,env(safe-area-inset-left))] max-sm:right-[max(12px,env(safe-area-inset-right))] max-sm:top-[72px] max-sm:w-auto"
      data-testid="toast-viewport"
    >
      {toasts.map((toast) => <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />)}
    </div>,
    el
  );
}
