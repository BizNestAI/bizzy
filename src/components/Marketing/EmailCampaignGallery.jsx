import React, { useEffect, useState } from 'react';
import { useUser } from '@supabase/auth-helpers-react';
import { fetchEmailCampaigns } from '../../services/fetchEmailCampaigns';
import { updateEmailCampaign } from '../../services/updateEmailCampaigns';
import { Trash2, Pencil, X } from 'lucide-react';
import { deleteEmailCampaign } from '../../services/deleteEmailCampaign';

export default function EmailCampaignGallery({ businessId }) {
  const user = useUser();
  const [campaigns, setCampaigns] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);

  const loadCampaigns = async () => {
    const { data } = await fetchEmailCampaigns(user?.id, businessId);
    setCampaigns(data || []);
  };

  useEffect(()=>{ if(user && businessId) loadCampaigns(); }, [user, businessId]);

  useEffect(()=> {
    const lower = (search||'').toLowerCase();
    const f = (campaigns||[]).filter(c=>{
      const ct = (c.campaign_type||'').toLowerCase();
      const subj = (c.subject_line||'').toLowerCase();
      const body = (c.body||'').toLowerCase();
      return ct.includes(lower) || subj.includes(lower) || body.includes(lower);
    });
    setFiltered(f);
  }, [campaigns, search]);

  const handleUpdate = async () => {
    const { error } = await updateEmailCampaign(editing);
    if (!error) { await loadCampaigns(); setEditing(null); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this campaign?')) return;
    const { error } = await deleteEmailCampaign(id);
    if (!error) await loadCampaigns();
  };

  return (
    <div className="w-full max-w-6xl mx-auto p-4 text-white">
      <h2 className="text-2xl font-semibold text-blue-400 mb-4">📬 Your Email Campaigns</h2>
      <input type="text" placeholder="Search by campaign type or subject..." className="mb-4 p-2 w-full rounded bg-gray-800 border border-blue-500/30" value={search} onChange={e=>setSearch(e.target.value)} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map((c)=>(
          <div key={c.id} className="bg-gray-900 border border-blue-500/20 rounded p-4 relative shadow hover:border-blue-400">
            <div className="absolute top-2 right-2 flex gap-2">
              <button onClick={()=>setEditing(c)} className="text-blue-300 hover:text-white" title="Edit"><Pencil size={16}/></button>
              <button onClick={()=>handleDelete(c.id)} className="text-red-400 hover:text-white" title="Delete"><Trash2 size={16}/></button>
            </div>
            <p className="text-xs text-blue-300">{c.campaign_type}</p>
            <p className="font-bold text-base mb-2">{c.subject_line}</p>
            <p className="text-sm text-white line-clamp-4 whitespace-pre-wrap">{c.body}</p>
            {c.cta && <div className="mt-2 text-xs text-blue-400">CTA: <span className="font-semibold">{c.cta}</span></div>}
          </div>
        ))}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 bg-black bg-opacity-80 flex items-center justify-center px-4">
          <div className="w-full max-w-2xl bg-gray-900 text-white rounded-xl border border-blue-500/30 shadow-2xl p-6 relative overflow-y-auto max-h-[90vh]">
            <button onClick={()=>setEditing(null)} className="absolute top-4 right-4 p-1 text-gray-300 hover:text-red-400" title="Close edit"><X size={20}/></button>
            <h3 className="text-xl font-semibold text-blue-300 mb-4">Edit Campaign</h3>
            <div className="space-y-4">
              <div><label className="text-sm mb-1 block">Subject</label>
                <input type="text" className="w-full p-2 rounded bg-gray-800 border border-blue-500/30" value={editing.subject_line||''} onChange={e=>setEditing({...editing, subject_line: e.target.value})} />
              </div>
              <div><label className="text-sm mb-1 block">Body</label>
                <textarea rows={6} className="w-full p-2 rounded bg-gray-800 border border-blue-500/30" value={editing.body||''} onChange={e=>setEditing({...editing, body: e.target.value})} />
              </div>
              <div><label className="text-sm mb-1 block">Call to Action (CTA)</label>
                <input type="text" className="w-full p-2 rounded bg-gray-800 border border-blue-500/30" value={editing.cta||''} onChange={e=>setEditing({...editing, cta: e.target.value})} />
              </div>
              <button onClick={handleUpdate} className="w-full py-2 bg-green-600 hover:bg-green-700 rounded font-bold">Save Changes</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
