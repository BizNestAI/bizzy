import React, { useState } from 'react';
import { X } from 'lucide-react';
import { updatePostSchedule } from '../../services/updatePostSchedule';
import { toUtcIsoFromLocal } from '../../utils/formatters';

export default function SchedulePostModal({ post, onClose, onSave }) {
  const [scheduledAt, setScheduledAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const handleSchedule = async () => {
    if (!scheduledAt) return;
    setSaving(true); setStatusMsg('Scheduling...');
    const utc = toUtcIsoFromLocal(scheduledAt);
    const { error } = await updatePostSchedule({ id: post.id, scheduledAt: utc });
    if (error) setStatusMsg('Failed to schedule post.');
    else { setStatusMsg('Post scheduled!'); onSave?.(); onClose?.(); }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex justify-center items-center p-4">
      <div className="w-full max-w-md bg-gray-900 text-white rounded-xl shadow-lg border border-blue-400 p-6 relative">
        <button className="absolute top-3 right-3 p-1 hover:text-red-400" onClick={onClose} title="Close"><X size={20}/></button>
        <h3 className="text-xl font-semibold text-blue-300 mb-4">Schedule Post</h3>
        <label className="block text-sm mb-1">Publish Date & Time</label>
        <input type="datetime-local" className="w-full bg-gray-800 border border-blue-500/30 p-2 rounded mb-4" value={scheduledAt} onChange={e=>setScheduledAt(e.target.value)} />
        <button onClick={handleSchedule} className="w-full py-2 rounded bg-green-500 hover:bg-green-600 font-bold" disabled={saving}>{saving?'Saving...':'Confirm Schedule'}</button>
        {statusMsg && <p className="text-sm text-blue-300 mt-3">{statusMsg}</p>}
      </div>
    </div>
  );
}
