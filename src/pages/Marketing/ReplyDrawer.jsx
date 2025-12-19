import React, { useEffect, useState } from 'react';

export default function ReplyDrawer({ open, review, onClose, onSent, businessId }) {
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!open || !review) return;
    const t = review.themes || [];
    setDraft(buildDraft(review.rating, t, review.body, review.author_name));
  }, [open, review]);

  if (!open || !review) return null;

  const send = async () => {
    const r = await fetch(`/api/reviews/${review.id}/reply`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ draft_text: draft, business_id: businessId })
    });
    const json = await r.json();
    const data = json?.data || json; // support old path
    if (data?.fallback) window.location.href = data.fallback;
    onSent?.();
  };

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full sm:w-[480px] bg-[#0A0B0E] border-l border-white/10 p-4">
        <div className="font-semibold mb-2">Reply to Review</div>
        <textarea value={draft} onChange={(e)=>setDraft(e.target.value)} className="w-full h-40 bg-white/5 border border-white/10 rounded p-2 text-sm" />
        <div className="mt-2 flex items-center gap-2">
          <button onClick={send} className="px-3 py-1.5 rounded border border-[color:#3B82F6] text-[color:#3B82F6] text-sm">Send via Email</button>
          <button onClick={onClose} className="px-3 py-1.5 rounded border border-white/15 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}

export function buildDraft(rating, themes=[], body, name) {
  const mention = themes?.length ? ` (re: ${themes.slice(0,2).join(' & ')})` : '';
  if (rating >= 5) return `Hi ${name||'there'}, thanks for the 5-star review!${mention} We loved working with you.`;
  if (rating === 4) return `Hi ${name||'there'}, thanks for the great review!${mention} If there’s anything we can improve, let us know.`;
  if (rating === 3) return `Hi ${name||'there'}, thanks for the feedback.${mention} We want to make this right—could we connect?`;
  return `Hi ${name||'there'}, we’re sorry about your experience.${mention} Please contact us so we can address this immediately.`;
}
