// File: /src/components/Bizzy/BizzyGreeting.jsx
import React, { useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { apiUrl, safeFetch } from '../../utils/safeFetch';
import { useBizzyChatContext } from '../../context/BizzyChatContext';

// ⬇️ Use the same Bizzi hero art that’s used in MainLayout
import bizzyHero from '../../assets/bizzy-hero.png';

const ACCENT_DEFAULT = '#FF4EEB';

const KIND_META = {
  generic:   { label: 'Bizzi' },
  finance:   { label: 'Finance' },
  marketing: { label: 'Marketing' },
  tax:       { label: 'Taxes' },
  ops:       { label: 'Operations' },
};

// Fallback label/prompt/intent per kind when API doesn't provide them
const KIND_DEFAULTS = {
  generic: {
    label:  'Run health check',
    prompt: 'Run a quick health check on cash, tax, and pipeline. Summarize the top 3 issues and 2–3 next actions.',
    intent: 'daily_health_check',
  },
  finance: {
    label:  'Review cash & margin',
    prompt: 'Review cash flow, AR/collections, payroll ratio, and margin. Summarize risks and 2–3 fixes.',
    intent: 'finance_health',
  },
  marketing: {
    label:  'Review leads & ads',
    prompt: 'Review leads and ad performance for the last 7 days. Summarize wins, losses, and 2–3 actions.',
    intent: 'marketing_health',
  },
  tax: {
    label:  'Check tax readiness',
    prompt: 'Check tax readiness and next estimated payment. Flag deadlines and quick wins.',
    intent: 'tax_health',
  },
  ops: {
    label:  'Review this week’s jobs',
    prompt: 'Review this week’s jobs and flag anything at risk. Suggest 2–3 actions to de-risk schedule.',
    intent: 'ops_week_review',
  },
};

function ctaLabel(kind, fallback = 'Run it') {
  return KIND_DEFAULTS[kind]?.label || fallback;
}

export default function BizzyGreeting({ businessId, userId, accent = ACCENT_DEFAULT }) {
  // ⬇️ Pull in threadId + suppressedUserTextRef so we can persist the seed for this thread
  const {
    startQuickPrompt,
    openHistory,
    threadId,
    suppressedUserTextRef,
  } = useBizzyChatContext?.() || {};

  // headline + subline (tip)
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState('generic');
  const [payload, setPayload] = useState({});
  const [headlineFull, setHeadlineFull] = useState('');
  const [headlineDisplay, setHeadlineDisplay] = useState('');
  const [tipFull, setTipFull] = useState('Tip from Bizzi — use the chat bar to ask me anything');
  const [tipDisplay, setTipDisplay] = useState('');
  const [shouldType, setShouldType] = useState(false);

  const headIdxRef = useRef(0);
  const tipIdxRef = useRef(0);
  const typingTimerRef = useRef(null);

  // Dynamic height refs/state
  const containerRef = useRef(null);
  const textRef = useRef(null);
  const [doneTyping, setDoneTyping] = useState(false);
  const [measuredHeight, setMeasuredHeight] = useState(null);

  // Once/day typing
  useEffect(() => {
    const key = 'bizzy:greeting:lastTyped';
    const today = new Date().toISOString().slice(0, 10);
    const last = localStorage.getItem(key);
    if (last !== today) {
      setShouldType(true);
      localStorage.setItem(key, today);
    }
  }, []);

  // Fetch greeting
  useEffect(() => {
    let alive = true;
    async function load() {
      if (!businessId) { setLoading(false); return; }
      try {
        setLoading(true);
        const url = new URL(apiUrl('/api/insights/headline'));
        url.searchParams.set('business_id', businessId);
        if (userId) url.searchParams.set('user_id', userId);
        const data = await safeFetch(url.toString(), {
          headers: { 'x-business-id': businessId, 'x-user-id': userId || '' }
        });

        if (!alive) return;
        const headlineText = data?.headline || 'Hey there – I’ll watch your cash and tax so you can focus on work.';
        const tipText      = data?.data?.tip || 'Tip from Bizzi — use the chat bar to ask me anything';
        setKind(data?.kind || 'generic');
        setPayload(data?.data || {});
        setHeadlineFull(headlineText);
        setTipFull(tipText);

        if (shouldType) {
          setHeadlineDisplay('');
          setTipDisplay('');
          headIdxRef.current = 0;
          tipIdxRef.current = 0;
          const typeHeadline = () => {
            const i = headIdxRef.current;
            if (i <= headlineText.length) {
              setHeadlineDisplay(headlineText.slice(0, i));
              headIdxRef.current = i + 1;
              typingTimerRef.current = setTimeout(typeHeadline, 18);
            } else {
              const typeTip = () => {
                const j = tipIdxRef.current;
                if (j <= tipText.length) {
                  setTipDisplay(tipText.slice(0, j));
                  tipIdxRef.current = j + 1;
                  typingTimerRef.current = setTimeout(typeTip, 14);
                } else setDoneTyping(true);
              };
              typeTip();
            }
          };
          typeHeadline();
        } else {
          setHeadlineDisplay(headlineText);
          setTipDisplay(tipText);
          setDoneTyping(true);
        }
      } catch (e) {
        console.warn('[BizzyGreeting] headline load failed', e);
        const fallback = 'Hey there – I’ll watch your cash and tax so you can focus on work.';
        setKind('generic');
        setPayload({});
        setHeadlineFull(fallback);
        setHeadlineDisplay(fallback);
        setTipFull('Tip from Bizzi — use the chat bar to ask me anything');
        setTipDisplay('Tip from Bizzi — use the chat bar to ask me anything');
        setDoneTyping(true);
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => {
      alive = false;
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [businessId, userId, shouldType]);

  // Dynamic height expansion
  useLayoutEffect(() => {
    if (!doneTyping) return;
    const el  = containerRef.current;
    const txt = textRef.current;
    if (!el || !txt) return;
    const full = txt.scrollHeight;
    if (full > el.clientHeight) {
      setMeasuredHeight(full);
      const t = setTimeout(() => setMeasuredHeight(null), 300);
      return () => clearTimeout(t);
    }
  }, [doneTyping, headlineDisplay, tipDisplay]);

  // --- CTA: always start chat (no route) ---
  const resolvedLabel  = payload?.label  || ctaLabel(kind, 'Run it');
  const resolvedPrompt = payload?.prompt || KIND_DEFAULTS[kind]?.prompt || KIND_DEFAULTS.generic.prompt;
  const resolvedIntent = payload?.intent || KIND_DEFAULTS[kind]?.intent || KIND_DEFAULTS.generic.intent;

  const hasCTA = Boolean(startQuickPrompt && resolvedPrompt && resolvedIntent);
  const ctaDisabled = !doneTyping || loading || !hasCTA;

  // ⬇️ UPDATED: persist seed + hidden flag so the quick-prompt user bubble never shows after refresh
  const onPrimaryCTA = () => {
    if (!hasCTA) return;

    const seed = resolvedPrompt?.trim() || '';
    try {
      // Share the seed with the chat history logic immediately
      if (suppressedUserTextRef) suppressedUserTextRef.current = seed;

      // Persist per-thread if we already have one, plus a global fallback
      if (seed) {
        localStorage.setItem('bizzy:lastSeedPrompt', seed);
        if (threadId) {
          localStorage.setItem(`bizzy:seed:${threadId}`, seed);
          localStorage.setItem(`bizzy:hiddenSeed:${threadId}`, '1');
        }
      }
    } catch {}

    startQuickPrompt({
      source: 'headline',
      intent: resolvedIntent,
      text: resolvedPrompt,
      // extras: { kind, headline: headlineFull }
    });

    openHistory?.(); // show chat panel
  };

  // Strong glow halo behind the card
  const haloStyle = useMemo(() => ({
    background: `
      radial-gradient(70% 140% at -12% -10%, ${hex(accent, 0.55)} 0%, transparent 65%),
      radial-gradient(80% 160% at 112% 120%, ${hex(accent, 0.45)} 0%, transparent 70%)
    `,
    filter: 'blur(14px)',
    opacity: 0.95,
  }), [accent]);

  // Card chrome
  const cardStyle = useMemo(() => ({
    border: `1px solid ${hex(accent, 0.24)}`,
    background: `linear-gradient(180deg, rgba(11,14,19,0.94) 12%, rgba(11,14,19,0.72) 100%)`,
    boxShadow: `
       0 0 28px ${hex(accent, 0.40)},
       0 0  2px ${hex(accent, 0.70)} inset,
       0 0  1px ${hex(accent, 0.88)}
    `,
    height: measuredHeight != null ? measuredHeight : 'auto',
    transition: 'height 240ms ease',
  }), [accent, measuredHeight]);

  // Neon ring for the avatar + glow (same vibe as top bar)
  const avatarRing = useMemo(() => ({
    boxShadow: `
       0 0 0 1px ${hex(accent, 0.72)} inset,
       0 0 18px ${hex(accent, 0.38)},
       0 0  6px ${hex(accent, 0.68)} inset
    `,
    border: `1px solid ${hex(accent, 0.55)}`,
    background: `${hex(accent, 0.10)}`,
  }), [accent]);

  const Meta = KIND_META[kind] || KIND_META.generic;

  return (
    <div
      ref={containerRef}
      className="relative mb-4 overflow-hidden rounded-2xl"
      role="banner"
      aria-live="polite"
      style={{ transition: 'height 240ms ease' }}
    >
      <div aria-hidden className="pointer-events-none absolute -inset-[6px] rounded-2xl" style={haloStyle} />

      <div ref={textRef} className="rounded-2xl px-5 py-4 backdrop-blur relative" style={cardStyle}>
        {loading ? (
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-white/10 animate-pulse" />
            <div className="h-6 w-2/3 bg-white/10 rounded animate-pulse" />
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            {/* left: Bizzi avatar + headline + tip */}
            <div className="flex items-center gap-3 min-w-0">
              <div
                className="h-9 w-9 rounded-full overflow-hidden shrink-0 grid place-items-center"
                style={avatarRing}
                title={Meta.label}
                aria-hidden
              >
                <img
                  src={bizzyHero}
                  alt="Bizzi"
                  className="h-full w-full object-cover rounded-full select-none pointer-events-none"
                  draggable="false"
                />
              </div>

              <div className="min-w-0">
                <div className="text-white text-base md:text-xl font-semibold whitespace-normal break-words leading-tight">
                  {headlineDisplay}
                  {shouldType && headlineDisplay.length < (headlineFull || '').length && (
                    <span className="inline-block w-[8px] h-[18px] md:h-[22px] bg-white/70 ml-[2px] align-middle animate-pulse" />
                  )}
                </div>

                <div className="mt-1 text-[12px] text-white/70">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-white/15 bg-white/5 whitespace-normal break-words">
                    {tipDisplay}
                    {shouldType &&
                      headlineDisplay.length >= (headlineFull || '').length &&
                      tipDisplay.length < (tipFull || '').length && (
                        <span className="inline-block w-[6px] h-[14px] bg-white/60 ml-[2px] align-middle animate-pulse" />
                      )}
                  </span>
                </div>
              </div>
            </div>

            {/* Right: single CTA chip that starts a chat */}
            <button
              onClick={onPrimaryCTA}
              disabled={ctaDisabled}
              aria-label={resolvedLabel}
              className={`inline-flex items-center gap-0 text-xs md:text-sm px-3 py-1 rounded-full border transition
                          border-white/15 ${ctaDisabled ? 'opacity-60 cursor-not-allowed' : 'hover:border-[var(--accent,#FF4EEB)] hover:text-[var(--accent,#FF4EEB)]'}`}
              title={resolvedLabel}
              data-intent={resolvedIntent}
            >
              {resolvedLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- utils ---------- */
function hex(c, a = 1) {
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}
