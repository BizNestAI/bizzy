import React, { useState } from 'react';
import { X } from 'lucide-react';
import { updatePostInGallery } from '../../services/updatePostInGallery';

const postTypes = ['Tip','Promo','Testimonial','Before/After','Seasonal Offer'];
const platforms = ['Instagram','Facebook'];

export default function EditPostModal({ post, onClose, onSave }) {
  const [caption, setCaption] = useState(post.caption||'');
  const [category, setCategory] = useState(post.category||'');
  const [cta, setCta] = useState(post.cta||'');
  const [imageIdea, setImageIdea] = useState(post.imageIdea||'');
  const [platform, setPlatform] = useState((post.platform||'').replace(/^\w/,c=>c.toUpperCase()));
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const handleSave = async () => {
    setSaving(true); setStatusMsg('Saving...');
    const { error } = await updatePostInGallery({
      id: post.id, caption, category, cta, imageIdea, platform: platform.toLowerCase(),
    });
    if (error) setStatusMsg('Failed to save.');
    else { setStatusMsg('Saved!'); onSave?.(); onClose?.(); }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex justify-center items-center p-4">
      <div className="w-full max-w-xl bg-gray-900 text-white rounded-xl shadow-lg border border-blue-400 p-6 relative">
        <button className="absolute top-3 right-3 p-1 hover:text-red-400" onClick={onClose} title="Close"><X size={20}/></button>
        <h3 className="text-xl font-semibold text-blue-300 mb-4">Edit Post</h3>

        <div className="space-y-4">
          <div><label className="block text-sm mb-1">Caption</label>
            <textarea className="w-full bg-gray-800 border border-blue-500/30 p-2 rounded" rows={4} value={caption} onChange={e=>setCaption(e.target.value)} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-sm mb-1">Post Type</label>
              <select className="w-full bg-gray-800 border border-blue-500/30 p-2 rounded" value={category} onChange={e=>setCategory(e.target.value)}>
                <option value="">Select</option>{postTypes.map((t)=>(<option key={t}>{t}</option>))}
              </select>
            </div>
            <div><label className="block text-sm mb-1">Platform</label>
              <select className="w-full bg-gray-800 border border-blue-500/30 p-2 rounded" value={platform} onChange={e=>setPlatform(e.target.value)}>
                <option value="">Select</option>{platforms.map((p)=>(<option key={p}>{p}</option>))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-sm mb-1">Call to Action (CTA)</label>
              <input className="w-full bg-gray-800 border border-blue-500/30 p-2 rounded" value={cta} onChange={e=>setCta(e.target.value)} />
            </div>
            <div><label className="block text-sm mb-1">Image Idea</label>
              <input className="w-full bg-gray-800 border border-blue-500/30 p-2 rounded" value={imageIdea} onChange={e=>setImageIdea(e.target.value)} />
            </div>
          </div>

          <button onClick={handleSave} className="w-full py-2 rounded bg-blue-500 hover:bg-blue-600 transition font-bold" disabled={saving}>{saving?'Saving...':'Save Changes'}</button>
          {statusMsg && <p className="text-sm text-blue-300 mt-2">{statusMsg}</p>}
        </div>
      </div>
    </div>
  );
}
