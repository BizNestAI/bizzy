// src/components/email/ActivityDrawer.jsx
import React, { useEffect, useState } from "react";
import { X, Loader2 } from "lucide-react";

/**
 * Props: open, onClose, accountId
 */
export default function ActivityDrawer({ open, onClose, accountId }) {
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || !accountId) return;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/email/activity?accountId=${encodeURIComponent(accountId)}`);
        if (!r.ok) throw new Error("Failed to load activity");
        const json = await r.json();
        setLogs(json.items || []);
      } catch (e) {
        console.error(e);
        setError(e.message || "Error loading activity");
      } finally {
        setLoading(false);
      }
    })();
  }, [open, accountId]);

  return (
    <div className={`fixed inset-0 z-40 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      {/* backdrop */}
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      {/* panel */}
      <div
        className={`absolute right-0 top-0 h-full w-full max-w-md bg-[#0a0b0f] border-l border-zinc-800
        transition-transform ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center justify-between p-3 border-b border-zinc-800">
          <div className="text-sm font-semibold text-zinc-200">Bizzy Email Activity</div>
          <button onClick={onClose} className="text-zinc-300 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="p-3 h-[calc(100%-44px)] overflow-y-auto space-y-2">
          {loading && (
            <div className="flex items-center text-zinc-400">
              <Loader2 size={16} className="animate-spin mr-2" /> Loading…
            </div>
          )}
          {error && <div className="text-xs text-rose-400">{error}</div>}

          {logs.length === 0 && !loading && (
            <div className="text-sm text-zinc-400">No recent activity.</div>
          )}

          {logs.map((log) => (
            <div key={log.id} className="rounded border border-zinc-800 p-2 bg-zinc-950/50">
              <div className="text-[11px] text-zinc-500">
                {new Date(log.created_at).toLocaleString()}
              </div>
              <div className="text-sm text-zinc-100 font-medium mt-1">{log.action}</div>
              {log.payload && (
                <pre className="text-xs text-zinc-300 whitespace-pre-wrap mt-1">
                  {JSON.stringify(log.payload, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
