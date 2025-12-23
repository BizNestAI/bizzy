// CalendarHub.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import classNames from "classnames";
import EventModal from "./EventModal";
import CalendarQuickOpen from "./CalendarQuickOpen";
import { useRightExtras } from "../../insights/RightExtrasContext";
import AgendaWidget from "../Calendar/AgendaWidget.jsx";
import { useNavigate } from "react-router-dom";
import useDemoMode from "../../hooks/useDemoMode";
import { useBusiness } from "../../context/BusinessContext";
import WeekDateHeader from "./WeekDateHeader";

/* ───────── API adapter (unchanged) ───────── */
const CLIENT_MOCK_CAL = import.meta.env?.VITE_MOCK_CALENDAR === "true";

const API = {
  async listEvents({ business_id, fromISO, toISO, module = "all" }) {
    if (!business_id && !CLIENT_MOCK_CAL) return [];
    const q = new URLSearchParams({
      business_id: business_id || "mock-biz",
      from: fromISO,
      to: toISO,
      module,
    });
    const r = await fetch(`/api/calendar/events?${q.toString()}`);
    if (!r.ok) throw new Error("Failed to fetch events");
    const { data } = await r.json();
    return data || [];
  },
  async createEvent(draft) {
    const r = await fetch(`/api/calendar/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft }),
    });
    if (!r.ok) throw new Error("Failed to create event");
    return r.json();
  },
  async updateEvent(id, patch) {
    const r = await fetch(`/api/calendar/events/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch }),
    });
    if (!r.ok) throw new Error("Failed to update event");
    return r.json();
  },
  async deleteEvent(id) {
    const r = await fetch(`/api/calendar/events/${id}`, { method: "DELETE" });
    if (!r.ok) throw new Error("Failed to delete event");
    return r.json();
  },
};

/* ───────── Graphite tokens / accents (neutralized) ───────── */
const NEUTRAL_BORDER = "rgba(165,167,169,0.18)";
const NEUTRAL_BORDER_SOFT = "rgba(165,167,169,0.12)";
const PANEL_BG = "var(--panel)";
const TEXT_MAIN = "var(--text)";
const TEXT_MUTED = "var(--text-2)";

/* event chip colors by module (kept) */
const MODULE_COLORS = {
  financials: "#22d16b",
  tax: "#ffc73d",
  marketing: "#5aa5ff",
  investments: "#b889ff",
  ops: "#8aa5b8",
};

const VIEW_TABS = ["month", "week", "agenda"];
const VIEW_LABEL = (key) => `${key.charAt(0).toUpperCase()}${key.slice(1)} View`;

const CLIENT_BLUEPRINTS = [
  { title: "Crew standup", module: "ops", type: "job", dayOfWeek: 1, hour: 9, durationHours: 1 },
  { title: "Weekly finance sync", module: "financials", type: "meeting", dayOfWeek: 2, hour: 10, durationHours: 1 },
  { title: "Kitchen walkthrough", module: "ops", type: "job", dayOfWeek: 3, hour: 9, durationHours: 2, location: "Active job site" },
  { title: "AR follow-ups", module: "financials", type: "task", dayOfWeek: 4, hour: 11, durationHours: 1 },
  { title: "Tile delivery follow up", module: "ops", type: "job", dayOfWeek: 5, hour: 9, durationHours: 1.5 },
  { title: "Payroll submission", module: "financials", type: "deadline", dayOfWeek: 5, hour: 0, durationHours: 8, allDay: true },
  { title: "Marketing review", module: "marketing", type: "meeting", dayOfWeek: 4, hour: 15, durationHours: 1 },
  { title: "Tax prep consult", module: "tax", type: "deadline", dayOfWeek: 2, hour: 13, durationHours: 1 },
  { title: "Content shoot", module: "marketing", type: "post", dayOfWeek: 1, hour: 14, durationHours: 2, repeatDays: 14 },
];

function clientSeededRandom(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(Math.sin(hash)) % 1;
}

function clientBaseJitter(base, blueprint) {
  const dayRoll = clientSeededRandom(`${base}-day-${blueprint.title}`);
  const hourRoll = clientSeededRandom(`${base}-hour-${blueprint.title}`);
  return {
    dayOffset: Math.round(dayRoll * 4) - 2,
    hourOffset: Math.round(hourRoll * 4) - 2,
  };
}

function clientOccurrenceVariation(base, blueprint, occurrenceIndex) {
  const skipRoll = clientSeededRandom(`${base}-skip-${blueprint.title}-${occurrenceIndex}`);
  const minuteRoll = clientSeededRandom(`${base}-minute-${blueprint.title}-${occurrenceIndex}`);
  return {
    skip: skipRoll > 0.82,
    minuteOffset: Math.round((minuteRoll - 0.5) * 120),
  };
}

function makeClientMockEvent(start, businessId, spec) {
  const eventStart = start.clone();
  const duration = spec.durationHours ?? spec.hours ?? 1;
  const end = eventStart.clone().add(duration, "hour");
  return {
    id: `mock-${spec.module}-${spec.type}-${eventStart.valueOf()}`,
    business_id: businessId,
    module: spec.module,
    type: spec.type,
    title: spec.title,
    description: spec.allDay ? `${spec.title} (all day)` : `${spec.title} (${eventStart.format("h:mm A")})`,
    start_ts: eventStart.toISOString(),
    end_ts: spec.allDay ? eventStart.endOf("day").toISOString() : end.toISOString(),
    all_day: !!spec.allDay,
    location: spec.location || null,
    source: "mock",
    status: "scheduled",
    links: null,
  };
}

function generateClientMockEvents({ fromISO, toISO, businessId, module = "all" }) {
  const start = dayjs(fromISO || Date.now()).startOf("day");
  const end = toISO ? dayjs(toISO).endOf("day") : start.clone().add(30, "day");
  const monthKey = start.add(3, "day").format("YYYY-MM");
  const events = [];

  for (const spec of CLIENT_BLUEPRINTS) {
    if (module !== "all" && spec.module !== module) continue;
    const { dayOffset, hourOffset } = clientBaseJitter(monthKey, spec);
    const anchorWeek = start.clone().startOf("week");
    const baseDay = spec.dayOfWeek ?? spec.weekday ?? 1;
    const normalizedDay = ((baseDay + dayOffset) % 7 + 7) % 7;
    let cursor = anchorWeek.clone().add(normalizedDay, "day");
    if (cursor.isBefore(start)) cursor = cursor.add(7, "day");
    const hour = spec.allDay ? 0 : Math.min(20, Math.max(6, (spec.hour ?? 9) + hourOffset));
    cursor = cursor.hour(hour).minute(0);

    let occurrence = 0;
    const repeat = spec.repeatDays || spec.repeat || 7;
    while (cursor.isBefore(end)) {
      const variation = clientOccurrenceVariation(monthKey, spec, occurrence + 1);
      const shifted = spec.allDay ? cursor : cursor.add(variation.minuteOffset, "minute");
      if (!variation.skip) events.push(makeClientMockEvent(shifted, businessId, spec));
      cursor = cursor.add(repeat, "day");
      occurrence += 1;
    }
  }

  return events.sort((a, b) => new Date(a.start_ts) - new Date(b.start_ts));
}

