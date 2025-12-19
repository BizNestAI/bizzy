// /src/insights/ToastPortal.jsx
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export default function ToastPortal() {
  const [el] = useState(() => document.createElement('div'));
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    el.style.position = 'fixed';
    el.style.top = '12px';
    el.style.right = '12px';
    el.style.zIndex = 50;
    document.body.appendChild(el);

    const handler = (e) => {
      const toast = e.detail; // { title, body, module, severity }
      setToasts((t) => [...t, { id: crypto.randomUUID(), ...toast }]);
      setTimeout(() => setToasts((t) => t.slice(1)), 3500);
    };
    window.addEventListener('bizzy:toast', handler);
    return () => {
      document.body.removeChild(el);
      window.removeEventListener('bizzy:toast', handler);
    };
  }, [el]);

  return createPortal(
    <div className="space-y-2">
      {toasts.map(t => (
        <div key={t.id} className="rounded-lg bg-black/80 border border-white/10 px-3 py-2 shadow-lg">
          <div className="font-semibold">{t.title}</div>
          {t.body && <div className="text-sm text-white/80">{t.body}</div>}
        </div>
      ))}
    </div>,
    el
  );
}
