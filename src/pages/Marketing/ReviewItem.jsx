import React from 'react';
import { Star, MessageCircle } from 'lucide-react';

export default function ReviewItem({ review, onReply }) {
  const stars = Array.from({ length: 5 }, (_, i) => i < Math.round(review.rating || 0));
  const date = review.created_at_utc ? new Date(review.created_at_utc).toLocaleString() : '—';
  const author = review.author_name || 'Anonymous';
  const sentiment = review.rating >= 4 ? 'Positive' : review.rating <= 2 ? 'Negative' : 'Neutral';

  return (
    <div className="rounded-[26px] border border-white/12 bg-gradient-to-br from-white/[0.05] via-white/[0.02] to-transparent p-4 shadow-[0_18px_50px_rgba(0,0,0,0.45)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 text-sm text-white/70">
          <span className="px-3 py-1 rounded-full bg-black/40 border border-white/10 capitalize">{review.source || 'Unknown'}</span>
          <div className="flex items-center gap-1">
            {stars.map((full, i) => (
              <Star
                key={i}
                size={15}
                className={full ? 'text-yellow-400 drop-shadow-[0_0_6px_rgba(250,204,21,0.55)]' : 'text-white/20'}
                fill={full ? 'currentColor' : 'none'}
              />
            ))}
            <span className="text-white/60">{review.rating?.toFixed?.(1) || review.rating || '—'}</span>
          </div>
          <span className="text-[12px] text-white/55">{date}</span>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/10 border border-white/10">
            {sentiment}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {review.job_id && (
            <span className="text-[11px] text-white/55">Job #{review.job_id}</span>
          )}
          {!review.owner_replied && (
            <button
              onClick={onReply}
              className="inline-flex items-center gap-1 text-xs px-3 py-1 rounded-full border border-white/20 bg-white/8 hover:bg-white/12"
            >
              <MessageCircle size={12} /> Reply
            </button>
          )}
        </div>
      </div>

      <p className="mt-3 text-[15px] text-white leading-relaxed whitespace-pre-wrap">{review.body}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-white/60">
        <span>— {author}</span>
        {Array.isArray(review.themes) && review.themes.length > 0 && (
          review.themes.map((theme) => (
            <span key={theme} className="px-2 py-0.5 rounded-full bg-white/10 border border-white/10 text-white/70">
              #{theme}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