/** Mini Month navigator cell formatter */
function useMonthGrid(current) {
  const start = current.startOf("month");
  const end = current.endOf("month");
  const startIdx = start.day(); // 0-6
  const totalDays = end.date();

  const grid = [];
  for (let i = 0; i < startIdx; i++) grid.push(null);
  for (let d = 1; d <= totalDays; d++) grid.push(dayjs(start).date(d));
  return grid;
}

/**
 * CalendarHub
 * - Full calendar tab
 * - Month/Week/Agenda views
 * - Filters per module/type
 * - Left mini-month + filter rail, main grid on right
 */
export default function CalendarHub({ businessId, defaultModule = "all" }) {
  const [view, setView] = useState("week");
  const [current, setCurrent] = useState(dayjs());
  const [moduleFilter, setModuleFilter] = useState(defaultModule); // 'all' | module key
  const [typeFilter, setTypeFilter] = useState("all"); // 'all' | 'job' | 'invoice' ...
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [moduleMenuOpen, setModuleMenuOpen] = useState(false);
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [mockOverrides, setMockOverrides] = useState({});
  const [mockCreated, setMockCreated] = useState([]); // locally created events (demo or fallback)
  const moduleMenuRef = useRef(null);
  const typeMenuRef = useRef(null);
  const viewMenuRef = useRef(null);

  // modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editEvent, setEditEvent] = useState(null);
  const [createDateISO, setCreateDateISO] = useState(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const navigate = useNavigate();
  const { setRightExtras } = useRightExtras();
  const { currentBusiness } = useBusiness();
  const currentBusinessId = currentBusiness?.id || null;
  const demoMode = useDemoMode();
  const usingDemo = demoMode === 'demo';
  const MOCK_OVERRIDES_KEY = "bizzy:calendar:mockOverrides";
  const MOCK_CREATED_KEY = "bizzy:calendar:mockCreated";
  const getActiveBusinessId = useCallback(
    (opts = {}) => {
      const allowMockFallback = opts.allowMockFallback ?? true;
      const localId =
        typeof window !== "undefined"
          ? window.localStorage?.getItem("currentBusinessId")
          : null;
      const resolved =
        businessId || currentBusinessId || localId || null;
      if (resolved) return resolved;
      if (allowMockFallback && usingDemo) return "mock-biz";
      return null;
    },
    [businessId, currentBusinessId, usingDemo]
  );
  const resolvedBusinessId = getActiveBusinessId();

  // Hydrate mock drag/drop overrides for demo mode so positions persist across refreshes.
  useEffect(() => {
    if (!usingDemo) return;
    try {
      const raw = localStorage.getItem(MOCK_OVERRIDES_KEY);
      if (raw) setMockOverrides(JSON.parse(raw));
    } catch {
      /* non-fatal */
    }
  }, [usingDemo]);

  // Persist overrides whenever they change (demo only).
  useEffect(() => {
    if (!usingDemo) return;
    try {
      localStorage.setItem(MOCK_OVERRIDES_KEY, JSON.stringify(mockOverrides || {}));
    } catch {
      /* non-fatal */
    }
  }, [mockOverrides, usingDemo]);

  // Mock-created events: hydrate and persist
  useEffect(() => {
    try {
      const raw = localStorage.getItem(MOCK_CREATED_KEY);
      if (raw) setMockCreated(JSON.parse(raw));
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(MOCK_CREATED_KEY, JSON.stringify(mockCreated || []));
    } catch {
      /* non-fatal */
    }
  }, [mockCreated]);

  // date ranges per view
  const range = useMemo(() => {
    if (view === "week") {
      const start = current.startOf("week");
      const end = current.endOf("week");
      return { from: start.toISOString(), to: end.toISOString() };
    }
    if (view === "agenda") {
      const start = current.startOf("day");
      const end = current.add(14, "day").endOf("day"); // 2-week agenda
      return { from: start.toISOString(), to: end.toISOString() };
    }
    // month
    const start = current.startOf("month").startOf("week");
    const end = current.endOf("month").endOf("week");
    return { from: start.toISOString(), to: end.toISOString() };
  }, [view, current]);

  const normalizeEvents = useCallback(
    (list) => {
      const baseList = usingDemo
        ? list || []
        : (list || []).filter(
            (evt) =>
              evt &&
              evt.source !== "mock" &&
              !String(evt.id || "").startsWith("mock-") &&
              evt.business_id !== "mock-biz"
          );
      const base = baseList.map((evt) => {
        const patch = mockOverrides?.[evt.id];
        return patch ? { ...evt, ...patch } : evt;
      });

      // Add locally-created mock events
      const extraMock = mockCreated || [];
      const merged = [...base, ...extraMock];
      const from = dayjs(range.from);
      const to = dayjs(range.to);
      return merged
        .filter((e) => dayjs(e.start_ts).isBefore(to) && dayjs(e.end_ts).isAfter(from))
        .sort((a, b) => new Date(a.start_ts) - new Date(b.start_ts));
    },
    [range.from, range.to, usingDemo, mockOverrides, mockCreated]
  );

  // fetch events
  const fetchEventsForRange = useCallback(
    async (targetBusinessId) => {
      let data = [];
      const realBusinessId =
        targetBusinessId || getActiveBusinessId({ allowMockFallback: false });

      if (realBusinessId) {
        data = await API.listEvents({
          business_id: realBusinessId,
          fromISO: range.from,
          toISO: range.to,
          module: moduleFilter,
        });
      }

      if ((!data || data.length === 0) && usingDemo) {
        const mockBiz = realBusinessId || "mock-biz";
        data = generateClientMockEvents({
          fromISO: range.from,
          toISO: range.to,
          businessId: mockBiz,
          module: moduleFilter,
        });
      }

      return normalizeEvents(data || []);
    },
    [usingDemo, moduleFilter, normalizeEvents, range.from, range.to, getActiveBusinessId]
  );

  useEffect(() => {
    let ignore = false;
    async function load(activeBiz) {
      try {
        setLoading(true);
        const ordered = await fetchEventsForRange(activeBiz);
        if (!ignore) setEvents(ordered);
      } catch (e) {
        console.error("[CalendarHub] events failed", e);
        if (!ignore) {
          if (usingDemo)
            setEvents(
              normalizeEvents(
                generateClientMockEvents({
                  fromISO: range.from,
                  toISO: range.to,
                  businessId: resolvedBusinessId,
                  module: moduleFilter,
                })
              )
            );
          else setEvents([]);
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    const activeBizId = getActiveBusinessId({ allowMockFallback: false });
    if (activeBizId || usingDemo) load(activeBizId);
    return () => (ignore = true);
  }, [usingDemo, fetchEventsForRange, getActiveBusinessId]);

  const monthGrid = useMonthGrid(current);
  const currentDay = dayjs();
  const currentMonthStart = current.startOf("month");
  const currentMonthEnd = current.endOf("month");
  const monthRangeLabel = `${currentMonthStart.format("MMM D, YYYY")} - ${currentMonthEnd.format("MMM D, YYYY")}`;
  const monthLabel = current.format("MMMM YYYY");
  const badgeMonth = currentDay.format("MMM");
  const badgeDay = currentDay.format("D");

  // derived maps
  const filteredEvents = useMemo(() => {
    return events.filter((e) => typeFilter === "all" || e.type === typeFilter);
  }, [events, typeFilter]);

  const eventsByDay = useMemo(() => {
    const map = {};
    for (const e of filteredEvents) {
      const key = dayjs(e.start_ts).format("YYYY-MM-DD");
      if (!map[key]) map[key] = [];
      map[key].push(e);
    }
    return map;
  }, [filteredEvents]);

  const refreshCalendarEvents = useCallback(async () => {
    const data = await fetchEventsForRange(getActiveBusinessId({ allowMockFallback: false }));
    setEvents(data);
    return data;
  }, [fetchEventsForRange, getActiveBusinessId]);

  useEffect(() => {
    setRightExtras(
      <AgendaWidget
        key={`agenda-${filteredEvents.length}-${filteredEvents[0]?.start_ts || 0}-${filteredEvents[filteredEvents.length - 1]?.end_ts || 0}-${view}-${moduleFilter}-${typeFilter}`}
        businessId={businessId || resolvedBusinessId}
        module="bizzy"
        onOpenCalendar={() => navigate("/dashboard/calendar")}
        eventsOverride={filteredEvents}
        onRefresh={refreshCalendarEvents}
      />
    );
    return () => setRightExtras(null);
  }, [businessId, resolvedBusinessId, navigate, setRightExtras, filteredEvents, refreshCalendarEvents]);

  function prev() {
    setCurrent((v) => (view === "week" ? v.subtract(1, "week") : v.subtract(1, "month")));
  }
  function next() {
    setCurrent((v) => (view === "week" ? v.add(1, "week") : v.add(1, "month")));
  }

  function openCreateFor(dateISO) {
    setEditEvent(null);
    setCreateDateISO(dateISO || null);
    setModalOpen(true);
  }
  function openEdit(event) {
    setEditEvent(event);
    setCreateDateISO(null);
    setModalOpen(true);
  }

  async function handleSave(draftOrPatch) {
    const activeBusiness = getActiveBusinessId({ allowMockFallback: true });
    const fallbackBiz = usingDemo ? "mock-biz" : null;
    const businessForCreate = activeBusiness || fallbackBiz;

    if (editEvent) {
      await API.updateEvent(editEvent.id, draftOrPatch);
      const data = await fetchEventsForRange(activeBusiness);
      setEvents(data);
      return;
    }

    if (!businessForCreate) {
      alert("Select a business before creating events.");
      return;
    }

    const userId =
      typeof window !== "undefined" ? window.localStorage?.getItem("user_id") : null;
    const payload = {
      ...draftOrPatch,
      business_id: businessForCreate,
      user_id: userId || undefined,
      source: draftOrPatch.source || "manual",
    };

    // In mock/demo mode (or when using client mock), create locally so it persists across refreshes.
    if (usingDemo || CLIENT_MOCK_CAL) {
      const id = payload.id || `mock-new-${Date.now()}`;
      const start_ts = payload.start_ts || payload.start || new Date().toISOString();
      const end_ts = payload.end_ts || payload.end || start_ts;
      const mockEvent = {
        ...payload,
        id,
        start_ts,
        end_ts,
        source: "mock",
      };
      setEvents((prev) => [...(prev || []), mockEvent]);
      setMockOverrides((prev) => ({
        ...(prev || {}),
        [id]: { start_ts, end_ts },
      }));
      setMockCreated((prev) => [...(prev || []), mockEvent]);
    } else {
      try {
        await API.createEvent(payload);
        const data = await fetchEventsForRange(businessForCreate);
        setEvents(data);
      } catch (err) {
        // Fallback to local storage if API fails so the event persists
        const id = payload.id || `local-new-${Date.now()}`;
        const start_ts = payload.start_ts || payload.start || new Date().toISOString();
        const end_ts = payload.end_ts || payload.end || start_ts;
        const localEvent = { ...payload, id, start_ts, end_ts, source: "local" };
        setEvents((prev) => [...(prev || []), localEvent]);
        setMockCreated((prev) => [...(prev || []), localEvent]);
      }
    }
  }

  async function handleDelete(id) {
    await API.deleteEvent(id);
    const data = await fetchEventsForRange(getActiveBusinessId({ allowMockFallback: false }));
    setEvents(data);
  }

  return (
    <>
      <style>{`
        .calendar-select {
          position: relative;
          width: 100%;
          isolation: isolate;
        }
        .calendar-select__input {
          width: 100%;
          appearance: none;
          background: linear-gradient(145deg, rgba(16,19,24,0.92), rgba(9,11,15,0.92));
          border: 1px solid rgba(255,255,255,0.12);
          color: ${TEXT_MAIN};
          padding: 5px 26px 5px 10px;
          border-radius: 12px;
          font-size: 0.9rem;
          transition: border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
          cursor: pointer;
        }
        .calendar-select__input:focus {
          outline: none;
          border-color: rgba(255,255,255,0.3);
          box-shadow: 0 0 0 2px rgba(255,255,255,0.08);
          background: linear-gradient(145deg, rgba(16,19,24,0.96), rgba(9,11,15,0.96));
        }
        .calendar-select__input:hover {
          border-color: rgba(255,255,255,0.2);
        }
        .calendar-select::after {
          content: '';
          position: absolute;
          right: 14px;
          top: 50%;
          width: 0;
          height: 0;
          margin-top: -3px;
          border-left: 5px solid transparent;
          border-right: 5px solid transparent;
          border-top: 6px solid rgba(255,255,255,0.65);
          pointer-events: none;
          transition: transform 160ms ease;
        }
        .calendar-select:focus-within::after,
        .calendar-select:hover::after {
          transform: translateY(-2px);
        }
        .calendar-select__dropdown {
          position: absolute;
          left: 0;
          right: 0;
          top: calc(100% + 2px);
          background: rgba(13,16,22,0.98);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 12px;
          box-shadow: 0 18px 48px rgba(0,0,0,0.45);
          padding: 6px 0;
          opacity: 0;
          pointer-events: none;
          transform: translateY(-4px);
          transition: opacity 160ms ease, transform 160ms ease;
          z-index: 20;
        }
        .calendar-select--open .calendar-select__dropdown {
          opacity: 1;
          pointer-events: auto;
          transform: translateY(0);
        }
        .calendar-select__dropdown button {
          width: 100%;
          text-align: left;
          padding: 8px 14px;
          background: transparent;
          border: none;
          color: ${TEXT_MAIN};
          font-size: 0.85rem;
          cursor: pointer;
          transition: background 120ms ease, color 120ms ease;
        }
        .calendar-select__dropdown button:hover {
          background: rgba(255,255,255,0.08);
        }
        .calendar-select__dropdown button.is-active {
          color: #fff;
          background: rgba(255,255,255,0.08);
        }
        .calendar-select--open {
          z-index: 50;
        }
        .view-dropdown {
          background: rgba(13,16,22,0.98);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 12px;
          box-shadow: 0 18px 48px rgba(0,0,0,0.45);
          padding: 6px 0;
        }
        .view-dropdown button {
          width: 100%;
          text-align: left;
          padding: 8px 14px;
          background: transparent;
          border: none;
          color: ${TEXT_MUTED};
          font-size: 0.85rem;
          cursor: pointer;
          transition: background 120ms ease, color 120ms ease;
        }
        .view-dropdown button:hover {
          background: rgba(255,255,255,0.08);
          color: ${TEXT_MAIN};
        }
        .view-dropdown button.active {
          color: #fff;
          background: rgba(255,255,255,0.12);
        }
      `}</style>
      <div className="w-full transition-all px-0 lg:px-4 xl:px-8">
      <section
        className="rounded-[32px] border shadow-[0_35px_70px_rgba(0,0,0,0.55)] flex flex-col"
        style={{
          background: "linear-gradient(160deg, #0f141b 0%, #0b1119 55%, #0a1017 100%)",
          borderColor: "rgba(255,255,255,0.08)",
        }}
      >
        <div className="flex flex-col gap-5 p-5 h-full">
          <div
            className="space-y-4 pt-2 pb-2 sticky top-0 z-30 backdrop-blur"
            style={{
              background: "linear-gradient(180deg, #0f141b 0%, #0b1119 100%)",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
                <div className="flex items-center gap-2">
                  <div>
                    <div className="flex items-center gap-2 flex-nowrap">
                      <p className="text-2xl font-semibold" style={{ color: TEXT_MAIN }}>
                        {monthLabel}
                      </p>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={prev}
                          aria-label="Previous period"
                          className="rounded-xl border px-1.5 py-0.5"
                          style={{ borderColor: "rgba(255,255,255,0.14)", color: TEXT_MAIN, background: "rgba(12,16,22,0.9)" }}
                        >
                          <ChevronLeft size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={next}
                          aria-label="Next period"
                          className="rounded-xl border px-1.5 py-0.5"
                          style={{ borderColor: "rgba(255,255,255,0.14)", color: TEXT_MAIN, background: "rgba(12,16,22,0.9)" }}
                        >
                          <ChevronRight size={12} />
                        </button>
                      </div>
                    </div>
                    <p className="text-sm" style={{ color: TEXT_MUTED }}>
                      {monthRangeLabel}
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 flex-wrap sm:flex-nowrap xl:flex-1 xl:justify-start">
                <div
                  ref={moduleMenuRef}
                  className={`calendar-select ${moduleMenuOpen ? "calendar-select--open" : ""}`}
                  onMouseEnter={() => setModuleMenuOpen(true)}
                  onMouseLeave={(e) => {
                    if (moduleMenuRef.current?.contains(e.relatedTarget)) return;
                    setModuleMenuOpen(false);
                  }}
                  style={{ width: "auto", minWidth: "135px" }}
                >
                  <button
                    type="button"
                    className="calendar-select__input text-left"
                  >
                    {moduleFilter === "all"
                      ? "All Modules"
                      : moduleFilter === "financials"
                      ? "Financials"
                      : moduleFilter === "tax"
                      ? "Tax"
                      : moduleFilter === "marketing"
                      ? "Marketing"
                      : moduleFilter === "investments"
                      ? "Investments"
                      : "Jobs/Leads"}
                  </button>
                  <div
                    className="calendar-select__dropdown"
                    onMouseEnter={() => setModuleMenuOpen(true)}
                    onMouseLeave={(e) => {
                      if (moduleMenuRef.current?.contains(e.relatedTarget)) return;
                      setModuleMenuOpen(false);
                    }}
                  >
                    {[
                      { value: "all", label: "All Modules" },
                      { value: "financials", label: "Financials" },
                      { value: "tax", label: "Tax" },
                      { value: "marketing", label: "Marketing" },
                      { value: "investments", label: "Investments" },
                      { value: "ops", label: "Jobs/Leads" },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        className={opt.value === moduleFilter ? "is-active" : ""}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setModuleFilter(opt.value);
                          setModuleMenuOpen(false);
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div
                  ref={typeMenuRef}
                  className={`calendar-select ${typeMenuOpen ? "calendar-select--open" : ""}`}
                  onMouseEnter={() => setTypeMenuOpen(true)}
                  onMouseLeave={(e) => {
                    if (typeMenuRef.current?.contains(e.relatedTarget)) return;
                    setTypeMenuOpen(false);
                  }}
                  style={{ width: "auto", minWidth: "135px" }}
                >
                  <button
                    type="button"
                    className="calendar-select__input text-left"
                  >
                    {(() => {
                      switch (typeFilter) {
                        case "job":
                          return "Jobs";
                        case "lead":
                          return "Leads";
                        case "deadline":
                          return "Deadlines";
                        case "invoice":
                          return "Invoices";
                        case "meeting":
                          return "Meetings";
                        case "post":
                          return "Posts/Emails";
                        case "task":
                          return "Tasks";
                        default:
                          return "All Types";
                      }
                    })()}
                  </button>
                  <div
                    className="calendar-select__dropdown"
                    onMouseEnter={() => setTypeMenuOpen(true)}
                    onMouseLeave={(e) => {
                      if (typeMenuRef.current?.contains(e.relatedTarget)) return;
                      setTypeMenuOpen(false);
                    }}
                  >
                    {[
                      { value: "all", label: "All Types" },
                      { value: "job", label: "Jobs" },
                      { value: "lead", label: "Leads" },
                      { value: "deadline", label: "Deadlines" },
                      { value: "invoice", label: "Invoices" },
                      { value: "meeting", label: "Meetings" },
                      { value: "post", label: "Posts/Emails" },
                      { value: "task", label: "Tasks" },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        className={opt.value === typeFilter ? "is-active" : ""}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setTypeFilter(opt.value);
                          setTypeMenuOpen(false);
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div
                  ref={viewMenuRef}
                  className={`calendar-select ${viewMenuOpen ? "calendar-select--open" : ""}`}
                  onMouseEnter={() => setViewMenuOpen(true)}
                  onMouseLeave={(e) => {
                    if (viewMenuRef.current?.contains(e.relatedTarget)) return;
                    setViewMenuOpen(false);
                  }}
                  style={{ width: "auto", minWidth: "130px" }}
                >
                  <button
                    type="button"
                    className="calendar-select__input text-left"
                    onClick={() => setViewMenuOpen((v) => !v)}
                  >
                    {VIEW_LABEL(view)}
                  </button>
                  <div
                    className="calendar-select__dropdown"
                    onMouseEnter={() => setViewMenuOpen(true)}
                    onMouseLeave={(e) => {
                      if (viewMenuRef.current?.contains(e.relatedTarget)) return;
                      setViewMenuOpen(false);
                    }}
                  >
                    {["week", "month", "agenda"].map((tab) => (
                      <button
                        key={tab}
                        className={view === tab ? "is-active" : ""}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setView(tab);
                          setViewMenuOpen(false);
                        }}
                      >
                        {VIEW_LABEL(tab)}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => setQuickOpen(true)}
                  className="rounded-2xl border px-2.5 py-1.5 text-sm font-semibold flex items-center justify-center gap-2"
                  style={{ color: TEXT_MAIN, borderColor: "rgba(255,255,255,0.14)", background: "linear-gradient(145deg, rgba(17,21,29,0.96), rgba(11,15,23,0.96))" }}
                >
                  <Plus size={15} /> Quick Create
                </button>
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 pr-1 pb-12 lg:pb-16 overflow-hidden">
            <section
              className="rounded-[28px] border p-4 mt-2"
              style={{
                borderColor: "rgba(255,255,255,0.08)",
                background: "linear-gradient(150deg, #0f141b 0%, #0b1119 100%)",
              }}
            >
          <div
            className="min-h-[420px] border border-white/5 rounded-3xl p-4 overflow-hidden relative"
            style={{ background: "linear-gradient(150deg, #0f141b 0%, #0b1119 100%)" }}
          >
                {view === "week" && (
                  <div
                    className="w-14 h-14 rounded-xl flex flex-col items-center justify-center text-center absolute"
                    style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", color: TEXT_MAIN, left: "20px", top: "18px" }}
                  >
                    <span className="text-[10px] uppercase tracking-wide" style={{ color: TEXT_MUTED }}>
                      {badgeMonth}
                    </span>
                    <span className="text-lg font-semibold leading-none">{badgeDay}</span>
                  </div>
                )}
                {view === "agenda" && <AgendaList events={filteredEvents} onEdit={openEdit} />}
                {view !== "agenda" && (
                  <MonthOrWeekGrid
                    view={view}
                    current={current}
                    events={filteredEvents}
                    eventsByDay={eventsByDay}
                    onCreate={openCreateFor}
                    onEdit={openEdit}
                    badgeMonth={badgeMonth}
                    badgeDay={badgeDay}
                    fetchEventsForRange={fetchEventsForRange}
                    getActiveBusinessId={getActiveBusinessId}
                    setEvents={setEvents}
                    usingDemo={usingDemo}
                    setMockOverrides={setMockOverrides}
                  />
                )}
              </div>
            </section>
          </div>
        </div>
      </section>

      {/* Modals */}
      {modalOpen && (
        <EventModal
          isOpen={modalOpen}
          onClose={() => {
            setModalOpen(false);
            setEditEvent(null);
            setCreateDateISO(null);
          }}
          onSave={handleSave}
          onDelete={editEvent ? () => handleDelete(editEvent.id) : null}
          defaultDateISO={
            editEvent
              ? editEvent.start_ts
              : createDateISO || current.startOf("day").toISOString()
          }
          event={editEvent}
        />
      )}
      {quickOpen && (
        <CalendarQuickOpen
          businessId={businessId || resolvedBusinessId}
          onClose={() => setQuickOpen(false)}
          onCreated={async () => {
            const data = await fetchEventsForRange(
              getActiveBusinessId({ allowMockFallback: false })
            );
            setEvents(data);
          }}
        />
      )}
      </div>
    </>
  );
}

/** Month/Week grid */
function MonthOrWeekGrid({
  view,
  current,
  events,
  eventsByDay,
  onCreate,
  onEdit,
  badgeMonth,
  badgeDay,
  fetchEventsForRange,
  getActiveBusinessId,
  setEvents,
  usingDemo,
  setMockOverrides,
}) {
  const monthCellRefs = useRef({});
  const [monthDragging, setMonthDragging] = useState(null); // { event, dayKey, durationMinutes }

  useEffect(() => {
    if (!monthDragging) return;
    const findDayKey = (clientX, clientY) => {
      const entries = Object.entries(monthCellRefs.current || {});
      for (const [key, el] of entries) {
        const rect = el?.getBoundingClientRect?.();
        if (!rect) continue;
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
          return key;
        }
      }
      return monthDragging.dayKey;
    };

    const onUp = async (e) => {
      const targetKey = findDayKey(e.clientX, e.clientY);
      const active = monthDragging;
      setMonthDragging(null);
      if (!active?.event || !targetKey) return;
      const start = dayjs(active.event.start_ts);
      const durationMinutes = active.durationMinutes;
      const isMock =
        usingDemo ||
        active.event?.source === "mock" ||
        String(active.event?.id || "").startsWith("mock-") ||
        active.event?.business_id === "mock-biz";

      const newStart = active.event.all_day
        ? dayjs(targetKey).startOf("day")
        : dayjs(targetKey).hour(start.hour()).minute(start.minute());
      const newEnd = newStart.add(durationMinutes, "minute");

      if (isMock) {
        const patch = { start_ts: newStart.toISOString(), end_ts: newEnd.toISOString() };
        setMockOverrides((prev) => ({ ...prev, [active.event.id]: patch }));
        setEvents((prev) =>
          (prev || []).map((evt) => (evt.id === active.event.id ? { ...evt, ...patch } : evt))
        );
        return;
      }

      try {
        await API.updateEvent(active.event.id, {
          start_ts: newStart.toISOString(),
          end_ts: newEnd.toISOString(),
        });
        setEvents((prev) =>
          (prev || []).map((evt) =>
            evt.id === active.event.id ? { ...evt, start_ts: newStart.toISOString(), end_ts: newEnd.toISOString() } : evt
          )
        );
        const data = await fetchEventsForRange(getActiveBusinessId({ allowMockFallback: false }));
        setEvents(data);
      } catch (err) {
        console.error("Month drag update failed", err);
      }
    };

    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointerup", onUp);
    };
  }, [monthDragging, usingDemo, setMockOverrides, setEvents, fetchEventsForRange, getActiveBusinessId]);

  if (view === "week") {
    return (
      <WeekTimelineGrid
        current={current}
        events={events}
        eventsByDay={eventsByDay}
        onCreate={onCreate}
        onEdit={onEdit}
        badgeMonth={badgeMonth}
        badgeDay={badgeDay}
        fetchEventsForRange={fetchEventsForRange}
        getActiveBusinessId={getActiveBusinessId}
        setEvents={setEvents}
        usingDemo={usingDemo}
        setMockOverrides={setMockOverrides}
      />
    );
  }

  const start = current.startOf("month").startOf("week");
  const end = current.endOf("month").endOf("week");
  const days = [];
  let it = start.clone();
  while (it.isBefore(end) || it.isSame(end, "day")) {
    days.push(it);
    it = it.add(1, "day");
  }

  return (
    <div className="rounded-3xl border border-white/6 bg-[#0b1119] p-3">
      <div className="grid grid-cols-7 gap-1">
        {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => (
          <div key={d} className="text-center text-xs py-1 rounded-md" style={{ color: TEXT_MUTED, background: "rgba(255,255,255,0.02)" }}>
            {d}
          </div>
        ))}
        {days.map((d, idx) => {
          const key = d.format("YYYY-MM-DD");
          const list = eventsByDay[key] || [];
          const isToday = d.isSame(dayjs(), "day");
          return (
            <div
              key={idx}
              className="min-h-[110px] rounded-md p-1 relative group"
              style={{ background: "linear-gradient(180deg, rgba(17,21,29,0.95), rgba(12,16,24,0.97))", border: `1px solid rgba(255,255,255,0.07)` }}
              ref={(el) => {
                if (!monthCellRefs.current) monthCellRefs.current = {};
                if (el) monthCellRefs.current[key] = el;
              }}
            >
              <div
                className="text-xs"
                style={{
                  color: isToday ? TEXT_MAIN : TEXT_MUTED,
                  fontWeight: isToday ? 600 : 400,
                }}
              >
                {d.date()}
              </div>

              <div className="mt-1 space-y-1 overflow-hidden">
                {list.slice(0, 4).map((e) => (
                  <button
                    key={e.id}
                    onPointerDown={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      const start = dayjs(e.start_ts);
                      const end = dayjs(e.end_ts);
                      const durationMinutes = Math.max(30, end.diff(start, "minute"));
                      setMonthDragging({ event: e, dayKey: key, durationMinutes });
                    }}
                    onClick={(ev) => {
                      if (monthDragging) { ev.preventDefault(); return; }
                      onEdit(e);
                    }}
                    title={e.title}
                    className="w-full text-left text-[11px] leading-tight px-1 py-0.5 rounded-md truncate cursor-grab active:cursor-grabbing"
                    style={{ backgroundColor: `${MODULE_COLORS[e.module]}33`, color: "#e5e7eb" }}
                  >
                    <span className="opacity-90">{e.title}</span>
                  </button>
                ))}
                {list.length > 4 && (
                  <div className="text-[10px]" style={{ color: TEXT_MUTED }}>
                    +{list.length - 4} more
                  </div>
                )}
              </div>

              <button
                onClick={() => onCreate(d.toISOString())}
                className="absolute bottom-1 right-1 text-[11px] opacity-0 group-hover:opacity-100 transition"
                style={{ color: TEXT_MUTED }}
              >
                + Add
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgendaList({ events, onEdit }) {
  if (!events.length) {
    return <div className="text-sm" style={{ color: TEXT_MUTED }}>No events in the next two weeks.</div>;
  }
  return (
    <div className="divide-y" style={{ borderColor: NEUTRAL_BORDER, color: TEXT_MAIN }}>
      {events.map((e) => (
        <div key={e.id} className="py-2 flex items-center justify-between">
          <div>
            <div className="font-medium">{e.title}</div>
            <div className="text-xs" style={{ color: TEXT_MUTED }}>
              {dayjs(e.start_ts).format("MMM D, h:mm a")} · {e.module}/{e.type}
            </div>
          </div>
          <button
            onClick={() => onEdit(e)}
            className="px-2 py-1 text-xs rounded transition"
            style={{ background: "linear-gradient(145deg, rgba(16,19,24,0.9), rgba(9,11,15,0.9))", border: `1px solid ${NEUTRAL_BORDER}`, color: TEXT_MAIN }}
          >
            Open
          </button>
        </div>
      ))}
    </div>
  );
}

const DAY_START = 6;
const DAY_END = 22;
const DEFAULT_SCROLL_HOUR = 8;
const HOUR_HEIGHT = 64; // px
const HOUR_LINE = "rgba(255,255,255,0.08)";
const HALF_LINE = "rgba(255,255,255,0.04)";
const NOW_POLL_MS = 30000;
const SCROLLER_PAD_PX = 240; // extra scroll height to allow full travel without hitting page

function WeekTimelineGrid({
  current,
  events,
  eventsByDay,
  onCreate,
  onEdit,
  badgeMonth,
  badgeDay,
  fetchEventsForRange,
  getActiveBusinessId,
  setEvents,
  usingDemo,
  setMockOverrides,
}) {
  const days = useMemo(() => {
    const start = current.startOf("week");
    return Array.from({ length: 7 }, (_, i) => start.add(i, "day"));
  }, [current]);
  const weekHasToday = useMemo(() => days.some((d) => d.isSame(dayjs(), "day")), [days]);

  const hours = useMemo(() => {
    const arr = [];
    for (let h = DAY_START; h <= DAY_END; h += 1) arr.push(h);
    return arr;
  }, []);

  const columnHeight = (DAY_END - DAY_START) * HOUR_HEIGHT;
  const scrollerRef = useRef(null);
  const timelineStartRef = useRef(null);
  const [now, setNow] = useState(dayjs());
  const lastScrollAnchor = useRef(null);
  const dayColumnRefs = useRef({});
  const [dragging, setDragging] = useState(null); // { event, dayKey, offsetMinutes, durationMinutes, pointerId }

  const totalMinutes = (DAY_END - DAY_START) * 60;

  const snapToQuarterHour = useCallback(
    (minutes) => {
      const snapped = Math.round(minutes / 15) * 15;
      return Math.max(0, Math.min(totalMinutes - (dragging?.durationMinutes || 0), snapped));
    },
    [totalMinutes, dragging?.durationMinutes]
  );

useEffect(() => {
  if (!scrollerRef.current) return;
  const raf = requestAnimationFrame(() => {
    const baseOffset = Math.max(0, (DEFAULT_SCROLL_HOUR - DAY_START)) * HOUR_HEIGHT;
    let stackOffset = 0;
      if (timelineStartRef.current) {
        const gridTop = scrollerRef.current.getBoundingClientRect().top;
        const timelineTop = timelineStartRef.current.getBoundingClientRect().top;
        stackOffset = timelineTop - gridTop;
      }
      scrollerRef.current.scrollTop = stackOffset + baseOffset;
    });
    return () => cancelAnimationFrame(raf);
  }, [current]);

  useEffect(() => {
    const id = setInterval(() => setNow(dayjs()), NOW_POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!scrollerRef.current) return;
    const anchor = current.startOf("week").format("YYYY-MM-DD");
    if (lastScrollAnchor.current === anchor) return;
    lastScrollAnchor.current = anchor;
    const baseOffset = Math.max(0, (DEFAULT_SCROLL_HOUR - DAY_START)) * HOUR_HEIGHT;
    requestAnimationFrame(() => {
      if (scrollerRef.current) scrollerRef.current.scrollTop = baseOffset;
    });
  }, [current]);

  // Ensure initial focus around 8 AM after events/load cycles (both week/month switch and data load).
  useEffect(() => {
    if (!scrollerRef.current) return;
    const baseOffset = Math.max(0, (DEFAULT_SCROLL_HOUR - DAY_START)) * HOUR_HEIGHT;
    requestAnimationFrame(() => {
      if (scrollerRef.current) scrollerRef.current.scrollTo({ top: baseOffset, behavior: "auto" });
    });
  }, [current, events.length]);

  const renderTimedEvents = (day, list) => {
    const timed = list
      .filter((e) => !e.all_day)
      .sort((a, b) => new Date(a.start_ts) - new Date(b.start_ts));
    let lastBottom = -Infinity;
    return timed.map((event) => {
      const start = dayjs(event.start_ts);
      const end = dayjs(event.end_ts);
      const dayStart = day.startOf("day").add(DAY_START, "hour");
      const startMinutes = Math.max(0, start.diff(dayStart, "minute"));
      const eventEndMinutes = Math.max(startMinutes + 30, end.diff(dayStart, "minute"));
      const cappedEnd = Math.min(totalMinutes, eventEndMinutes);
      const height = Math.max(32, ((cappedEnd - startMinutes) / 60) * HOUR_HEIGHT);
      const rawTop = (startMinutes / 60) * HOUR_HEIGHT;
      const top = Math.max(rawTop, lastBottom + 6);
      lastBottom = top + height;
      const color = MODULE_COLORS[event.module] || "#94a3b8";
      return (
        <button
          key={event.id}
          className="absolute left-1 right-1 rounded-lg px-2 py-1 text-left text-[11px] leading-tight shadow-lg cursor-grab active:cursor-grabbing"
          style={{
            top,
            height,
            background: `${color}55`,
            border: `1px solid ${color}aa`,
            color: "#f4f4f5",
            opacity: dragging?.event?.id === event.id ? 0.4 : 1,
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const box = e.currentTarget.getBoundingClientRect();
            const offsetMinutes = ((e.clientY - box.top) / HOUR_HEIGHT) * 60;
            const durationMinutes = Math.max(30, end.diff(start, "minute"));
            const dayKey = day.format("YYYY-MM-DD");
            setDragging({
              event,
              dayKey,
              offsetMinutes,
              durationMinutes,
              liveMinutes: startMinutes,
              pointerId: e.pointerId,
            });
          }}
          onClick={() => onEdit(event)}
        >
          <div className="font-semibold text-[12px] truncate">{event.title}</div>
          <div className="text-[10px] opacity-80">
            {start.format("h:mm A")} – {end.format("h:mm A")}
          </div>
        </button>
      );
    });
  };

  const renderAllDay = (list) => {
    const allDay = list.filter((e) => e.all_day);
    if (!allDay.length) return null;
    return (
      <div className="flex flex-col gap-1 mb-2">
        {allDay.map((event) => {
          const color = MODULE_COLORS[event.module] || "#94a3b8";
          return (
            <button
              key={event.id}
              onClick={() => onEdit(event)}
              className="rounded-lg px-2 py-1 text-left text-[11px] leading-tight"
              style={{
                background: `${color}26`,
                border: `1px solid ${color}55`,
                color: "#f4f4f5",
              }}
            >
              {event.title}
            </button>
          );
        })}
      </div>
    );
  };

  // drag handlers
  useEffect(() => {
    if (!dragging) return;
    const findDayKeyFromClientX = (clientX) => {
      let bestKey = null;
      let bestDist = Infinity;
      for (const day of days) {
        const key = day.format("YYYY-MM-DD");
        const rect = dayColumnRefs.current[key]?.getBoundingClientRect();
        if (!rect) continue;
        if (clientX >= rect.left && clientX <= rect.right) return key;
        const dist = Math.min(Math.abs(clientX - rect.left), Math.abs(clientX - rect.right));
        if (dist < bestDist) {
          bestDist = dist;
          bestKey = key;
        }
      }
      return bestKey;
    };

    function onMove(e) {
      if (dragging.pointerId !== undefined && e.pointerId !== dragging.pointerId) return;
      const targetKey = findDayKeyFromClientX(e.clientX);
      const col = targetKey ? dayColumnRefs.current[targetKey] : null;
      if (!col) return;
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top - (dragging.offsetMinutes / 60) * HOUR_HEIGHT;
      const rawMinutes = (y / HOUR_HEIGHT) * 60;
      const minutesFromStart = snapToQuarterHour(rawMinutes);
      setDragging((prev) =>
        prev ? { ...prev, dayKey: targetKey, liveMinutes: minutesFromStart } : null
      );
    }
    async function onUp(e) {
      if (dragging.pointerId !== undefined && e.pointerId !== dragging.pointerId) return;
      const active = dragging;
      setDragging(null);
      const targetKey = findDayKeyFromClientX(e.clientX) || active.dayKey;
      const col = dayColumnRefs.current[targetKey];
      if (!col) return;
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top - (active.offsetMinutes / 60) * HOUR_HEIGHT;
      const rawMinutes = (y / HOUR_HEIGHT) * 60;
      const minutesFromStart = snapToQuarterHour(rawMinutes);
      const newStart = dayjs(targetKey).hour(DAY_START).minute(0).add(minutesFromStart, "minute");
      const newEnd = newStart.add(active.durationMinutes, "minute");

      // In demo/mock mode, or when the event itself is mock, keep the update local.
      const isMock =
        usingDemo ||
        active.event?.source === "mock" ||
        String(active.event?.id || "").startsWith("mock-") ||
        active.event?.business_id === "mock-biz";
      if (isMock) {
        const patch = { start_ts: newStart.toISOString(), end_ts: newEnd.toISOString() };
        setMockOverrides((prev) => ({ ...prev, [active.event.id]: patch }));
        setEvents((prev) =>
          (prev || []).map((evt) => (evt.id === active.event.id ? { ...evt, ...patch } : evt))
        );
        return;
      }

      try {
        await API.updateEvent(active.event.id, {
          start_ts: newStart.toISOString(),
          end_ts: newEnd.toISOString(),
        });
        // Optimistic local update for snappier UI
        setEvents((prev) =>
          (prev || []).map((evt) =>
            evt.id === active.event.id
              ? { ...evt, start_ts: newStart.toISOString(), end_ts: newEnd.toISOString() }
              : evt
          )
        );
        const data = await fetchEventsForRange(getActiveBusinessId({ allowMockFallback: false }));
        setEvents(data);
      } catch (err) {
        console.error("Drag update failed", err);
      }
    }
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: false });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, totalMinutes, fetchEventsForRange, getActiveBusinessId, setEvents, days, snapToQuarterHour, usingDemo]);

  return (
    <div className="space-y-2">
      <div
        className="relative rounded-3xl border border-white/6 bg-[#0b1119]"
        ref={scrollerRef}
        style={{ overflowY: "auto", height: `${columnHeight + SCROLLER_PAD_PX}px`, maxHeight: `${columnHeight + SCROLLER_PAD_PX}px` }}
      >
        <WeekDateHeader
          days={days}
          badgeMonth={badgeMonth}
          badgeDay={badgeDay}
          textMain={TEXT_MAIN}
          textMuted={TEXT_MUTED}
        />
        <div className="grid grid-cols-[80px_repeat(7,minmax(0,1fr))] gap-2 relative px-2 pb-2">
          <div
            className="flex flex-col text-[11px]"
            style={{
              color: TEXT_MUTED,
              paddingTop: "2px",
            }}
          >
            {hours.map((hour) => (
              <div key={hour} className="relative" style={{ height: HOUR_HEIGHT }}>
                <span className="absolute right-2 top-1.5">{dayjs().hour(hour).minute(0).format("h A")}</span>
              </div>
            ))}
          </div>

          {days.map((day, idx) => {
            const key = day.format("YYYY-MM-DD");
            const eventsForDay = eventsByDay[key] || [];
            return (
              <div
                key={key}
                className="rounded-2xl relative p-2"
                style={{ background: "linear-gradient(180deg, rgba(17,21,29,0.95), rgba(12,16,24,0.97))", border: "1px solid rgba(255,255,255,0.07)" }}
                ref={(el) => {
                  if (el) dayColumnRefs.current[key] = el;
                }}
              >
                {renderAllDay(eventsForDay)}
                <div
                  ref={idx === 0 ? timelineStartRef : null}
                  className="relative rounded-2xl"
                  style={{
                    height: columnHeight,
                    backgroundImage: "none",
                    backgroundSize: `100% ${HOUR_HEIGHT}px`,
                    borderTop: "none",
                  }}
                >
                  {dragging && dragging.dayKey === key && dragging.liveMinutes !== undefined && (
                    <div
                      className="pointer-events-none absolute left-1 right-1 rounded-lg border border-dashed"
                      style={{
                        top: (dragging.liveMinutes / 60) * HOUR_HEIGHT,
                        height: (dragging.durationMinutes / 60) * HOUR_HEIGHT,
                        borderColor: "rgba(255,255,255,0.2)",
                        background: "rgba(255,255,255,0.04)",
                      }}
                    />
                  )}
                  {renderTimedEvents(day, eventsForDay)}
                  <button
                    onClick={() => onCreate(day.toISOString())}
                    className="sticky top-2 mx-auto block text-[11px] px-3 py-1 rounded-full text-white/80 hover:text-white"
                    style={{ background: "rgba(14,15,18,0.8)", border: "none", width: "fit-content" }}
                  >
                    + Add
                  </button>
                </div>
              </div>
            );
          })}
          {weekHasToday && (() => {
            const minutesFromStart = now.diff(dayjs().startOf("day").add(DAY_START, "hour"), "minute");
            const withinHours = minutesFromStart >= 0 && minutesFromStart <= (DAY_END - DAY_START) * 60;
            if (!withinHours) return null;
            return (
              <div
                className="pointer-events-none absolute"
                style={{
                  top: (minutesFromStart / 60) * HOUR_HEIGHT,
                  left: "calc(80px + 0.5rem)",
                  right: 0,
                  zIndex: 10,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: "-10px",
                    top: "-3px",
                    width: "10px",
                    height: "10px",
                    borderRadius: "50%",
                    background: "#ff6b6b",
                    boxShadow: "0 0 10px rgba(255,107,107,0.55)",
                  }}
                />
                <div
                  style={{
                    borderTop: "1px dashed rgba(255,107,107,0.8)",
                    boxShadow: "0 0 6px rgba(255,107,107,0.35)",
                  }}
                />
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
