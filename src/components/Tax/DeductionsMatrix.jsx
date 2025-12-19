// /src/components/Tax/DeductionsMatrix.jsx
import React, { useEffect, useMemo, useRef, useCallback } from "react";
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
  title = "Deductions",
  subtitle = "Review your categorized business deductions to ensure all expenses are accurately accounted for.",
  hideHeader = false,
}) {
  const monthLabels = useMemo(() => months.map(m => shortMonth(m)), [months]);
const STICKY_WIDTH = 180; // width of category column we want always visible

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
    scrollToHighlightedMonth();
  }, [scrollToHighlightedMonth, months.length]);

  useEffect(() => {
    let t;
    function onResize() {
      clearTimeout(t);
      t = setTimeout(() => {
        scrollToHighlightedMonth("auto");
      }, 120);
    }
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(t);
    };
  }, [scrollToHighlightedMonth, months.length]);

  return (
    <div
      className="rounded-[32px] p-2 md:p-3"
      style={{
        background: "var(--panel)",
        border: "1px solid rgba(191,191,191,0.16)",
        boxShadow: "0 32px 80px rgba(0,0,0,0.55)",
      }}
    >
      {!hideHeader && (
        <>
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-2 text-sm text-yellow-200/80">{subtitle}</p>
        </>
      )}

      <div
        className="mt-4 rounded-[32px] border overflow-hidden"
        style={{ borderColor: "rgba(191,191,191,0.16)", background: "var(--panel)" }}
      >
        <div
          ref={scrollRef}
          className="
            relative w-full overflow-x-auto overscroll-x-contain
            [scrollbar-width:none]
            [&::-webkit-scrollbar]:hidden
          "
        >
          {/* Slightly wider min-width to accommodate YTD column */}
          <div className="w-full min-w-[1100px] md:min-w-[1300px] text-white/90" style={{ "--sticky-bg": "var(--panel)", minWidth: '100%' }}>
            {/* Header row with sticky Category & YTD at end */}
            <div className="grid grid-cols-[minmax(165px,0.65fr)_repeat(12,minmax(120px,0.65fr))_minmax(140px,0.7fr)] gap-x-1 md:gap-x-2 items-center px-3 py-0.5 text-[12px] md:text-xs text-white/70 border-b border-white/10">
              <div
                className="font-medium sticky left-0 z-30 pr-2 py-1 text-center"
                style={{ background: "var(--panel)", borderRight: "1px solid rgba(255,255,255,0.08)" }}
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
                    className={`text-center ${isNow ? "text-yellow-200" : ""}`}
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
              {grid.map((row, ri) => (
                <div
                  key={row.category + ri}
                  className="group grid grid-cols-[minmax(165px,0.65fr)_repeat(12,minmax(120px,0.65fr))_minmax(140px,0.7fr)] gap-x-1 md:gap-x-2 items-center px-3 py-0.5"
                >
                  {/* Sticky first column with Ask Bizzy; fully opaque so no bleed-through */}
                  <div
                    className="sticky left-0 z-30 pr-2 flex min-h-[72px] flex-col items-center justify-center text-center border-r border-white/10 relative py-1"
                    style={{ background: "rgba(16,18,22,0.98)" }}
                  >
                    <span className="text-sm font-medium truncate"><span className="inline-block align-middle">{row.category}</span></span>
                    <AskBizzyInsightButton
                      variant="inline"
                      size="xs"
                      label="Ask Bizzi"
                      showIcon={false}
                      labelAlwaysVisible
                      className="absolute bottom-1 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition hidden sm:inline-flex"
                      message={`Explain how ${row.category} expenses can potentially reduce my tax bill.`}
                      context={{ category: row.category }}
                      onAskExternal={(text, payload) => onAskBizzy?.(text, payload)}
                    />
                  </div>

                  {/* Monthly amounts */}
                  {months.map((iso) => {
                    const isNow = currentMonth && iso === currentMonth;
                    return (
                      <div
                        key={iso}
                        className={`text-right font-mono tabular-nums whitespace-nowrap text-[12px] md:text-sm ${isNow ? "text-yellow-200" : "text-yellow-100/90"}`}
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
              ))}
            </div>

            {/* Totals row */}
            <div className="grid grid-cols-[minmax(165px,0.65fr)_repeat(12,minmax(120px,0.65fr))_minmax(140px,0.7fr)] gap-x-1 md:gap-x-2 items-center px-3 py-1 border-t border-white/10 mt-1">
              <div
                className="text-sm font-medium sticky left-0 z-30 pr-2 flex min-h-[72px] items-center justify-center text-center"
                style={{ background: "var(--panel)", borderRight: "1px solid rgba(255,255,255,0.08)" }}
              >
                TOTAL
              </div>
              {months.map((iso) => {
                const isNow = currentMonth && iso === currentMonth;
                return (
                  <div
                    key={iso}
                    className={`text-right font-mono tabular-nums whitespace-nowrap text-[12px] md:text-sm ${isNow ? "text-yellow-200" : "text-yellow-100/90"}`}
                  >
                    {fmtUSD(totals?.monthly?.[iso])}
                  </div>
                );
              })}
              <div className="text-right font-mono tabular-nums whitespace-nowrap text-[12px] md:text-sm text-yellow-100/90">
                {fmtUSD(totals?.ytdTotal)}
              </div>
            </div>
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
