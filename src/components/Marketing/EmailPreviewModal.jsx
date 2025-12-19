import React from 'react';
import { X } from 'lucide-react';

export default function EmailPreviewModal({ subject, body, cta, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-black bg-opacity-80 flex items-center justify-center px-4">
      <div className="w-full max-w-2xl bg-gray-900 text-white rounded-xl border border-blue-500/30 shadow-2xl p-6 relative overflow-y-auto max-h-[90vh]">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1 text-gray-300 hover:text-red-400"
          title="Close preview"
        >
          <X size={20} />
        </button>

        {/* Subject */}
        <h2 className="text-xl font-semibold text-blue-400 mb-2">📧 Email Preview</h2>
        <div className="mb-4">
          <p className="text-sm text-blue-300">Subject Line:</p>
          <p className="text-base font-medium mt-1">{subject}</p>
        </div>

        {/* Body */}
        <div className="mb-4">
          <p className="text-sm text-blue-300 mb-1">Email Body:</p>
          <div className="bg-gray-800 p-4 rounded text-sm whitespace-pre-wrap leading-relaxed border border-blue-500/10">
            {body}
          </div>
        </div>

        {/* CTA */}
        {cta && (
          <div className="mt-4">
            <p className="text-sm text-blue-300 mb-1">Call to Action:</p>
            <span className="inline-block bg-blue-600 text-white px-4 py-2 rounded font-semibold text-sm">
              {cta}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
