import React, { useState } from 'react';
import { useUser } from '@supabase/auth-helpers-react';
import { saveEmailCampaign } from '../../services/saveEmailCampaign';
import EmailPreviewModal from './EmailPreviewModal';
import { apiFetch } from '../../utils/api';

const campaignTypes = ['Newsletter','Promo Offer','Testimonial/Review Request','Follow-Up with Lead','Job Completion Thank You','Re-engagement / “We Miss You”'];

export default function EmailCampaignBuilder({ businessId }) {
  const user = useUser();
  const [campaignType, setCampaignType] = useState('');
  const [customNotes, setCustomNotes] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [cta, setCTA] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [isMock, setIsMock] = useState(false);

  const handleGenerate = async () => {
    if (!campaignType) return;
    setLoading(true); setStatusMessage('Generating email...');
    const { data, error, meta } = await apiFetch('/api/marketing/email/generate', {
      method: 'POST', body: { campaignType, notes: customNotes }
    });
    if (error) setStatusMessage('Failed to generate email.');
    else { setSubject(data.subject||''); setBody(data.body||''); setCTA(data.cta||''); setStatusMessage('Generated!'); setIsMock(!!meta?.is_mock); }
    setLoading(false);
  };

  const handleSave = async () => {
    if (!subject || !body) return;
    const { error } = await saveEmailCampaign({ userId: user.id, businessId, campaignType, subject, body, cta });
    setStatusMessage(error ? 'Failed to save.' : 'Saved as draft!');
  };

  return (
    <div className="w-full max-w-2xl mx-auto p-4 rounded-xl bg-gray-900 text-white shadow-lg border border-blue-500/30">
      <h2 className="text-2xl font-semibold text-blue-400 mb-2">✉️ Email Campaign Builder</h2>
      {isMock && <div className="text-xs text-blue-300 mb-2">Showing sample output until accounts are connected.</div>}

      <div className="space-y-4">
        <div><label className="block text-sm mb-1">Campaign Type</label>
          <select value={campaignType} onChange={e=>setCampaignType(e.target.value)} className="w-full p-2 rounded bg-gray-800 border border-blue-500/30">
            <option value="">Select</option>{campaignTypes.map((t)=>(<option key={t}>{t}</option>))}
          </select>
        </div>

        <div><label className="block text-sm mb-1">Optional Notes or Promo Details</label>
          <textarea rows={2} className="w-full p-2 rounded bg-gray-800 border border-blue-500/30" value={customNotes} onChange={e=>setCustomNotes(e.target.value)} placeholder="e.g. 10% off this week, client name, job performed..." />
        </div>

        <button onClick={handleGenerate} className="w-full py-2 rounded bg-blue-500 hover:bg-blue-600 transition font-bold" disabled={loading}>
          {loading ? 'Generating…' : 'Generate Email'}
        </button>

        {subject && (
          <>
            <div><label className="block text-sm mb-1">Subject Line</label>
              <input type="text" className="w-full p-2 rounded bg-gray-800 border border-blue-500/30" value={subject} onChange={e=>setSubject(e.target.value)} />
            </div>
            <div><label className="block text-sm mb-1">Email Body</label>
              <textarea rows={8} className="w-full p-2 rounded bg-gray-800 border border-blue-500/30" value={body} onChange={e=>setBody(e.target.value)} />
            </div>
            <div><label className="block text-sm mb-1">Call to Action (CTA)</label>
              <input type="text" className="w-full p-2 rounded bg-gray-800 border border-blue-500/30" value={cta} onChange={e=>setCTA(e.target.value)} />
            </div>

            <div className="flex gap-4 mt-3">
              <button onClick={()=>setPreviewOpen(true)} className="flex-1 py-2 bg-indigo-500 hover:bg-indigo-600 rounded font-bold">Preview</button>
              <button onClick={handleSave} className="flex-1 py-2 bg-green-500 hover:bg-green-600 rounded font-bold">Save Draft</button>
            </div>
          </>
        )}

        {statusMessage && <p className="text-sm text-blue-300 mt-2">{statusMessage}</p>}
      </div>

      {previewOpen && <EmailPreviewModal subject={subject} body={body} cta={cta} onClose={()=>setPreviewOpen(false)} />}
    </div>
  );
}
