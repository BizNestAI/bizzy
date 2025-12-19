// src/components/email/ThreadHeader.jsx
import React from "react";
import { MailOpen, CheckCircle2, Reply } from "lucide-react";

/**
 * Props:
 * - subject, participantsText, unread
 * - onMarkRead()                 // mark as read
 * - onSummarize?()               // triggers summarize (optional)
 * - summarizing? boolean         // disables "Summarize" while running
 * - summaryAnchorId? string      // default: 'bizzy-thread-summary'
 * - replyAnchorId? string        // default: 'bizzy-reply-composer'
 */
export default function ThreadHeader({
  subject = "(no subject)",
  participantsText = "",
  unread = false,
  onMarkRead,
  onSummarize,
  summarizing = false,
  summaryAnchorId = "bizzy-thread-summary",
  replyAnchorId = "bizzy-reply-composer",
}) {
  const scrollToId = (id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleSummarize = async () => {
    try {
      if (onSummarize) {
        await onSummarize();
        // Give React a beat to render the summary before scrolling
        setTimeout(() => scrollToId(summaryAnchorId), 120);
      } else {
        scrollToId(summaryAnchorId);
      }
    } catch {
      // no-op: keep UI responsive even if summarize throws
    }
  };

  const handleReply = () => scrollToId(replyAnchorId);

  return (
    // sticky header so subject is always visible (inside the column scroller)
    <div className="sticky top-0 z-10 bg-[#0a0b0f]/85 backdrop-blur border-b border-zinc-800 pb-2 mb-3">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg md:text-xl font-semibold text-white break-words">
          {subject}
        </h2>

        <div className="flex items-center gap-2">
          {/* Summarize */}
          <button
            onClick={handleSummarize}
            disabled={summarizing}
            className={`text-xs inline-flex items-center gap-1 px-2 py-1 rounded border ${
              summarizing
                ? "border-zinc-700 text-zinc-500 cursor-not-allowed"
                : "border-cyan-700 text-cyan-300 hover:bg-cyan-600/10"
            }`}
            title="Summarize with Bizzi"
          >
            {summarizing ? "Summarizing…" : "Summarize"}
          </button>

          {/* Jump to Reply composer */}
          <button
            onClick={handleReply}
            className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            title="Jump to reply"
          >
            <Reply size={14} />
            Reply
          </button>

          {/* Mark read */}
          {unread && (
            <button
              onClick={onMarkRead}
              className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded border border-cyan-700 text-cyan-300 hover:bg-cyan-600/10"
              title="Mark thread as read"
            >
              <MailOpen size={14} />
              Mark read
            </button>
          )}
        </div>
      </div>

      {participantsText && (
        <div className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
          <CheckCircle2 size={12} className="text-cyan-400" />
          <span className="truncate">{participantsText}</span>
        </div>
      )}
    </div>
  );
}
