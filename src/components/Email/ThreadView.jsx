// src/components/email/ThreadView.jsx
import React, { useMemo, useState } from "react";
import { Loader2, Paperclip, Link as LinkIcon, Reply, MailOpen, Image as ImageIcon } from "lucide-react";

function processHtml(html, allowImages) {
  if (!html) return "";
  let out = html;

  // Safe links
  out = out.replace(/<a\s/gi, '<a target="_blank" rel="noopener noreferrer" ');

  if (allowImages) {
    // Add safe attrs to IMG tags
    out = out.replace(
      /<img\s/gi,
      '<img loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()" '
    );

    // Strip obvious tracking pixels (1×1 or 2×2) via attributes
    out = out
      .replace(/<img[^>]*\bwidth\s*=\s*["']?\s*[12]\s*["']?[^>]*>/gi, "")
      .replace(/<img[^>]*\bheight\s*=\s*["']?\s*[12]\s*["']?[^>]*>/gi, "")
      // Strip via inline style width/height
      .replace(
        /<img([^>]*)style=["'][^"']*(?:\bwidth\s*:\s*[12]px|\bheight\s*:\s*[12]px)[^"']*["']([^>]*)>/gi,
        "<img$1$2>"
      );
  } else {
    // Images OFF → remove all <img> tags
    out = out.replace(/<img[^>]*>/gi, "");
  }

  return out;
}


/**
 * Props:
 * - thread, loading, error
 * - summary, onSummarize, summarizing
 * - embeddedHeader?: {
 *     subject: string,
 *     participantsText?: string,
 *     unread?: boolean,
 *     onMarkRead?: () => void,
 *     onOpenAutoPanel?: () => void   // optional: open autoresponder drawer
 *   }
 * - children (ReplyComposer)
 * - scrollWithinParent (boolean): if true, do NOT create an internal scroller
 */
export default function ThreadView({
  accountId,
  threadId,
  thread,
  loading,
  error,
  summary,
  onSummarize,
  summarizing,
  embeddedHeader,                 // 👈 new
  children,
  scrollWithinParent = false,
}) {
  const [allowImages, setAllowImages] = useState(true);

  const rendered = useMemo(() => {
  const msgs = thread?.messages || [];
  return msgs.map((m) => ({ ...m, __html: processHtml(m.html, allowImages) }));
 }, [thread, allowImages]);

  const viewAttachment = async (att) => {
    if (!accountId || !threadId || !att?.attachmentId || !att?.messageId) return;
    try {
      const res = await fetch(
        `/api/email/threads/${threadId}/messages/${att.messageId}/attachments/${att.attachmentId}?accountId=${encodeURIComponent(accountId)}`
      );
      if (!res.ok) throw new Error("Attachment fetch failed");
      const { data, mimeType } = await res.json();
      if (!data) throw new Error("No attachment data");
      const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const blob = new Blob([bin], { type: mimeType || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      // open in new tab (works for PDFs/office); also allow download fallback
      window.open(url, "_blank", "noopener,noreferrer");
      const a = document.createElement("a");
      a.href = url;
      a.download = att.filename || "attachment";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 20000);
    } catch (e) {
      console.error("Attachment open failed", e);
      alert("Could not open attachment.");
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-400">
        <Loader2 className="animate-spin mr-2" size={16} /> Loading thread…
      </div>
    );
  }
  if (error)
    return (
      <div className="text-sm text-rose-300 bg-rose-950/40 border border-rose-900 rounded p-3">
        {error}
      </div>
    );
  if (!thread)
    return <div className="text-zinc-500 text-sm">Select an email to view the conversation.</div>;

  // choose container classes based on scroll owner
  const scrollClasses = scrollWithinParent
    ? "space-y-4 pr-1 pb-40"                  // extra bottom pad so composer isn't clipped
    : "space-y-4 pr-1 pb-40 overflow-y-auto flex-1 min-h-0";

  const scrollToId = (id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className={scrollWithinParent ? "" : "h-full flex flex-col"}>
      {/* ======= Embedded sticky header (bigger subject + action buttons) ======= */}
      {embeddedHeader && (
        <div className="sticky top-0 z-10 bg-[#0a0b0f]/85 backdrop-blur border-b border-zinc-800 pt-1 pb-2">
    <div className="mx-auto w-full px-2 max-w-[1100px] xl:max-w-[1280px] 2xl:max-w-[1400px]">
      {/* Row 1: big subject */}
      <h1 className="text-xl md:text-2xl xl:text-[28px] font-semibold text-white leading-snug">
        {embeddedHeader.subject || "(no subject)"}
      </h1>
      {/* Row 2: left-aligned toolbar */}
      <div className="mt-2 flex items-center gap-2 flex-wrap">
                <button
                  onClick={async () => {
                    if (onSummarize) {
                      await onSummarize();
                      setTimeout(() => scrollToId("bizzy-thread-summary"), 120);
                    } else {
                      scrollToId("bizzy-thread-summary");
                    }
                  }}
                  disabled={!!summarizing}
                  className={`text-xs inline-flex items-center gap-1 px-2 py-1 rounded border ${
                    summarizing
                      ? "border-zinc-700 text-zinc-500 cursor-not-allowed"
                      : "border-cyan-700 text-cyan-300 hover:bg-cyan-600/10"
                  }`}
                  title="Summarize with Bizzi"
                >
                  {summarizing ? "Summarizing…" : "Summarize"}
                </button>

                <button
                  onClick={() => scrollToId("bizzy-reply-composer")}
                  className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                  title="Jump to reply"
                >
                  <Reply size={14} />
                  Reply
                </button>

                {/* Autoresponders */}
  {embeddedHeader?.onOpenAutoPanel && (
    <button
      onClick={embeddedHeader.onOpenAutoPanel}
      className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
      title="Open autoresponders"
    >
      {/* a small sparkle icon also works; using unicode to keep bundle lean */}
      <span aria-hidden>⚙️</span>
      Autoresponders
    </button>
  )}


{/* Images Off/On toggle in toolbar */}
  <button
    onClick={() => setAllowImages((v) => !v)}
    className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
    title={allowImages ? "Turn images off" : "Turn images on"}
  >
    <ImageIcon size={14} />
    {allowImages ? "Images off" : "Images on"}
  </button>
                {embeddedHeader.unread && embeddedHeader.onMarkRead && (
                  <button
                    onClick={embeddedHeader.onMarkRead}
                    className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded border border-cyan-700 text-cyan-300 hover:bg-cyan-600/10"
                    title="Mark thread as read"
                  >
                    <MailOpen size={14} />
                    Mark read
                  </button>
                )}
              </div>
      {embeddedHeader.participantsText && (
        <div className="mt-1 text-xs text-zinc-400">{embeddedHeader.participantsText}</div>
      )}
          </div>
        </div>
      )}

      <div className={scrollClasses}>
        {rendered.map((m) => (
          <div
            key={m.id}
            className="rounded-xl border border-zinc-800/80 p-3 bg-gradient-to-br from-[#0c0f14]/90 to-[#0a0c11]/90 shadow-[0_12px_30px_rgba(0,0,0,0.35)]"
          >
            {/* consistent max width for message cards */}
            <div className="mx-auto w-full max-w-[900px]">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-zinc-100">{m.from || "—"}</div>
                <div className="text-[11px] text-zinc-500">
                  {m.date ? new Date(m.date).toLocaleString() : ""}
                </div>
              </div>
              {m.subject && <div className="text-xs text-zinc-400 mt-0.5">{m.subject}</div>}

              <div
                className="prose prose-invert max-w-none text-sm mt-2 [&_a]:underline [&_a]:decoration-cyan-400/60 [&_a]:decoration-2 [&_a:hover]:text-cyan-300"
                dangerouslySetInnerHTML={{ __html: m.__html || "" }}
              />

              {!!(m.attachments || []).length && (
                <div className="mt-2 text-xs text-zinc-300 flex items-center gap-2 flex-wrap">
                  <Paperclip size={14} className="text-zinc-400" />
                  {m.attachments.map((a, i) => (
                    <button
                      key={i}
                      onClick={() => viewAttachment(a)}
                      className="px-2 py-0.5 rounded border border-zinc-700 bg-zinc-900 inline-flex items-center gap-1 hover:border-cyan-700 hover:text-cyan-200 transition"
                      type="button"
                      title={a.mimeType}
                    >
                      <LinkIcon size={12} className="opacity-70" />
                      <span className="truncate max-w-[180px]">{a.filename || "attachment"}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {/* ⬇️ Smooth-scroll anchor for summary */}
        <div
          id="bizzy-thread-summary"
          className="border border-zinc-800 rounded-2xl p-3 md:p-4 bg-gradient-to-br from-[#0f1119]/90 to-[#0b0d14]/90 shadow-[0_14px_36px_rgba(0,0,0,0.38)]"
        >
          <div className="mx-auto w-full max-w-[1100px] space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-zinc-200">Thread summary</div>
              {onSummarize && (
                <button
                  onClick={onSummarize}
                  disabled={!!summarizing}
                  className={`text-xs px-3 py-1 rounded-full border transition ${
                    summarizing
                      ? "border-zinc-700 text-zinc-500 cursor-not-allowed"
                      : "border-cyan-700 text-cyan-300 hover:text-white hover:bg-cyan-600/10"
                  }`}
                >
                  {summarizing ? (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 size={14} className="animate-spin" /> Summarizing…
                    </span>
                  ) : (
                    "Summarize with Bizzi"
                  )}
                </button>
              )}
            </div>
            <div className="text-sm text-zinc-200 whitespace-pre-wrap leading-relaxed">
              {summary || "—"}
            </div>
          </div>
        </div>

        {children && (
          <div
            id="bizzy-reply-composer"
            className="border border-zinc-800 rounded-2xl p-3 md:p-4 bg-gradient-to-br from-[#0f1119]/90 to-[#0b0d14]/90 shadow-[0_14px_36px_rgba(0,0,0,0.38)]"
          >
            {children}
          </div>
        )}
      </div>
      <div className="h-24" /> {/* spacer for BizzyChatBar */}
    </div>
  );
}
