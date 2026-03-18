// /src/components/Tax/DeductionsMatrix.jsx
import React, { useEffect, useMemo, useRef, useCallback, useState } from "react";
import AskBizzyInsightButton from "../../components/Bizzy/AskBizzyInsightButton";

/**
 * Props:
 * - months: ["2025-01", ... "2025-12"]
 * - currentMonth: "2025-09"
 * - grid: [{ category, monthly: { "2025-01": 1200, ...}, ytdTotal }]
 * - totals: { monthly: { "2025-01": 5200, ... }, ytdTotal }
 * - onExport: () => void
 * - onAdd?: () => void
 * - onAskBizzy?: (text: string, payload?: any) => void
 * - onRowClick?: (row) => void
 * - showTotals?: boolean
 * - hideHeader?: boolean
 */
export default function DeductionsMatrix({
  months = [],
  currentMonth,
  grid = [],
  totals,
  onExport,
  onAdd,
  onAskBizzy,
  onRowClick,
  showTotals = true,
  title = "Deductions",
  subtitle = "Review your categorized business deductions to ensure all expenses are accurately accounted for.",
  hideHeader = false,
}) {
  const monthLabels = useMemo(() => months.map(m => shortMonth(m)), [months]);
const STICKY_WIDTH = 180; // width of category column we want always visible
  const MONTH_COL_WIDTH = 130;
  const YTD_WIDTH = 150;
  const columnTemplate = useMemo(
    () => `minmax(${STICKY_WIDTH}px, ${STICKY_WIDTH}px) repeat(${months?.length || 12}, minmax(120px,0.65fr)) minmax(140px,0.7fr)`,
    [months?.length]
  );
  const computedMinWidth = useMemo(() => {
    const count = months?.length || 12;
    return STICKY_WIDTH + count * MONTH_COL_WIDTH + YTD_WIDTH + 24; // small buffer
  }, [months?.length]);
  const [isOverflowing, setIsOverflowing] = useState(false);

  // Refs for auto-centering current month
  const scrollRef = useRef(null);
  const monthRefs = useRef({});

  const scrollToHighlightedMonth = useCallback((behavior = "smooth") => {
    if (!scrollRef.current || !currentMonth || !monthRefs.current[currentMonth]) return;
    const scroller = scrollRef.current;
    const cell = monthRefs.current[currentMonth];
    const cellOffset = cell.offsetLeft;
    const cellWidth = cell.offsetWidth;
    const visibleWidth = Math.max(24, scroller.clientWidth - STICKY_WIDTH);
    const rawTarget = cellOffset - Math.max(0, visibleWidth / 2 - cellWidth / 2);
    const clampedTarget = Math.max(0, Math.min(rawTarget, scroller.scrollWidth - scroller.clientWidth));
    scroller.scrollTo({ left: clampedTarget, behavior });
  }, [currentMonth]);

  useEffect(() => {
    if (!currentMonth) {
      scrollRef.current?.scrollTo({ left: 0, behavior: "auto" });
      return;
    }
    scrollToHighlightedMonth("auto");
    const id = requestAnimationFrame(() => scrollToHighlightedMonth("auto"));
    return () => cancelAnimationFrame(id);
  }, [scrollToHighlightedMonth, months.length, currentMonth]);

  useEffect(() => {
    let t;
    function onResize() {
      clearTimeout(t);
      t = setTimeout(() => {
        scrollToHighlightedMonth("auto");
        if (scrollRef.current) {
          setIsOverflowing(scrollRef.current.scrollWidth > scrollRef.current.clientWidth + 4);
        }
      }, 120);
    }
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(t);
    };
  }, [scrollToHighlightedMonth, months.length]);

  useEffect(() => {
    if (scrollRef.current) {
      setIsOverflowing(scrollRef.current.scrollWidth > scrollRef.current.clientWidth + 4);
    }
  }, [grid, months]);

  return (
    <div
      className="rounded-[32px] p-2 md:p-3"
      style={{
        background: "linear-gradient(180deg, rgba(12,12,14,0.92), rgba(14,14,16,0.94))",
        border: "1px solid rgba(191,191,191,0.16)",
        boxShadow: "0 32px 80px rgba(0,0,0,0.55)",
      }}
    >
      {!hideHeader && (
        <>
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-2 text-sm text-[rgba(var(--accent-rgb),0.85)]">{subtitle}</p>
        </>
      )}

      <div
        className="mt-4 rounded-[32px] border overflow-hidden"
        style={{ borderColor: "rgba(191,191,191,0.16)", background: "rgba(10,10,12,0.96)" }}
      >
        <div
          ref={scrollRef}
          className="
            relative w-full overflow-x-auto overscroll-x-contain
            [scrollbar-width:none]
            [&::-webkit-scrollbar]:hidden
          "
        >
          {isOverflowing && (
            <div className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-[rgba(10,10,12,0.95)] via-[rgba(10,10,12,0.7)] to-transparent" />
          )}
          {/* Slightly wider min-width to accommodate YTD column */}
          <div
            className="w-full text-white/90"
            style={{ "--sticky-bg": "var(--panel)", minWidth: computedMinWidth }}
          >
            {/* Header row with sticky Category & YTD at end */}
            <div
              className="grid gap-x-1 md:gap-x-2 items-center px-3 py-0.5 text-[12px] md:text-xs text-white/70 border-b border-white/10 sticky top-0 z-20"
              style={{ background: "rgba(10,10,12,0.98)", gridTemplateColumns: columnTemplate }}
            >
              <div
                className="font-medium sticky left-0 z-30 pr-2 py-1 text-center"
                style={{
                  background: "rgba(10,10,12,0.96)",
                  borderRight: "1px solid rgba(255,255,255,0.08)",
                  boxShadow: "8px 0 24px rgba(0,0,0,0.28)",
                  width: STICKY_WIDTH,
                  minWidth: STICKY_WIDTH,
                  maxWidth: STICKY_WIDTH,
                }}
              >
                Category
              </div>
              {monthLabels.map((ml, i) => {
                const iso = months[i];
                const isNow = currentMonth && iso === currentMonth;
                return (
                  <div
                    key={iso}
                    ref={el => (monthRefs.current[iso] = el || monthRefs.current[iso])}
                    className={`text-center rounded-md px-1 py-0.5 ${isNow ? "text-[rgba(var(--accent-rgb),0.95)] bg-[rgba(var(--accent-rgb),0.08)]" : ""}`}
                    title={iso}
                  >
                    {ml}
                  </div>
                );
              })}
              <div className="text-center font-medium">YTD</div>
            </div>

            {/* Body rows */}
            <div className="divide-y divide-white/5">
              {grid.map((row, ri) => {
                return (
                  <div
                    key={row.category + ri}
                    className="group relative grid gap-x-1 md:gap-x-2 items-center px-3 py-1 transition-colors hover:bg-white/[0.02] hover:border-white/10 border border-transparent cursor-pointer"
                    style={{ gridTemplateColumns: columnTemplate }}
                    onClick={() => onRowClick?.(row)}
                  >
                  {/* Sticky first column; fully opaque so no bleed-through */}
                  <div
                    className="sticky left-0 z-30 pr-2 flex min-h-[72px] flex-col items-center justify-center text-center border-r border-white/10 relative py-1"
                    style={{
                      background: "rgba(10,10,12,0.96)",
                      boxShadow: "8px 0 24px rgba(0,0,0,0.28)",
                      width: STICKY_WIDTH,
                      minWidth: STICKY_WIDTH,
                      maxWidth: STICKY_WIDTH,
                    }}
                  >
                    <span className="text-sm font-medium truncate"><span className="inline-block align-middle">{row.category}</span></span>
                  </div>

                  {/* Monthly amounts */}
                  {months.map((iso) => {
                    const isNow = currentMonth && iso === currentMonth;
                    return (
                      <div
                        key={iso}
                        className={`text-right font-mono tabular-nums whitespace-nowrap text-[12px] md:text-sm rounded-sm px-1 py-0.5 ${isNow ? "text-[rgba(var(--accent-rgb),0.95)] bg-[rgba(var(--accent-rgb),0.06)]" : "text-white/85"}`}
                      >
                        {fmtUSD(row.monthly?.[iso])}
                      </div>
                    );
                  })}

                  {/* YTD total per category */}
                  <div className="text-right font-mono tabular-nums whitespace-nowrap text-[12px] md:text-sm text-white/80">
                    {fmtUSD(row.ytdTotal)}
                  </div>
                  </div>
                );
              })}
            </div>

            {/* Totals row */}
            {showTotals ? (
              <div
                className="grid gap-x-1 md:gap-x-2 items-center px-3 py-1 border-t border-white/10 mt-1"
                style={{ gridTemplateColumns: columnTemplate }}
              >
                <div
                  className="text-sm font-medium sticky left-0 z-30 pr-2 flex min-h-[72px] items-center justify-center text-center"
                  style={{
                    background: "var(--panel)",
                    borderRight: "1px solid rgba(255,255,255,0.08)",
                    width: STICKY_WIDTH,
                    minWidth: STICKY_WIDTH,
                    maxWidth: STICKY_WIDTH,
                  }}
                >
                  TOTAL
                </div>
                {months.map((iso) => {
                  const isNow = currentMonth && iso === currentMonth;
                  return (
                    <div
                      key={iso}
                      className={`text-right font-mono tabular-nums whitespace-nowrap text-[12px] md:text-sm rounded-sm px-1 py-0.5 ${isNow ? "text-[rgba(var(--accent-rgb),0.95)] bg-[rgba(var(--accent-rgb),0.06)]" : "text-white/85"}`}
                    >
                      {fmtUSD(totals?.monthly?.[iso])}
                    </div>
                  );
                })}
                <div className="text-right font-mono tabular-nums whitespace-nowrap text-[12px] md:text-sm text-white/85">
                  {fmtUSD(totals?.ytdTotal)}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* (optional) footer area retained for future actions */}
        <div className="flex items-center justify-between mt-3 px-3 pb-3" />
      </div>
    </div>
  );
}

/* -------------- helpers -------------- */

function fmtUSD(n) {
  const v = Math.round(typeof n === "number" ? n : Number(n || 0));
  return isFinite(v)
    ? v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    : "—";
}
function shortMonth(iso) {
  const m = Number(String(iso).slice(5, 7));
  return ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][m - 1] || "";
}
