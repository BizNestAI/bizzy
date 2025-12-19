// EventModal.jsx
import React, { useEffect, useState } from "react";
import dayjs from "dayjs";

/**
 * Shared create/edit modal for events
 * Props:
 *  - isOpen
 *  - onClose
 *  - onSave(draftOrPatch)
 *  - onDelete?()
 *  - defaultDateISO
 *  - event? (for edit mode)
 */
export default function EventModal({
  isOpen,
  onClose,
  onSave,
  onDelete,
  defaultDateISO,
  event,
}) {
  const isEdit = !!event;
  const [title, setTitle] = useState(event?.title || "");
  const [module, setModule] = useState(event?.module || "ops");
  const [type, setType] = useState(event?.type || "task");
  const [startISO, setStartISO] = useState(event?.start_ts || defaultDateISO);
  const [endISO, setEndISO] = useState(() =>
    event?.end_ts || dayjs(defaultDateISO).add(1, "hour").toISOString()
  );
  const [allDay, setAllDay] = useState(event?.all_day || (event?.type === 'deadline'));
  const [location, setLocation] = useState(event?.location || "");
  const [desc, setDesc] = useState(event?.description || "");

  useEffect(() => {
    if (!isOpen) return;
    setTitle(event?.title || "");
    setModule(event?.module || "ops");
    setType(event?.type || "task");
    setStartISO(event?.start_ts || defaultDateISO);
    setEndISO(event?.end_ts || dayjs(defaultDateISO).add(1, "hour").toISOString());
    setAllDay(event?.all_day || false);
    setLocation(event?.location || "");
    setDesc(event?.description || "");
  }, [isOpen, event, defaultDateISO]);

  async function submit() {
    const payload = {
      title,
      module,
      type,
      start: startISO,
      end: endISO,
      all_day: allDay,
      location,
      description: desc,
    };
    try {
      await onSave(payload);
      onClose?.();
    } catch (err) {
      console.error("[EventModal] save failed:", err);
      alert(err?.message || "Unable to save event. Please try again.");
    }
  }

  if (!isOpen) return null;

  const BORDER = "rgba(165,167,169,0.18)";
  const FIELD_BG = "rgba(30,32,36,0.95)";
  const TEXT = "var(--text)";
  const TEXT_MUTED = "var(--text-2)";

  return (
    <div
      className="fixed inset-0 z-[1000] bg-black/70 flex justify-center items-start p-4"
      style={{ paddingTop: "5vh" }}
    >
      <div
        className="w-full max-w-lg rounded-2xl"
        style={{
          background: "rgba(16,18,23,0.95)",
          border: `1px solid ${BORDER}`,
          boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
          color: TEXT,
        }}
      >
        <div className="flex items-center justify-between mb-3 px-5 pt-5">
          <div className="font-semibold text-base">
            {isEdit ? "Edit Event" : "Create Event"}
          </div>
          <button
            className="h-8 w-8 grid place-items-center rounded-md hover:bg-white/10"
            style={{ color: TEXT_MUTED }}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="space-y-3 px-5 pb-5">
          <div>
            <label className="block text-xs text-white/60 mb-1">Title</label>
            <input
              className="w-full rounded p-2 text-sm outline-none"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{
                background: FIELD_BG,
                border: `1px solid ${BORDER}`,
                color: TEXT,
              }}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-white/60 mb-1">Module</label>
              <select
                className="w-full rounded p-2 text-sm outline-none"
                value={module}
                onChange={(e) => setModule(e.target.value)}
                style={{
                  background: FIELD_BG,
                  border: `1px solid ${BORDER}`,
                  color: TEXT,
                }}
              >
                <option value="financials">Financials</option>
                <option value="tax">Tax</option>
                <option value="marketing">Marketing</option>
                <option value="investments">Investments</option>
                <option value="ops">Jobs/Leads</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-white/60 mb-1">Type</label>
              <select
                className="w-full rounded p-2 text-sm outline-none"
                value={type}
                onChange={(e) => setType(e.target.value)}
                style={{
                  background: FIELD_BG,
                  border: `1px solid ${BORDER}`,
                  color: TEXT,
                }}
              >
                <option value="job">Job</option>
                <option value="lead">Lead</option>
                <option value="invoice">Invoice</option>
                <option value="deadline">Deadline</option>
                <option value="meeting">Meeting</option>
                <option value="post">Post</option>
                <option value="email">Email</option>
                <option value="task">Task</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs text-white/60 mb-1">Start</label>
            <input
              type={allDay ? "date" : "datetime-local"}
              className="w-full rounded p-2 text-sm outline-none"
              value={allDay ? dayjs(startISO).format("YYYY-MM-DD") : formatLocal(startISO)}
              onChange={(e) => {
                const next = allDay
                  ? dayjs(e.target.value).startOf("day").toISOString()
                  : fromLocal(e.target.value);
                setStartISO(next);
                setEndISO(
                  allDay
                    ? sameDayEndISO(next)
                    : dayjs(next).add(1, "hour").toISOString()
                );
              }}
              style={{
                background: FIELD_BG,
                border: `1px solid ${BORDER}`,
                color: TEXT,
              }}
            />
          </div>

          <div className="flex items-center gap-2">
            <input type="checkbox" id="allday" checked={allDay} onChange={e => setAllDay(e.target.checked)} />
            <label htmlFor="allday" className="text-xs" style={{ color: TEXT_MUTED }}>All day</label>
          </div>

          <div>
            <label className="block text-xs text-white/60 mb-1">Location (optional)</label>
            <input
              className="w-full rounded p-2 text-sm outline-none"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              style={{
                background: FIELD_BG,
                border: `1px solid ${BORDER}`,
                color: TEXT,
              }}
            />
          </div>

          <div>
            <label className="block text-xs text-white/60 mb-1">Description</label>
            <textarea
              className="w-full rounded p-2 text-sm outline-none"
              rows={3}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              style={{
                background: FIELD_BG,
                border: `1px solid ${BORDER}`,
                color: TEXT,
              }}
            />
          </div>

          <div className="flex items-center justify-between mt-1">
            {onDelete && (
              <button
                onClick={onDelete}
                className="px-3 py-1.5 rounded text-white text-sm"
                style={{ background: "rgba(239,68,68,0.9)" }}
              >
                Delete
              </button>
            )}
            <div className="flex-1" />
            <button
              onClick={submit}
              className="px-4 py-1.5 rounded text-sm font-semibold"
              style={{
                background: "rgba(255,255,255,0.12)",
                color: TEXT,
                border: `1px solid rgba(255,255,255,0.18)`,
              }}
            >
              {isEdit ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function sameDayEndISO(iso) {
    const d = dayjs(iso);
    return d.hour(23).minute(59).second(59).millisecond(999).toISOString();
  }

function formatLocal(iso) {
  // Return 'YYYY-MM-DDTHH:mm' in local time
  return dayjs(iso).format("YYYY-MM-DDTHH:mm");
}
function fromLocal(local) {
  // Convert local 'YYYY-MM-DDTHH:mm' to ISO with timezone offset
  return dayjs(local).toISOString();
}
