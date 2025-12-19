// File: /src/context/PeriodContext.jsx
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

const PeriodContext = createContext(null);
const STORAGE_KEY = "bizzy.period";

/** Utilities */
function clampMonth(m) {
  const n = Number(m);
  if (!Number.isFinite(n)) return 1;
  if (n < 1) return 1;
  if (n > 12) return 12;
  return n;
}

function normalizeYear(y) {
  const n = Number(y);
  return Number.isFinite(n) ? n : new Date().getFullYear();
}

function toMonthText({ year, month }) {
  return `${year}-${String(month).padStart(2, "0")}`; // "YYYY-MM"
}

function fromMonthText(text) {
  // Accepts "YYYY-MM" or "YYYY-MM-DD"
  if (!text || typeof text !== "string") return null;
  const [y, m] = text.split("-").map((t) => Number(t));
  if (!y || !m) return null;
  return { year: normalizeYear(y), month: clampMonth(m) };
}

function monthLabel(year, month, locale) {
  const d = new Date(year, month - 1, 1);
  return d.toLocaleString(locale || undefined, { month: "short", year: "numeric" }); // e.g., "Sep 2025"
}

/** Optional: get initial period from URL */
function readUrlPeriod() {
  try {
    const url = new URL(window.location.href);
    const y = url.searchParams.get("year");
    const m = url.searchParams.get("month");
    if (y && m) {
      return { year: normalizeYear(y), month: clampMonth(m) };
    }
  } catch {}
  return null;
}

/** Optional: write period to URL (without full page reload) */
function writeUrlPeriod({ year, month }) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("year", String(year));
    url.searchParams.set("month", String(month));
    window.history.replaceState({}, "", url.toString());
  } catch {}
}

/** Persist/restore from localStorage */
function readStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj && obj.year && obj.month) {
      return { year: normalizeYear(obj.year), month: clampMonth(obj.month) };
    }
  } catch {}
  return null;
}

function writeStorage(period) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(period));
  } catch {}
}

/** Provider */
export function PeriodProvider({
  children,
  /** If true, provider will initialize from URL (?year=&month=) before storage/current */
  syncUrl = true,
  /** If true, provider keeps URL in sync on changes */
  writeUrl = true,
  /** If true, when a new calendar month begins and the stored period is stale, snap to current month on first load */
  autoSnapToCurrentMonth = true,
  /** Optional default, otherwise current month */
  defaultPeriod,
}) {
  const now = new Date();
  const currentDefault = useMemo(
    () =>
      defaultPeriod && defaultPeriod.year && defaultPeriod.month
        ? { year: normalizeYear(defaultPeriod.year), month: clampMonth(defaultPeriod.month) }
        : { year: now.getFullYear(), month: now.getMonth() + 1 },
    [defaultPeriod, now]
  );

  const initial = useMemo(() => {
    // Priority: URL → storage → default/current
    const fromUrl = syncUrl ? readUrlPeriod() : null;
    const fromStore = readStorage();
    let base = fromUrl || fromStore || currentDefault;

    if (autoSnapToCurrentMonth) {
      const isSameMonth =
        base.year === now.getFullYear() && base.month === now.getMonth() + 1;
      // If storage is older than current month and URL didn't override, snap to current
      if (!fromUrl && !isSameMonth) {
        base = { year: now.getFullYear(), month: now.getMonth() + 1 };
      }
    }
    return base;
  }, [syncUrl, currentDefault, autoSnapToCurrentMonth, now]);

  const [period, setPeriodState] = useState(initial);
  const lastRef = useRef(initial);

  const emitChange = useCallback((p) => {
    try {
      window.dispatchEvent(new CustomEvent("period:changed", { detail: p }));
    } catch {}
  }, []);

  const setPeriod = useCallback(
    (updater) => {
      setPeriodState((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        const normalized = {
          year: normalizeYear(next.year),
          month: clampMonth(next.month),
        };
        if (
          normalized.year === prev.year &&
          normalized.month === prev.month
        ) {
          return prev; // no-op
        }
        writeStorage(normalized);
        if (writeUrl) writeUrlPeriod(normalized);
        emitChange(normalized);
        lastRef.current = normalized;
        return normalized;
      });
    },
    [emitChange, writeUrl]
  );

  const setYearMonth = useCallback(
    (year, month) => setPeriod({ year: normalizeYear(year), month: clampMonth(month) }),
    [setPeriod]
  );

  const setFromYYYYMM = useCallback(
    (yyyyMm) => {
      const parsed = fromMonthText(yyyyMm);
      if (parsed) setPeriod(parsed);
    },
    [setPeriod]
  );

  const setToday = useCallback(() => {
    const d = new Date();
    setPeriod({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }, [setPeriod]);

  const nextMonth = useCallback(() => {
    setPeriod((prev) => {
      const m = prev.month + 1;
      if (m > 12) return { year: prev.year + 1, month: 1 };
      return { year: prev.year, month: m };
    });
  }, [setPeriod]);

  const prevMonth = useCallback(() => {
    setPeriod((prev) => {
      const m = prev.month - 1;
      if (m < 1) return { year: prev.year - 1, month: 12 };
      return { year: prev.year, month: m };
    });
  }, [setPeriod]);

  // Keep URL synchronized on first mount if desired
  useEffect(() => {
    if (writeUrl) writeUrlPeriod(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo(
    () => ({
      period,
      setPeriod,
      setYearMonth,
      setFromYYYYMM,
      setToday,
      nextMonth,
      prevMonth,
      toMonthText: () => toMonthText(period),
      label: (locale) => monthLabel(period.year, period.month, locale),
      isCurrentMonth:
        period.year === now.getFullYear() && period.month === now.getMonth() + 1,
    }),
    [period, setPeriod, setYearMonth, setFromYYYYMM, setToday, nextMonth, prevMonth, now]
  );

  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>;
}

/** Hook */
export function usePeriod() {
  const ctx = useContext(PeriodContext);
  if (!ctx) {
    throw new Error("usePeriod must be used within a PeriodProvider");
  }
  return ctx;
}

/**
 * Optional: simple listener for components that aren't React-aware.
 * Example:
 *   useEffect(() => {
 *     function onChange(e) { ... }
 *     window.addEventListener("period:changed", onChange);
 *     return () => window.removeEventListener("period:changed", onChange);
 *   }, []);
 */
