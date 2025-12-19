// src/components/email/ReplyComposer.jsx
import React, { useState } from "react";
import { Loader2, Wand2, Send } from "lucide-react";
import useEmailDraftWithBizzy from "../../hooks/email/useEmailDraftWithBizzy";
import useEmailSend from "../../hooks/email/useEmailSend";

/**
 * Props: accountId, threadId, defaultTone, onSent()
 */
export default function ReplyComposer({ accountId, threadId, defaultTone = "professional", onSent }) {
  const [body, setBody] = useState("");
  const [prompt, setPrompt] = useState("");
  const [tone, setTone] = useState(defaultTone);
  const { draftWithBizzy, drafting, error: draftError } = useEmailDraftWithBizzy();
  const { send, sending, error: sendError } = useEmailSend();

  const handleDraft = async () => {
    if (!accountId || !threadId) return;
    const text = await draftWithBizzy({ accountId, threadId, prompt, tone });
    setBody(text || "");
  };

  const handleSend = async () => {
    if (!body.trim()) return;
    await send({ accountId, to: undefined, subject: "", body, threadId });
    setBody("");
    setPrompt("");
    onSent?.();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col md:flex-row md:items-center gap-2">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Tell Bizzi what to include (e.g., confirm Friday, mention $4,000 invoice)"
          className="flex-1 px-3 py-2 rounded-md bg-[#0b0d14] border border-zinc-800 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-cyan-500/70"
        />
        <div className="flex items-center gap-2">
          <select
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            className="px-2 py-2 rounded-md bg-[#0b0d14] border border-zinc-800 text-xs text-zinc-300"
          >
            <option value="professional">Professional</option>
            <option value="friendly">Friendly</option>
            <option value="direct">Direct</option>
          </select>
          <button
            onClick={handleDraft}
            disabled={drafting}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-md border border-cyan-700 text-cyan-300 hover:bg-cyan-600/10 disabled:opacity-50"
          >
            {drafting ? <Loader2 className="animate-spin" size={16} /> : <Wand2 size={16} />}
            Draft
          </button>
        </div>
      </div>

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        placeholder="Bizzi's draft will appear here. Edit as needed before sending."
        className="w-full px-3 py-2 rounded-md bg-[#0b0d14] border border-zinc-800 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-cyan-500/70"
      />

      {(draftError || sendError) && (
        <div className="text-xs text-rose-400">{draftError || sendError}</div>
      )}

      <div className="flex justify-end">
        <button
          onClick={handleSend}
          disabled={sending || !body.trim()}
          className="inline-flex items-center gap-1 px-4 py-2 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-50"
        >
          {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          Send
        </button>
      </div>
    </div>
  );
}
