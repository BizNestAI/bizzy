import React from "react";
import dayjs from "dayjs";

export default function WeekDateHeader({ days, badgeMonth, badgeDay, textMain, textMuted }) {
  return (
    <div
      className="sticky top-0 z-20 overflow-hidden rounded-2xl border"
      style={{
        color: textMuted,
        background: "linear-gradient(180deg, #0f141b 0%, #0b1119 100%)",
        borderColor: "rgba(255,255,255,0.06)",
      }}
    >
      <div
        className="grid grid-cols-[80px_repeat(7,minmax(0,1fr))] gap-2 px-2 text-xs uppercase tracking-[0.2em]"
        style={{ padding: "12px 0" }}
      >
        <div className="flex items-center justify-center">
          <div
            className="w-14 h-14 rounded-xl flex flex-col items-center justify-center text-center"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)", color: textMain }}
          >
            <span className="text-[10px] uppercase tracking-wide" style={{ color: textMuted }}>
              {badgeMonth}
            </span>
            <span className="text-lg font-semibold leading-none">{badgeDay}</span>
          </div>
        </div>
        {days.map((day) => {
          const isToday = day.isSame(dayjs(), "day");
          return (
            <div key={day.toString()} className="px-2 text-center flex flex-col items-center justify-center gap-0.5">
              <div className="text-[11px]" style={{ color: isToday ? textMain : textMuted, fontWeight: isToday ? 600 : 400 }}>
                {day.format("ddd")}
              </div>
              <div className="text-lg font-semibold leading-[1.15]" style={{ color: isToday ? textMain : textMuted }}>
                {day.date()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
