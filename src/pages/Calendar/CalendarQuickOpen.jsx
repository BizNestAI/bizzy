// CalendarQuickOpen.jsx
import React, { useEffect, useRef, useState } from "react";
import dayjs from "dayjs";
import useDemoMode from "../../hooks/useDemoMode";

const MODULE_OPTS = [
  { value: "ops", label: "Jobs / Ops" },
  { value: "financials", label: "Financials" },
  { value: "tax", label: "Tax" },
  { value: "marketing", label: "Marketing" },
  { value: "investments", label: "Investments" },
];

const TYPE_OPTS = [
  { value: "job", label: "Job" },
  { value: "meeting", label: "Meeting" },
  { value: "deadline", label: "Deadline" },
  { value: "task", label: "Task" },
  { value: "invoice", label: "Invoice" },
  { value: "post", label: "Post / Email" },
];

export default function CalendarQuickOpen({ businessId, onClose, onCreated }) {
  const resolvedBusinessId =
    businessId ||
    (typeof window !== "undefined"
      ? window.localStorage?.getItem("currentBusinessId")
      : null);
  const mode = useDemoMode();
  const isDemoMode = mode === "demo";

  const [agenda, setAgenda] = useState([]);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(() => dayjs().format("YYYY-MM-DD"));
  const [time, setTime] = useState(() => dayjs().add(1, "hour").startOf("hour").format("HH:mm"));
  const [module, setModule] = useState("ops");
  const [eventType, setEventType] = useState("job");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);

  const NEUTRAL_BORDER = "rgba(165,167,169,0.18)";
  const PANEL_BG = "rgba(15,16,18,0.95)";
  const FIELD_BG = "rgba(32,33,38,0.96)";
  const TEXT = "var(--text)";
  const TEXT_MUTED = "var(--text-2)";

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const r = await fetch(
          `/api/calendar/agenda?business_id=${resolvedBusinessId}&module=all&date=${new Date().toISOString()}`
        );
        const data = await r.json();
        const combined = [...(data?.today || []), ...(data?.next || [])];
        const filtered = combined.filter((item) => !String(item?.id || "").startsWith("mock-"));
        if (!ignore) setAgenda(filtered);
      } catch {
        if (!ignore) setAgenda([]);
      }
    }
    if (resolvedBusinessId && !isDemoMode) load();
    else setAgenda([]);

    requestAnimationFrame(() => inputRef.current?.focus());
    const onKey = (e) => e.key === "Escape" && onClose?.();
    document.addEventListener("keydown", onKey);
    return () => {
      ignore = true;
      document.removeEventListener("keydown", onKey);
    };
  }, [resolvedBusinessId, onClose, isDemoMode]);

  async function handleCreate() {
    if (!title.trim() || saving || !resolvedBusinessId) return;
    const start = dayjs(`${date}T${time || "09:00"}`);
    const end = start.add(1, "hour");
    const draft = {
      business_id: resolvedBusinessId,
      user_id:
        (typeof window !== "undefined" ? window.localStorage?.getItem("user_id") : null) ||
        undefined,
      title: title.trim(),
      module,
      type: eventType,
      start: start.toISOString(),
      end: end.toISOString(),
      notes: notes.trim() || null,
      source: "quick-create",
    };
    setSaving(true);
    try {
      const res = await fetch(`/api/calendar/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || "Failed to create event");
      }
      await res.json().catch(() => ({}));
      if (typeof onCreated === "function") await onCreated();
      setTitle("");
      setNotes("");
      setDate(dayjs().format("YYYY-MM-DD"));
      setTime(dayjs().add(1, "hour").startOf("hour").format("HH:mm"));
      onClose?.();
    } catch (e) {
      console.error("[CalendarQuickOpen] create failed:", e);
      alert(e?.message || "Unable to create event. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const SelectField = ({ label, options, value, onChange }) => (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md text-sm"
        style={{
          background: FIELD_BG,
          border: `1px solid ${NEUTRAL_BORDER}`,
          color: TEXT,
          padding: "10px 12px",
        }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-[999] grid p-4"
      style={{ background: "rgba(0,0,0,0.68)", placeItems: "start center", paddingTop: "8vh" }}
      role="dialog"
      aria-modal="true"
      aria-label="Quick calendar create and agenda"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <style>{``}</style>
      <div
        className="w-full max-w-3xl rounded-2xl"
        style={{
          background: PANEL_BG,
          border: `1px solid ${NEUTRAL_BORDER}`,
          boxShadow: "0 18px 50px rgba(0,0,0,0.55)",
        }}
      >
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: `1px solid ${NEUTRAL_BORDER}` }}
        >
          <div className="text-base font-semibold" style={{ color: TEXT }}>
            Quick Agenda
          </div>
          <button
            onClick={onClose}
            title="Close"
            className="h-8 w-8 grid place-items-center rounded-md hover:bg-white/8"
            style={{ color: TEXT_MUTED, border: `1px solid transparent` }}
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <input
            ref={inputRef}
            className="w-full rounded-md text-sm outline-none"
            placeholder='Job name (e.g., "Crew standup at warehouse")'
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            style={{
              background: FIELD_BG,
              border: `1px solid ${NEUTRAL_BORDER}`,
              color: TEXT,
              padding: "10px 12px",
            }}
          />

          <div className="grid gap-2 sm:grid-cols-2">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-md text-sm outline-none"
              style={{
                background: "rgba(48,51,58,0.98)",
                border: `1px solid rgba(255,255,255,0.24)`,
                color: TEXT,
                padding: "10px 12px",
              }}
            />
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="rounded-md text-sm outline-none"
              style={{
                background: "rgba(48,51,58,0.98)",
                border: `1px solid rgba(255,255,255,0.24)`,
                color: TEXT,
                padding: "10px 12px",
              }}
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <SelectField
              label="Module"
              options={MODULE_OPTS}
              value={module}
              onChange={setModule}
            />
            <SelectField
              label="Type"
              options={TYPE_OPTS}
              value={eventType}
              onChange={setEventType}
            />
          </div>

          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded-md text-sm outline-none resize-none"
            placeholder="Optional notes"
            style={{
              background: FIELD_BG,
              border: `1px solid ${NEUTRAL_BORDER}`,
              color: TEXT,
              padding: "10px 12px",
            }}
          />

          <div className="flex items-center justify-between pt-1">
            <div className="text-[12px]" style={{ color: TEXT_MUTED }}>
              Entries default to one hour. Edit the details inside Calendar later.
            </div>
            <button
              disabled={saving || !title.trim() || !resolvedBusinessId}
              onClick={handleCreate}
              className="px-4 py-2 rounded-md text-sm transition disabled:opacity-60 disabled:cursor-not-allowed"
              style={{
                color: TEXT,
                background: "rgba(255,255,255,0.06)",
                border: `1px solid ${NEUTRAL_BORDER}`,
              }}
            >
              {saving ? "Scheduling…" : "Create"}
            </button>
          </div>

          <div
            className="mt-4 max-h-[45vh] overflow-auto divide-y"
            style={{ borderColor: NEUTRAL_BORDER }}
          >
            {agenda.map((item) => (
              <div key={item.id} className="py-2 flex items-center justify-between">
                <div>
                  <div className="font-medium" style={{ color: TEXT }}>
                    {item.title}
                  </div>
                  <div className="text-[12px]" style={{ color: TEXT_MUTED }}>
                    {new Date(item.when.start).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    · {item.module}/{item.type}
                  </div>
                </div>
                {item.primaryCta?.route && (
                  <a
                    href={item.primaryCta.route}
                    className="text-[12px] px-3 py-1 rounded-md transition"
                    style={{
                      background: "rgba(255,255,255,0.08)",
                      border: `1px solid rgba(255,255,255,0.18)`,
                      color: TEXT,
                    }}
                  >
                    {item.primaryCta.label}
                  </a>
                )}
              </div>
            ))}

            {!agenda.length && (
              <div className="py-6 text-sm" style={{ color: TEXT_MUTED }}>
                {resolvedBusinessId && !isDemoMode
                  ? "No upcoming items in the next week."
                  : "Connect your calendar to see upcoming agenda items here."}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

  
