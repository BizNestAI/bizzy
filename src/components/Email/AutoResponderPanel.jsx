// src/components/email/AutoResponderPanel.jsx
import React, { useMemo } from "react";
import useAutoResponderRules from "../../hooks/email/useAutoResponderRules";
// import Meerkat from "../../assets/Bizzy-Logo.jpg";
import bizzyHero from "../../assets/bizzy-hero.png"; // ⬅️ same asset used in MainLayout
import { Loader2 } from "lucide-react";

// tiny util (same behavior as your MainLayout helper)
const hexToRgba = (hex, a = 1) => {
  const m = hex.replace("#", "");
  const bigint = parseInt(m, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

export default function AutoResponderPanel({ accountId }) {
  const { rules, loading, saving, error, saveRule } = useAutoResponderRules({ accountId });

  const ruleMap = useMemo(() => {
    const map = new Map();
    (rules || []).forEach((r) => map.set(r.rule_type, r));
    return map;
  }, [rules]);

  const toggles = [
    { key: "estimate", label: "Customer asks for estimate", hint: "Send booking link" },
    { key: "payment_received", label: "Receipt received", hint: "Respond with payment confirmation" },
    { key: "scheduling", label: "Scheduling request", hint: "Reply with available time slots" },
    { key: "missing_attachment", label: "Attachment missing", hint: "Request the missing file(s)" },
  ];

  const onToggle = async (key, enabled) => {
    const existing = ruleMap.get(key);
    await saveRule({
      id: existing?.id,
      accountId,
      rule_type: key,
      enabled,
      trigger: existing?.trigger || {},
      template_body: existing?.template_body || "",
      template_subject: existing?.template_subject || "",
    });
  };

  const accent = "#FF4EEB"; // Bizzy pink; swap per module if desired

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="flex items-center gap-2 mb-2">
        {/* Neon avatar (matches MainLayout) */}
        <div
          className="group relative h-6 w-6 rounded-full overflow-hidden shrink-0"
          style={{
            boxShadow: `
              0 0 2px ${hexToRgba(accent, 0.45)},
              0 0 10px ${hexToRgba(accent, 0.50)}
            `,
            border: `1px solid ${hexToRgba(accent, 0.35)}`,
          }}
        >
          <img
            src={bizzyHero}
            alt="Bizzi avatar"
            className="h-full w-full object-cover rounded-full select-none"
            draggable="false"
          />
        </div>

        <div className="text-sm font-semibold text-zinc-200">How should I handle autoresponders?</div>
      </div>

      {error && <div className="text-xs text-rose-400 mb-2">{error}</div>}
      {(loading || saving) && (
        <div className="text-xs text-zinc-400 inline-flex items-center gap-1 mb-2">
          <Loader2 size={14} className="animate-spin" /> Saving…
        </div>
      )}

      <div className="space-y-2">
        {toggles.map((t) => {
          const enabled = ruleMap.get(t.key)?.enabled ?? false;
          return (
            <div
              key={t.key}
              className="flex items-center justify-between border border-zinc-800 rounded-md px-2 py-2 bg-zinc-950/40"
            >
              <div>
                <div className="text-sm text-zinc-200">{t.label}</div>
                <div className="text-xs text-zinc-400">{t.hint}</div>
              </div>
              <label className="inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!enabled}
                  onChange={(e) => onToggle(t.key, e.target.checked)}
                  className="peer sr-only"
                />
                <div className="w-10 h-5 bg-zinc-700 rounded-full peer-checked:bg-cyan-500 transition-colors relative">
                  <div className="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full peer-checked:translate-x-5 transition-transform" />
                </div>
              </label>
            </div>
          );
        })}
      </div>

      <div className="text-[11px] text-zinc-500 mt-3">
        * In MVP, these are saved as preferences. Auto-send can be enabled later.
      </div>
    </div>
  );
}
