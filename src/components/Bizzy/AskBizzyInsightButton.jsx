// File: /src/components/Bizzy/AskBizzyInsightButton.jsx
import React, { useState, useRef } from 'react';
import { MessageCircle } from 'lucide-react';
import { Brain as PhBrain } from "@phosphor-icons/react";
import { motion, AnimatePresence } from 'framer-motion';
import useOutsideClick from '../../hooks/useOutsideClick';
import { useAuth } from '../../context/AuthContext';
import MarkdownRenderer from './MarkdownRenderer';

/**
 * Backward compatible AskBizzy button with two modes:
 *
 * 1) Card mode (default): shows a small icon button and opens a popover with GPT response.
 *    - props: metric, value, previousValue (existing behavior)
 *
 * 2) Inline mode (compact): fires a message to parent (chat) or API, with no popover UI.
 *    - props:
 *        variant="inline"
 *        message="Explain how Vehicle Expenses can reduce my tax bill."
 *        context={{ category: 'Vehicle Expenses' }}
 *        onAskExternal?: (message, context) => void   // forward to chat if provided
 *        size?: 'xs' | 'sm' | 'md'  (default 'xs')
 *        label?: string (default hidden on small screens)
 *        className?: string
 */
const AskBizzyInsightButton = ({
  // legacy props (card mode)
  metric,
  value,
  previousValue,

  // new props (inline mode)
  variant = 'card',                 // 'card' | 'inline'
  message,
  context,
  onAskExternal,                    // optional: forward to chat
  size = 'xs',
  label = 'Ask Bizzi',
  className = '',
  showIcon = true,
  labelAlwaysVisible = false,
  IconComponent = MessageCircle,
}) => {
  const isInline = variant === 'inline';

  const [open, setOpen] = useState(false);
  const [response, setResponse] = useState('');
  const [loading, setLoading] = useState(false);
  const panelRef = useRef(null);
  const { user } = useAuth();

  useOutsideClick(panelRef, () => setOpen(false));

  const API_BASE = import.meta.env?.VITE_API_BASE || ''; // use Vite proxy if empty
  const businessId = localStorage.getItem('currentBusinessId') || null;

  const btnSize =
    size === 'xs' ? 'h-6 px-2 text-[10px]'
    : size === 'sm' ? 'h-7 px-2.5 text-[11px]'
    : 'h-8 px-3 text-sm';

  const iconSize =
    size === 'xs' ? 14
    : size === 'sm' ? 16
    : 18;

  const baseBtnCls = [
    'inline-flex items-center rounded-full border transition',
    'border-yellow-500/25 text-yellow-100/90 hover:border-yellow-300 hover:text-yellow-200',
    'bg-white/[0.03] backdrop-blur-sm',
    btnSize,
    className,
  ].join(' ');

  const parseJsonOrThrow = async (res) => {
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    if (!ct.includes('application/json')) throw new Error(`Non-JSON (${ct}): ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { throw new Error('Unexpected server response.'); }
  };

  // Unified handler that supports both modes
  const handleAsk = async () => {
    if (loading) return;

    // If an external handler is provided (e.g., forward to chat), prefer that in inline mode
    if (isInline && typeof onAskExternal === 'function' && message) {
      onAskExternal(message, context || {});
      return;
    }

    // Otherwise, use the built-in API flow (popover)
    setOpen(true);
    setLoading(true);
    setResponse('');

    const prompt = message
      ? message
      : previousValue
        ? `Explain why ${metric} is ${value} this month compared to ${previousValue} last month. Suggest 1–2 ways to improve.`
        : `Explain why ${metric} is ${value} this month. Suggest 1–2 ways to improve.`;

    const payload = {
      user_id: user?.id || 'demo-user',
      business_id: businessId,
      message: prompt,
      intent: 'insight',
      context: {
        metricKey: metric,
        value,
        previousValue: previousValue ?? null,
        ...(context || {}),
      },
      opts: { depth: 'brief' },
    };

    const primary = `${API_BASE}/api/gpt/generate`;
    const alias   = `${API_BASE}/api/gpt/generate-response`;

    try {
      let res = await fetch(primary, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 404) {
        res = await fetch(alias, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }
      const data = await parseJsonOrThrow(res);
      setResponse(data.responseText || data.reply || 'No insight available.');
    } catch (err) {
      console.error('[AskBizzyInsight] error:', err);
      setResponse('Something went wrong. Try again later.');
    } finally {
      setLoading(false);
    }
  };

  // RENDER
  if (isInline) {
    // Compact inline button for tables / matrix rows (no popover)
    return (
      <button
        onClick={handleAsk}
        className={baseBtnCls}
        aria-label="Ask Bizzi"
        disabled={loading}
      >
        {showIcon && <IconComponent size={iconSize} />}
        <span className={[
          showIcon ? 'ml-1' : '',
          labelAlwaysVisible || !showIcon ? '' : 'hidden md:inline'
        ].join(' ')}
        >
          {label}
        </span>
      </button>
    );
  }

  // Default card mode (original behavior with popover)
  return (
    <div className="relative">
      <button
        onClick={handleAsk}
        className="absolute top-2 right-2 text-white/60 hover:text-white transition"
        aria-label="Ask Bizzi about this"
        disabled={loading}
      >
        <IconComponent size={16} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2 }}
            ref={panelRef}
            className="absolute z-50 right-0 top-10 w-80 bg-zinc-900 text-white border border-white/10 rounded-lg shadow-xl p-4"
          >
            <div className="text-xs text-white/40 mb-2">
              {loading ? 'Thinking…' : 'Bizzy Insight'}
            </div>

            <div className="text-sm">
              {loading ? (
                <div className="text-white/70">Analyzing this metric…</div>
              ) : (
                <MarkdownRenderer>{response}</MarkdownRenderer>
              )}
            </div>

            <div className="mt-3 flex justify-end">
              <button
                onClick={() => setOpen(false)}
                className="text-xs text-white/60 hover:text-white"
              >
                Close
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default AskBizzyInsightButton;
