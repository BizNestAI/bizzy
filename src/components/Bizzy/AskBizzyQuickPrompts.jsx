// File: /src/components/Bizzy/AskBizzyQuickPrompts.jsx
import React, { useState } from 'react';
import { supabase } from '../../services/supabaseClient';

// Curated defaults (feel free to expand)
const CURATED = {
  accounting: [
    { text: 'How did I perform this month?', tooltip: 'Quick breakdown of this month’s P&L trends.' },
    { text: 'Where is most of my profit coming from?', tooltip: 'Highlights top revenue sources.' },
    { text: 'What’s my top expense?', tooltip: 'Identifies largest cost category.' },
    { text: 'How has my cash flow changed since last month?', tooltip: 'Month-over-month cash flow comparison.' },
    { text: 'Do I have any clients behind on payment?', tooltip: 'Checks overdue invoices or AR aging.' },
  ],
  marketing: [
    { text: 'Which marketing channel brought in the most leads this month?', tooltip: 'Best-performing lead source.' },
    { text: 'How did my last email campaign perform?', tooltip: 'Open rate, click-through, conversions.' },
    { text: 'What content got the most engagement last week?', tooltip: 'Top-performing posts by metrics.' },
    { text: 'How many new followers did we gain?', tooltip: 'Follower growth insights.' },
  ],
  tax: [
    { text: 'Am I on track for estimated tax payments?', tooltip: 'Estimated taxes vs current liability.' },
    { text: 'What deductions am I missing?', tooltip: 'AI scan for unclaimed deductions.' },
    { text: 'How much should I save for taxes this month?', tooltip: 'Suggested tax reserve amount.' },
  ],
  investments: [
    { text: 'How is my investment account performing?', tooltip: 'Month-to-date and YTD returns.' },
    { text: 'What’s my current asset allocation?', tooltip: 'Breakdown of portfolio balance.' },
    { text: 'Is my retirement plan on track?', tooltip: 'Projected retirement growth vs goal.' },
  ],
  calendar: [
    { text: 'What’s on my agenda tomorrow?', tooltip: 'Pulls tomorrow’s events.' },
    { text: 'Schedule a job review for Friday 9am', tooltip: 'Creates a calendar event.' },
    { text: 'Add reminder to invoice the client next Monday', tooltip: 'Adds a calendar reminder.' },
  ],
  general: [
    { text: 'What are my top priorities this week?', tooltip: 'AI-generated priority checklist.' },
    { text: 'What’s changed in my business since last month?', tooltip: 'High-level summary of changes.' },
    { text: 'What are my top 3 risks right now?', tooltip: 'AI risk assessment based on data.' },
    { text: 'How can I improve my cash flow?', tooltip: 'Suggestions for cash flow management.' },
    { text: 'What’s my current burn rate?', tooltip: 'Monthly cash burn analysis.' },
  ],
};

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48);
}
function stableKey(module, idx, text) {
  return `${module}-${idx}-${slug(text)}`;
}

/**
 * AskBizzyQuickPrompts (stateless)
 *
 * Props:
 *  - module:        'general' | 'accounting' | 'marketing' | 'tax' | 'investments' | 'calendar'
 *  - prompts?:      Array<{text: string, tooltip?: string}>  // ranked prompts if provided
 *  - onPromptClick: (text: string) => void                   // parent will send the message
 *  - max?:          number (default 4)
 *  - scrollable?:   boolean (default true)
 *  - className?:    string
 *  - chipClassName?:string
 */
function hexToRgbaLocal(hex, alpha = 1) {
  if (!hex || typeof hex !== "string") return hex;
  const clean = hex.replace("#", "");
  const expand = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const value = Number.parseInt(expand, 16);
  if (Number.isNaN(value)) return hex;
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function AskBizzyQuickPrompts({
  module = 'general',
  prompts,
  onPromptClick,
  max = 4,
  scrollable = true,
  className = '',
  chipClassName = '',
  accentColor = null,
}) {
  const moduleKey = String(module).toLowerCase();
  const curated = CURATED[moduleKey] || CURATED.general;
  const list = Array.isArray(prompts) && prompts.length ? prompts : curated;
  const visible = list.slice(0, max);

  // best-effort usage logging; non-blocking
  const logUsage = async (text) => {
    try {
      const user_id = localStorage.getItem('user_id');
      const business_id = localStorage.getItem('currentBusinessId');
      if (!user_id) return;                    // anonymous session: skip
    await supabase.from('prompt_usage').insert([{
      user_id,
      business_id: business_id || null,
      module: moduleKey,
      prompt_text: text,
      created_at: new Date().toISOString(),  // optional but nice to have
    }]);
    } catch {
      // swallow; we never block the UI on usage logging
    }
  };

  const handleClick = async (text) => {
    if (!text) return;
    logUsage(text);
    onPromptClick?.(text);
  };

  const [hoverIdx, setHoverIdx] = useState(null);

  return (
    <div className={`w-full px-2 py-0 ${className}`}>
      {visible.length > 0 && (
        <div
          className={[
            'flex gap-2 pb-1 items-center',
            scrollable ? 'overflow-x-auto no-scrollbar snap-x snap-mandatory' : '',
          ].join(' ')}
          style={{ paddingBottom: 6 }}
        >
          {visible.map((item, idx) => {
            const text = typeof item === 'string' ? item : item.text;
            const tooltip = typeof item === 'string' ? undefined : item.tooltip;
            const isActive = hoverIdx === idx;
            const highlightHex = accentColor || '#f5f6f7';
            return (
              <button
                key={stableKey(moduleKey, idx, text)}
                type="button"
                title={tooltip}
                onClick={() => handleClick(text)}
                onMouseEnter={() => setHoverIdx(idx)}
                onMouseLeave={() => setHoverIdx((prev) => (prev === idx ? null : prev))}
                className={[
                  'inline-flex items-center rounded-full border',
                  'px-3 py-1 text-sm',
                  'transition-all duration-300 ease-out',
                  'snap-start whitespace-nowrap select-none',
                  chipClassName,
                ].join(' ')}
                style={{
                  color: isActive ? highlightHex : 'rgba(255,255,255,0.85)',
                  borderColor: isActive
                    ? hexToRgbaLocal(highlightHex, 0.35)
                    : 'var(--qp-frame, rgba(255,255,255,0.16))',
                  background: 'transparent',
                  boxShadow: 'none',
                }}
              >
                {text}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
