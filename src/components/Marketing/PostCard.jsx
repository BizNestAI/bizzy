import React, { useState } from 'react';
import { Pencil, Trash2, CalendarCheck, BarChart2, X } from 'lucide-react';
import { deletePostFromGallery } from '../../services/deletePostFromGallery';
import { toTitleCasePlatform } from '../../utils/formatters';

export default function PostCard({ post, onDelete, onEdit, onSchedule, onView }) {
  const { id, caption, platform, category, status, created_at, image_url, metrics_json = {}, source } = post;
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    const { error } = await deletePostFromGallery(id);
    if (!error) onDelete?.();
    setDeleting(false); setShowConfirm(false);
  };

  const badgeColor = { Tip:'bg-blue-500', Promo:'bg-green-500', Testimonial:'bg-yellow-500', 'Before/After':'bg-purple-500', 'Seasonal Offer':'bg-pink-500' }[category] || 'bg-gray-600';
  const engagement = (metrics_json?.likes||0) + (metrics_json?.comments||0) + (metrics_json?.shares||0);

  return (
    <div className="relative bg-gray-900 border border-blue-500/30 rounded-lg overflow-hidden shadow-lg group hover:border-blue-400 transition">
      <div className="w-full h-48 bg-gray-800">
        {image_url ? <img src={image_url} alt="Post visual" className="w-full h-full object-cover" /> :
          <div className="w-full h-full flex items-center justify-center text-sm text-blue-300">{post.imageIdea || 'No image — draft post'}</div>}
      </div>

      <div className="p-3 space-y-2">
        <p className="text-sm text-white line-clamp-3">{caption}</p>
        <div className="flex flex-wrap items-center justify-between text-xs text-blue-300">
          <span>{toTitleCasePlatform(platform) || 'Unspecified'}</span>
          <span>{new Date(created_at).toLocaleDateString()}</span>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className={`px-2 py-1 rounded-full text-xs font-semibold ${badgeColor}`}>{category}</span>
          <span className={`text-xs uppercase tracking-wide ${status==='published'?'text-green-400':status==='scheduled'?'text-yellow-300':'text-gray-400'}`}>{status}</span>
        </div>
        {source==='published' && (
          <div className="flex gap-3 mt-1 text-xs text-blue-300">
            <span>👍 {metrics_json.likes || 0}</span><span>💬 {metrics_json.comments || 0}</span>
            <span>📣 {metrics_json.shares || 0}</span><span>📊 {metrics_json.reach || 0}</span>
          </div>
        )}
      </div>

      <div className="absolute top-2 right-2 hidden group-hover:flex flex-col gap-2">
        <button onClick={onEdit} className="p-1.5 bg-blue-600 hover:bg-blue-700 rounded-full" title="Edit"><Pencil size={16}/></button>
        <button onClick={onSchedule} className="p-1.5 bg-green-600 hover:bg-green-700 rounded-full" title="Schedule"><CalendarCheck size={16}/></button>
        <button onClick={onView} className="p-1.5 bg-yellow-500 hover:bg-yellow-600 rounded-full" title="View Performance"><BarChart2 size={16}/></button>
        <button onClick={()=>setShowConfirm(true)} className="p-1.5 bg-red-600 hover:bg-red-700 rounded-full" title="Delete"><Trash2 size={16}/></button>
      </div>

      {showConfirm && (
        <div className="absolute inset-0 bg-black bg-opacity-80 z-10 flex flex-col justify-center items-center p-4">
          <div className="bg-gray-800 border border-red-500 text-white p-4 rounded-lg shadow-lg max-w-sm w-full">
            <p className="text-sm text-center mb-4">Are you sure you want to delete this post?</p>
            <div className="flex justify-center gap-3">
              <button onClick={handleDelete} disabled={deleting} className="px-4 py-1 bg-red-600 hover:bg-red-700 rounded text-sm font-semibold">{deleting?'Deleting...':'Delete'}</button>
              <button onClick={()=>setShowConfirm(false)} className="px-4 py-1 bg-gray-600 hover:bg-gray-700 rounded text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
