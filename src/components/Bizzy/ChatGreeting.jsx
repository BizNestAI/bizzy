import React, { useEffect, useMemo, useState } from "react";
import { getDailyGreeting } from "../../api/greetings/dailyGreeting";

const STORAGE_KEY_PREFIX = "bizzy:chatGreeting:";
const TYPE_SPEED_MS = 38;
const FONT_STACK =
  "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial";
const WARM_TEXT = "var(--text)";

export default function ChatGreeting({ className = "" }) {
  const today = useMemo(() => {
    const now = new Date();
    return {
      dayKey: now.getDay(),
      stamp: now.toISOString().slice(0, 10),
    };
  }, []);

  const message = useMemo(() => getDailyGreeting(), [today.dayKey]);

  const storageKey = `${STORAGE_KEY_PREFIX}${today.stamp}`;
  const [displayed, setDisplayed] = useState("");
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const seen = window.localStorage?.getItem(storageKey);
    if (seen) {
      setDisplayed(message);
      setIsAnimating(false);
    } else {
      setDisplayed("");
      setIsAnimating(true);
    }
  }, [storageKey, message]);

  useEffect(() => {
    if (!isAnimating) return;
    let idx = 0;
    const interval = setInterval(() => {
      idx += 1;
      setDisplayed(message.slice(0, idx));
      if (idx >= message.length) {
        clearInterval(interval);
        setIsAnimating(false);
        try {
          window.localStorage?.setItem(storageKey, "1");
        } catch {
          /* ignore */
        }
      }
    }, TYPE_SPEED_MS);
    return () => clearInterval(interval);
  }, [isAnimating, message, storageKey]);

  return (
    <div
      className={[
        "text-center text-2xl sm:text-3xl md:text-[34px] font-medium transition tracking-tight",
        className,
      ].join(" ")}
      style={{ fontFamily: FONT_STACK, color: WARM_TEXT }}
    >
      {displayed}
      {isAnimating && <span className="inline-block w-3 animate-pulse">|</span>}
    </div>
  );
}
