// /src/pages/calendar/AgendaWidget.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import classNames from "classnames";
import { RefreshCw, ArrowRight } from "lucide-react";
import { apiUrl, safeFetch } from "../../utils/safeFetch";
import { supabase } from "../../services/supabaseClient";

const CHROME_HEX  = "#BFBFBF";
const MOCK_ITEMS = [
  { title: "Kitchen walkthrough",           offsetDays: 1,  hour: 9,   minute: 30, durationMin: 45 },
  { title: "Payroll submission",            offsetDays: 2,  hour: 11,  minute: 0,  durationMin: 45 },
  { title: "Tile delivery follow-ups",      offsetDays: 3,  hour: 14,  minute: 0,  durationMin: 30 },
  { title: "AR follow-ups",                 offsetDays: 4,  hour: 10,  minute: 0,  durationMin: 40 },
  { title: "Marketing review",              offsetDays: 5,  hour: 15,  minute: 0,  durationMin: 60 },
  { title: "Crew standup",                  offsetDays: 0,  hour: 8,   minute: 30, durationMin: 30, all_day: false },
  { title: "Tax prep consult",              offsetDays: 6,  hour: 13,  minute: 0,  durationMin: 45 },
];

function hexToRgba(hex, a = 1) {
  let c = hex?.replace("#", "") || "94a3b8";
  if (c.length === 3) c = c.split("").map(s => s + s).join("");
  const n = parseInt(c, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = (n & 255);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function buildMockAgenda() {
  const now = dayjs();
  return MOCK_ITEMS.map((item, idx) => {
    const start = now
      .startOf("day")
      .add(item.offsetDays || 0, "day")
      .add(item.hour || 0, "hour")
      .add(item.minute || 0, "minute");
    const end = start.add(item.durationMin || 45, "minute");
    return {
      id: `mock-agenda-${idx}`,
      module: "ops",
      type: "task",
      title: item.title,
      when: {
        start: start.toISOString(),
        end: end.toISOString(),
        all_day: !!item.all_day,
      },
    };
  });
}

/** Build headers with Supabase session + ids */
async function authedHeaders({ businessId, userId }) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token || "";
  return {
    "Content-Type": "application/json",
    "x-business-id":
      businessId ||
      localStorage.getItem("business_id") ||
      localStorage.getItem("currentBusinessId") ||
      "",
    "x-user-id": userId || localStorage.getItem("user_id") || "",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function formatWhen(when) {
  if (when.all_day) return `${dayjs(when.start).format("ddd, MMM D")} · All day`;
  const s = dayjs(when.start), e = dayjs(when.end);
  const sameDay = s.isSame(e, "day");
  return sameDay
    ? `${s.format("ddd, MMM D")} · ${s.format("h:mm a")} – ${e.format("h:mm a")}`
    : `${s.format("MMM D, h:mm a")} → ${e.format("MMM D, h:mm a")}`;
}

function Skeleton({ border }) {
  return (
    <div className="animate-pulse space-y-2">
      {[...Array(4)].map((_, i) => (
        <div
          key={i}
          className="h-12 rounded-lg"
          style={{
            backgroundColor: "rgba(17, 24, 39, 0.55)",
            border: `1px solid ${border}`,
          }}
        />
      ))}
    </div>
  );
}

function Section({ title, list, itemBorder, hoverBg, condensed }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide mb-1 text-white/65">{title}</div>
      {!list?.length ? (
        <div className="text-sm text-white/60">Nothing scheduled.</div>
      ) : (
        <ul className="space-y-1.5">
          {list.map((i) => (
            <li
              key={i.id}
              className="flex items-start justify-between rounded-lg"
              style={{
                backgroundColor: "rgba(17, 24, 39, 0.55)",
                border: `1px solid ${itemBorder}`,
                padding: condensed ? '8px' : '12px',
              }}
            >
              <div className="flex flex-col">
                <div className="text-sm text-white font-medium leading-tight">{i.title}</div>
                <div className="text-[10px] text-white/60 leading-tight">
                  {formatWhen(i.when)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Compact right-rail agenda widget (Today + Next items)
 *  ✅ Persistent & memoized:
 *    - refetch ONLY when *businessId* changes (or on optional autoRefreshMs)
 *    - module is only forwarded to the API filter (styling stays neutral chrome)
 *    - header text is always “Upcoming Agenda” (no module suffix)
 */
function AgendaWidget({
  businessId,
  module = "pulse",
  onOpenCalendar,
  className = "",
  autoRefreshMs,
  eventsOverride,
  onRefresh,
}) {
  const [data, setData] = useState({ today: [], next: [] });
  const [loading, setLoading] = useState(false);   // true only for first load of a *business*
  const [err, setErr] = useState("");

  const lastBizRef = useRef(null);
  const mountedRef = useRef(false);

  const dateISO   = useMemo(() => new Date().toISOString(), []);
  const styles = useMemo(() => {
    const borderColor = CHROME_HEX; // default ChatHome chrome
    return {
      cardBorder: hexToRgba(borderColor, 0.24),
      itemBorder: hexToRgba(borderColor, 0.18),
      hoverBg:    hexToRgba(borderColor, 0.08),
      cardGlow:   'none',
    };
  }, []);

  const effectiveBizId =
    businessId ||
    localStorage.getItem("business_id") ||
    localStorage.getItem("currentBusinessId") ||
    "";

  const buildFromEvents = useCallback((list = []) => {
    const now = dayjs();
    const earliest = (list || [])
      .filter((evt) => evt && evt.start_ts)
      .map((evt) => dayjs(evt.start_ts))
      .sort((a, b) => a.valueOf() - b.valueOf())[0];
    const windowStart = earliest && earliest.isAfter(now) ? earliest : now;
    const horizon = windowStart.add(7, "day").endOf("day");
    const normalized = (list || [])
      .filter((evt) => evt && (evt.start_ts || evt.when?.start) && (evt.end_ts || evt.when?.end))
      .map((evt) => {
        const start = evt.start_ts || evt.when?.start;
        const end = evt.end_ts || evt.when?.end;
        return {
          id: evt.id || evt.title,
          module: evt.module,
          type: evt.type,
          title: evt.title || "(untitled)",
          when: {
            start,
            end,
            all_day: !!evt.all_day,
          },
        };
      })
      .filter((evt) => dayjs(evt.when.end).isAfter(windowStart) && dayjs(evt.when.start).isBefore(horizon))
      .sort((a, b) => new Date(a.when.start) - new Date(b.when.start));
    const today = normalized.filter((evt) => dayjs(evt.when.start).isSame(windowStart, "day"));
    const next = normalized.filter((evt) => dayjs(evt.when.start).isAfter(windowStart, "day"));
    return { today, next };
  }, []);

  // Main loader — runs only when *businessId* changes
  const load = async (withSpinner = false) => {
    if (withSpinner && !Array.isArray(eventsOverride)) setLoading(true);
    if (Array.isArray(eventsOverride)) {
      setErr("");
      setData(buildFromEvents(eventsOverride));
      lastBizRef.current = effectiveBizId;
      if (withSpinner) setLoading(false);
      return;
    }

    if (!effectiveBizId) {
      setErr("Could not load agenda.");
      setData(buildFromEvents(buildMockAgenda()));
      if (withSpinner) setLoading(false);
      return;
    }
    setErr("");

    const isNewBusiness = lastBizRef.current !== effectiveBizId;
    if (isNewBusiness) setLoading(true);

    try {
      const url = new URL(apiUrl("/api/calendar/agenda"));
      url.searchParams.set("business_id", effectiveBizId);
      // module is supported by backend but should not toggle loading
      if (module) url.searchParams.set("module", module);
      url.searchParams.set("date", dateISO);

      const headers = await authedHeaders({
        businessId: effectiveBizId,
        userId: localStorage.getItem("user_id"),
      });

      const json = await safeFetch(url.toString(), { headers, cache: "no-store" });
      if (!mountedRef.current) return;
      const payload = Array.isArray(json) ? json : json?.events || json;
      const finalEvents =
        Array.isArray(payload) && payload.length ? payload : buildMockAgenda();
      setData(buildFromEvents(finalEvents));
      lastBizRef.current = effectiveBizId;
    } catch (e) {
      if (!mountedRef.current) return;
      console.error("[AgendaWidget] load failed", e);
      setErr("Could not load agenda.");
      setData(buildFromEvents(buildMockAgenda()));
    } finally {
      if (isNewBusiness && mountedRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => { mountedRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveBizId]); // ← business changes trigger reload

  useEffect(() => {
    if (!mountedRef.current) return;
    if (!Array.isArray(eventsOverride)) return;
    setErr("");
    setLoading(false);
    setData(buildFromEvents(eventsOverride));
  }, [eventsOverride, buildFromEvents]);

  // Optional periodic refresh
  useEffect(() => {
    if (!autoRefreshMs) return;
    const id = setInterval(load, autoRefreshMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveBizId, autoRefreshMs]);

  const displayData = useMemo(() => {
    if (Array.isArray(eventsOverride)) {
      return buildFromEvents(eventsOverride);
    }
    return data;
  }, [data, eventsOverride, buildFromEvents]);

  const condensed = useMemo(() => {
    return (
      !(Array.isArray(displayData.today) && displayData.today.length) &&
      !(Array.isArray(displayData.next) && displayData.next.length)
    );
  }, [displayData]);

  return (
    <div
      className={classNames(
        "rounded-xl p-4 bg-[#0E1218]/90 backdrop-blur-sm",
        className
      )}
      style={{
        border: `1px solid ${styles.cardBorder}`,
        boxShadow: styles.cardGlow || "none",
      }}
    >
      {/* Header — no module suffix */}
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold text-white/90">Upcoming Agenda</div>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              setErr("");
              try {
                setLoading(true);
                const latest = await onRefresh?.();
                const source = Array.isArray(latest) ? latest : eventsOverride;
                if (Array.isArray(source)) {
                  setData(buildFromEvents(source));
                  return;
                }
                await load(false);
              } catch (e) {
                console.error("[AgendaWidget] refresh failed", e);
                setErr("Could not refresh agenda.");
              } finally {
                setLoading(false);
              }
            }}
            title="Refresh"
            className="p-1.5 rounded hover:bg-white/5 text-slate-300"
          >
            <RefreshCw size={16} />
          </button>
          {onOpenCalendar && (
            <button
              onClick={onOpenCalendar}
              className="text-xs flex items-center gap-1 text-slate-300 hover:text-white"
            >
              View Calendar <ArrowRight size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <Skeleton border={styles.itemBorder} />
      ) : err ? (
        <div className="text-sm text-red-300">{err}</div>
      ) : (
        <>
          <Section
            title="Today"
            list={displayData.today}
            itemBorder={styles.itemBorder}
            hoverBg={styles.hoverBg}
            condensed={condensed}
          />
          <div className="h-3" />
          <Section
            title="Next 7 days"
            list={displayData.next}
            itemBorder={styles.itemBorder}
            hoverBg={styles.hoverBg}
            condensed={condensed}
          />
        </>
      )}
    </div>
  );
}

/** Export a memoized widget so incidental parent re-renders
 *  (like rail expand/collapse or page transitions) don’t refetch or re-animate.
 */
export default React.memo(AgendaWidget, (prev, next) => {
  return (
    prev.businessId    === next.businessId &&
    prev.module        === next.module &&
    prev.className     === next.className &&
    prev.autoRefreshMs === next.autoRefreshMs &&
    prev.onOpenCalendar === next.onOpenCalendar &&
    prev.eventsOverride === next.eventsOverride
  );
});
