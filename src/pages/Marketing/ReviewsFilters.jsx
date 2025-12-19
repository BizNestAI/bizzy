import React from 'react';

export default function ReviewsFilters({ value, onChange }) {
  const set = (k, v) => onChange({ ...value, [k]: v });

  return (
    <div className="rounded-xl bg-white/5 border border-white/10 p-3 text-sm grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
      <select className="bg-black/40 border border-white/10 rounded px-2 py-1"
              value={value.source || ''} onChange={(e) => set('source', e.target.value || undefined)}>
        <option value="">All Sources</option>
        <option value="google">Google</option>
        <option value="facebook">Facebook</option>
        <option value="yelp">Yelp</option>
      </select>
      <select className="bg-black/40 border border-white/10 rounded px-2 py-1"
              value={value.sentiment || ''} onChange={(e) => set('sentiment', e.target.value || undefined)}>
        <option value="">All Sentiment</option>
        <option value="positive">Positive</option>
        <option value="neutral">Neutral</option>
        <option value="negative">Negative</option>
      </select>
      <select className="bg-black/40 border border-white/10 rounded px-2 py-1"
              value={value.replied ?? ''} onChange={(e) => set('replied', e.target.value === '' ? undefined : e.target.value === 'true')}>
        <option value="">All</option>
        <option value="false">Unreplied</option>
        <option value="true">Replied</option>
      </select>
      <input className="bg-black/40 border border-white/10 rounded px-2 py-1"
             placeholder="Search text…" value={value.q || ''} onChange={(e) => set('q', e.target.value || undefined)} />
    </div>
  );
}
