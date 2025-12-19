import React, { useState } from 'react';

export default function CSVImportDialog({ open, onClose, businessId }) {
  const [text, setText] = useState('');

  if (!open) return null;

  const onImport = async () => {
    const base64 = btoa(text);
    await fetch('/api/reviews/import/csv', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ business_id: businessId, csv_base64: base64 })
    });
    onClose?.();
  };

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose}/>
      <div className="absolute left-1/2 -translate-x-1/2 top-20 w-[95%] max-w-2xl bg-[#0A0B0E] border border-white/10 rounded-xl p-4">
        <div className="font-semibold mb-2">Import CSV</div>
        <p className="text-sm text-white/70 mb-2">Paste CSV with header: <code>source,external_review_id,rating,author_name,body,created_at_utc</code></p>
        <textarea className="w-full h-56 bg-white/5 border border-white/10 rounded p-2 text-sm"
                  value={text} onChange={(e)=>setText(e.target.value)} />
        <div className="mt-2 flex gap-2">
          <button onClick={onImport} className="px-3 py-1.5 rounded border border-[color:#3B82F6] text-[color:#3B82F6] text-sm">Import</button>
          <button onClick={onClose} className="px-3 py-1.5 rounded border border-white/15 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}
