// src/hooks/useFinancialPeriod.js
import { useCallback, useEffect, useMemo } from "react";
import { usePeriod } from "../context/PeriodContext.jsx";
import { safeFetch } from "../utils/safeFetch.js";
import { lastFullMonthParts } from "../utils/monthKey.js";

const STORAGE_PREFIX = "bizzy.financialPeriod";

function storageKey(businessId) {
  return `${STORAGE_PREFIX}.${businessId || "default"}`;
}

function parseMonth(text) {
  if (!text || typeof text !== "string") return null;
  const parts = text.split("-");
  if (parts.length < 2) return null;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  return { year, month };
}

export function useFinancialPeriod(businessId) {
  const { period, setYearMonth } = usePeriod();

  const persist = useCallback(
    (y, m) => {
      try {
        localStorage.setItem(storageKey(businessId), JSON.stringify({ year: y, month: m }));
      } catch {
        /* ignore */
      }
    },
    [businessId]
  );

  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (!businessId) return;
      const now = new Date();
      const current = { year: now.getFullYear(), month: now.getMonth() + 1 };
      const key = storageKey(businessId);
      const stored = (() => {
        try {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      })();
      if (stored?.year && stored?.month) {
        setYearMonth(stored.year, stored.month);
      } else {
        setYearMonth(current.year, current.month);
      }
      try {
        const res = await safeFetch(`/api/accounting/health/latest-month?business_id=${encodeURIComponent(businessId)}`);
        const parsed = parseMonth(res?.month);
        if (!cancelled && parsed) {
          const isCurrent = parsed.year === current.year && parsed.month === current.month;
          if (!isCurrent) {
            setYearMonth(parsed.year, parsed.month);
            persist(parsed.year, parsed.month);
            return;
          }
        }
      } catch {
        /* fall through */
      }
      const fallback = lastFullMonthParts();
      if (!stored?.year || !stored?.month) {
        setYearMonth(fallback.year, fallback.month);
        persist(fallback.year, fallback.month);
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [businessId, setYearMonth, persist]);

  const wrappedSetYearMonth = useCallback(
    (y, m) => {
      setYearMonth(y, m);
      if (businessId) persist(y, m);
    },
    [businessId, persist, setYearMonth]
  );

  const resetToCurrent = useCallback(() => {
    const d = new Date();
    wrappedSetYearMonth(d.getFullYear(), d.getMonth() + 1);
  }, [wrappedSetYearMonth]);

  return useMemo(
    () => ({
      year: period?.year,
      month: period?.month,
      setYearMonth: wrappedSetYearMonth,
      resetToCurrentMonth: resetToCurrent,
    }),
    [period?.year, period?.month, wrappedSetYearMonth, resetToCurrent]
  );
}

export default useFinancialPeriod;
