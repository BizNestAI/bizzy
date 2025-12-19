// src/components/email/InboxList.jsx
import React from "react";
import { RefreshCcw, Loader2 } from "lucide-react";

function EmailRow({ item, selected, onClick }) {
  const time = item.last_message_ts
    ? new Date(item.last_message_ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

  return (
    <button
      onClick={onClick}
      className={[
        "w-full text-left rounded-lg border transition-colors px-3 py-2",
        selected
          ? "bg-zinc-900/70 border-cyan-700/60 ring-1 ring-cyan-600/30 shadow-[0_0_16px_rgba(34,211,238,0.15)]"
          : "bg-transparent border-transparent hover:bg-zinc-900/40 hover:translate-x-[1px] transition-transform"
      ].join(" ")}
    >
      <div className="flex items-center justify-between">
        <div className="font-semibold truncate max-w-[70%] text-zinc-100">
          {item.from_name || item.from_email || "Unknown"}
        </div>
        <div className="text-[11px] text-zinc-400">{time}</div>
      </div>

      <div className="mt-0.5 text-[13px] truncate text-zinc-200">
        {item.subject || "(no subject)"}
      </div>

      <div className="text-[12px] text-zinc-500 truncate">{item.snippet || ""}</div>

      {item.unread && (
        <span className="inline-block mt-1 w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_8px_#22d3ee]" />
      )}
    </button>
  );
}

export default function InboxList({
  items = [],
  loading = false,
  error = null,
  selectedId = null,
  onSelect,
  onLoadMore,
  hasMore = false,
  onRefresh,
  headerLabel = "Inbox",
}) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-2 px-2">
        <div className="text-sm font-semibold text-zinc-200">{headerLabel}</div>

        {/* ✅ Explicit click, guarded, disabled while loading, with spinner */}
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRefresh && onRefresh(); }}
          disabled={loading}
          title="Refresh inbox (r)"
          className={`inline-flex items-center gap-1 text-xs rounded px-2 py-1
            ${loading
              ? "text-zinc-500 border border-zinc-700 cursor-not-allowed"
              : "text-zinc-300 hover:text-white border border-zinc-700 hover:bg-zinc-800"}
          `}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCcw size={14} />}
          Refresh
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-1 no-scrollbar pr-1">
        {error && (
          <div className="mx-2 text-xs text-rose-300 bg-rose-950/40 border border-rose-900 rounded p-2">
            {error}
          </div>
        )}

        {loading && items.length === 0 && (
          <div className="flex items-center justify-center h-32 text-zinc-400">
            <Loader2 size={16} className="mr-2 animate-spin" /> Loading threads…
          </div>
        )}

        {items.map((it) => (
          <EmailRow
            key={it.threadId}
            item={it}
            selected={selectedId === it.threadId}
            onClick={() => onSelect?.(it.threadId)}
          />
        ))}

        {hasMore && (
          <button
            onClick={onLoadMore}
            className="w-full mt-2 text-center text-sm py-2 rounded bg-zinc-900/50 hover:bg-zinc-900 text-zinc-100 border border-zinc-800"
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
}
