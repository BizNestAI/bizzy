import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../services/supabaseClient";
import { getDailyGreeting } from "../../api/greetings/dailyGreeting";

const STORAGE_KEY_PREFIX = "bizzy:chatGreeting:";
const FONT_STACK =
  "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial";
const WARM_TEXT = "var(--text)";

export default function ChatGreeting({ className = "", textOverride = null, opacity = 1 }) {
  const [today, setToday] = useState(() => {
    const now = new Date();
    return {
      dayKey: now.getDay(),
      stamp: now.toISOString().slice(0, 10),
    };
  });

  const message = useMemo(() => getDailyGreeting(), [today.dayKey]);

  const storageKey = `${STORAGE_KEY_PREFIX}${today.stamp}`;
  const [displayed, setDisplayed] = useState("");
  const [visible, setVisible] = useState(false);
  const [firstName, setFirstName] = useState("");

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

  useEffect(() => {
    let alive = true;
    async function loadFirstName() {
      try {
        const { data } = await supabase.auth.getSession();
        const userId = data?.session?.user?.id;
        if (!userId) return;
        const { data: profile, error } = await supabase
          .from("user_profiles")
          .select("first_name,full_name")
          .eq("id", userId)
          .maybeSingle();
        if (error) throw error;
        const metaFull = data?.session?.user?.user_metadata?.full_name || "";
        const rawFirst = profile?.first_name || "";
        const fallbackFull = profile?.full_name || metaFull || "";
        const name =
          rawFirst.trim() ||
          (fallbackFull || "").split(/\s+/)[0]?.trim() ||
          "";
        if (alive && name) setFirstName(name);
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[ChatGreeting] failed to load first name", e);
      }
    }
    loadFirstName();
    return () => {
      alive = false;
    };
  }, []);

  const combinedGreeting = useMemo(() => {
    if (textOverride) return textOverride;
    return getDailyGreeting(today.stamp, firstName);
  }, [firstName, today.stamp, message, textOverride]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const seen = window.localStorage?.getItem(storageKey);
    setDisplayed(combinedGreeting);
    setVisible(false);
    // show after a short delay for fade-in
    const t = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(t);
  }, [storageKey, combinedGreeting]);

  return (
    <div
      className={[
        "text-center font-medium transition tracking-tight mx-auto whitespace-nowrap",
        className,
      ].join(" ")}
      style={{
        fontFamily: FONT_STACK,
        color: WARM_TEXT,
        fontSize: "clamp(22px, 2.6vw, 27px)",
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
