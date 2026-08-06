import React, { useEffect, useMemo, useState } from "react";
import { getDailyGreeting } from "../../api/greetings/dailyGreeting";
import { shouldSuppressTabRestoreMotion } from "../../utils/tabVisibilityMotionGuard";

const STORAGE_KEY_PREFIX = "bizzy:chatGreeting:";
const WARM_TEXT = "var(--text)";

export default function ChatGreeting({ className = "", textOverride = null, opacity = 1 }) {
  const [today, setToday] = useState(() => {
    const now = new Date();
    return {
      dayKey: now.getDay(),
      stamp: now.toISOString().slice(0, 10),
    };
  });

  const storageKey = `${STORAGE_KEY_PREFIX}${today.stamp}`;
  const [displayed, setDisplayed] = useState("");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const updateToday = () => {
      const now = new Date();
      setToday({
        dayKey: now.getDay(),
        stamp: now.toISOString().slice(0, 10),
      });
    };
    const scheduleNext = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(24, 0, 0, 0);
      const delay = Math.max(1000, next.getTime() - now.getTime());
      return setTimeout(() => {
        updateToday();
        scheduleNext();
      }, delay);
    };
    const timeoutId = scheduleNext();
    return () => clearTimeout(timeoutId);
  }, []);

  const combinedGreeting = useMemo(() => {
    if (textOverride) return textOverride;
    return getDailyGreeting(today.stamp);
  }, [today.stamp, textOverride]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setDisplayed(combinedGreeting);
    const skipFade = shouldSuppressTabRestoreMotion();
    setVisible(skipFade);
    if (skipFade) return;
    // show after a short delay for fade-in
    const t = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(t);
  }, [storageKey, combinedGreeting]);

  return (
    <div
      className={[
        "text-center font-medium transition tracking-normal mx-auto whitespace-nowrap",
        className,
      ].join(" ")}
      style={{
        fontFamily: "inherit",
        color: WARM_TEXT,
        fontSize: "clamp(20px, 2.25vw, 24px)",
        lineHeight: 1.15,
        maxWidth: "1200px",
        opacity: visible ? opacity : 0,
        transition: "opacity 320ms ease",
      }}
    >
      {displayed}
    </div>
  );
}
