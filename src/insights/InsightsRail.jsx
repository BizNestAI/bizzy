// /src/insights/InsightsRail.jsx
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInsightsStore } from './useInsightsStore';
import InsightCard from './InsightCard';
import { MOCK_INSIGHTS } from './mockInsights';
import useDemoMode from '../hooks/useDemoMode.js';
import { ACCENT_HEX } from '../config/accent';
import { apiUrl, safeFetch } from '../utils/safeFetch.js';

/* ----------------------- small helpers ----------------------- */
const GLOBAL_INSIGHTS_MODULE = 'contractor_cfo';
const CHROME_HEX = ACCENT_HEX;

function hexToRgba(hex, a = 1) {
  const c = (hex || '').replace('#', '');
  const n = parseInt(c.length === 3 ? c.split('').map(s => s + s).join('') : c, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/* Tiny inline SVG noise (breaks gradient banding) */
const NOISE = encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'>
     <filter id='n'>
       <feTurbulence baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/>
       <feColorMatrix type='saturate' values='0'/>
     </filter>
     <rect width='100%' height='100%' filter='url(#n)' opacity='0.035'/>
   </svg>`
);
const NOISE_URL = `url("data:image/svg+xml,${NOISE}")`;

/* ========================= Component ========================= */
export default function InsightsRail({
  userId,
  businessId,
  accountId,
  isOpen = true,
}) {
  const moduleKey = GLOBAL_INSIGHTS_MODULE;
  const navigate = useNavigate();

  const demoMode = useDemoMode();
  const usingDemoInsights = demoMode === 'demo';

  /* ---- Accent for rail glass & dividers ---- */
  const accentHex = useMemo(() => CHROME_HEX, []);

  const headerLine = useMemo(() => hexToRgba(accentHex, 0.2), [accentHex]);

  /* ---- Frosted glass config ---- */
  const glass = useMemo(() => {
    return {
      blur:     '16px',
      saturate: '130%',
      border: 'rgba(191,191,191,0.12)',
      shadow:   '0 18px 38px rgba(0,0,0,0.26), inset 0 1px 0 rgba(255,255,255,0.04)',
      leftGlow: 'linear-gradient(to right, rgba(191,191,191,0.12), transparent)',
    };
  }, []);

  /* ---- Insights data for current module ---- */
  const { items, markRead, markSeen, fetchInsights, snooze } = useInsightsStore({
    userId,
    businessId,
    moduleKey,
    accountId,
    allowMockFallback: usingDemoInsights,
  });

  // Fallback to mock insights for this module if store returns none (keeps rail populated in demo)
  const displayItems = useMemo(() => {
    if (items.length) return items;
    if (!usingDemoInsights) return [];
    return MOCK_INSIGHTS.filter((i) => (i.module || '').toLowerCase() === moduleKey);
  }, [items, moduleKey, usingDemoInsights]);
  const alertCountLabel = `${displayItems.length} ${displayItems.length === 1 ? 'alert' : 'alerts'}`;

  /* 
   * SEEN on view; READ on leave
   * - Mark SEEN when ≥50% visible (no timers).
   * - Do NOT mark READ here.
   * - On rail teardown, mark all seen-but-unread global alerts as READ.
   */
  const listRef          = useRef(null);
  const itemsByModuleRef = useRef(new Map());

  // Cache the latest global alert snapshot so teardown can mark seen items read.
  useEffect(() => {
    itemsByModuleRef.current.set(moduleKey, items);
  }, [items, moduleKey]);

  // Intersection observer: mark SEEN only.
  useEffect(() => {
    if (!listRef.current) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const el  = entry.target;
        const id  = el.getAttribute('data-insight-id');
        const seenAttr = el.getAttribute('data-seen') === 'true';
        if (!id) return;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5 && !seenAttr) {
          markSeen([id]);
          el.setAttribute('data-seen', 'true');
        }
      });
    }, { threshold: [0.5] });

    const nodes = listRef.current.querySelectorAll('[data-insight-id]');
    nodes.forEach((n) => io.observe(n));

    return () => io.disconnect();
  }, [items, markSeen]);

  // Mark READ when the rail tears down.
  useEffect(() => {
    const moduleOnMount = moduleKey;
    return () => {
      if (!moduleOnMount) return;
      const prevItems = itemsByModuleRef.current.get(moduleOnMount) || [];
      const toRead = prevItems
        .filter((r) => (r.is_seen || r.seen) && !r.is_read)
        .map((r) => r.id)
        .filter(Boolean);
      toRead.forEach((id) => {
        try { markRead(id); } catch { /* non-fatal */ }
      });
    };
  }, [moduleKey, markRead]);

  /* ---- Fetch global alerts ---- */
  useEffect(() => { fetchInsights(); }, [moduleKey, accountId]); // eslint-disable-line

  const handleCta = useCallback(async (insight, cta) => {
    const action = normalizeAction(cta?.action);
    const payload = cta?.payload || {};

    try {
      if (action === 'navigate') {
        const path = payload.path || payload.route || payload.url;
        if (!path) {
          console.warn('[insights] CTA navigate missing path', { insightId: insight?.id, cta });
          return;
        }
        navigate(path);
        return;
      }

      if (action === 'open_chat') {
        const text = payload.prompt || payload.text || payload.message || insight?.body || insight?.title || '';
        if (!text) {
          console.warn('[insights] CTA open_chat missing prompt', { insightId: insight?.id, cta });
          return;
        }
        window.dispatchEvent(new CustomEvent('bizzy:prefill-chat', { detail: { text, prompt: text, context: { insight, payload } } }));
        window.dispatchEvent(new Event('bizzy:open-chat'));
        return;
      }

      if (action === 'mark_acted_on') {
        if (!insight?.id) return;
        await safeFetch(apiUrl('/api/insights/feedback'), {
          method: 'POST',
          body: {
            businessId,
            insightId: insight.id,
            userId,
            feedback: 'acted_on',
          },
        });
        await fetchInsights();
        return;
      }

      if (action === 'run_reconciliation') {
        await safeFetch(apiUrl('/api/bookkeeping/reconciliations/run'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-business-id': businessId || '' },
          body: {
            businessId,
            ...(payload && typeof payload === 'object' ? payload : {}),
          },
        });
        await fetchInsights();
        return;
      }

      if (action === 'open_modal') {
        const modal = payload.modal || payload.modalKey || payload.type;
        if (!modal) {
          console.warn('[insights] CTA open_modal missing modal key', { insightId: insight?.id, cta });
          return;
        }
        window.dispatchEvent(new CustomEvent('bizzy:open-modal', { detail: { modal, payload, insight } }));
        return;
      }

      console.warn('[insights] Unsupported CTA action', { action: cta?.action, insightId: insight?.id });
    } catch (error) {
      console.warn('[insights] CTA action failed', { action: cta?.action, insightId: insight?.id, error });
    }
  }, [businessId, userId, fetchInsights, navigate]);

  return (
    <div
      data-open={isOpen ? 'true' : 'false'}
      className={[
        'insights-rail',
        'absolute inset-0 isolate flex flex-col overflow-hidden',
        'transition-opacity duration-150 ease-out',
        isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none',
      ].join(' ')}
      style={{ marginTop: 0, paddingTop: 0, width: '100%' }}
    >
      {/* ===== GLASS: single continuous surface under content ===== */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          top: -32,
          height: 'calc(100% + 32px)',
          background:
            'linear-gradient(180deg, rgba(255,255,255,0.040), rgba(255,255,255,0.036) 50%, rgba(255,255,255,0.032))',
          backdropFilter:       `blur(${glass.blur}) saturate(${glass.saturate})`,
          WebkitBackdropFilter: `blur(${glass.blur}) saturate(${glass.saturate})`,
          boxShadow: glass.shadow,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-40 mix-blend-overlay z-0"
        style={{
          top: -32,
          height: 'calc(100% + 32px)',
          backgroundImage: NOISE_URL,
          backgroundSize: '120px 120px',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-[8px] blur-[10px] z-0"
        style={{ background: glass.leftGlow }}
      />

      {/* ===== CONTENT: transparent scroll host ===== */}
      <div className="relative w-full flex-1 min-h-0 pb-3 z-10 flex flex-col">
        <div
          ref={listRef}
          className="rail-content flex-1 min-h-0 px-2 pt-12 pb-10 space-y-6 overflow-y-auto touch-scroll no-scrollbar"
          style={{
            background: 'transparent',
            scrollbarWidth: 'none',
          }}
        >
          {/* Header */}
          <div className="ml-4 mt-3 pr-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold leading-tight text-white/95">
                  Live Alerts
                </div>
                <div className="mt-1 text-[11px] font-medium leading-4 text-white/48">
                  Financial alerts sorted by most recent
                </div>
              </div>
              <span
                className="shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold leading-none text-white/72"
                style={{
                  borderColor: hexToRgba(accentHex, 0.18),
                  background: hexToRgba(accentHex, 0.06),
                }}
              >
                {alertCountLabel}
              </span>
            </div>
            <div
              className="mt-3 h-[1px] rounded-full"
              style={{
                background: headerLine,
                width: 'calc(100% - 12px)',
                marginLeft: '0px',
              }}
            />
          </div>

          {/* Insight cards */}
          {displayItems.length === 0 ? (
            <div className="ml-2 text-sm leading-5 text-secondary">
              No insights yet. I’ll surface things here while you work.
            </div>
          ) : (
            displayItems.map((ins, idx) => {
              const alreadyAnimated =
                (sessionStorage.getItem(`bizzy:insight:animated:${ins.id}`) === '1') || ins.is_seen;
              if (!alreadyAnimated) sessionStorage.setItem(`bizzy:insight:animated:${ins.id}`, '1');
              return (
                <div
                  key={ins.id}
                  data-insight-id={ins.id}
                  data-seen={ins.is_seen ? 'true' : 'false'}
                  className="ml-2"
                >
                  <InsightCard
                    insight={ins}
                    onSnooze={snooze}
                    onCta={handleCta}
                    accentHex={accentHex}
                    animate={!alreadyAnimated}
                    index={idx}
                    hideDashboardNavigationCtas
                  />
                </div>
              );
            })
          )}

          {/* Spacer so the last card clears the floating chat bar */}
          <div
            aria-hidden
            style={{ height: 'var(--chat-clearance, 140px)' }}
          />
        </div>
      </div>
    </div>
  );
}

function normalizeAction(action) {
  const normalized = String(action || '').trim().toLowerCase();
  if (normalized === 'open_route') return 'navigate';
  return normalized;
}
