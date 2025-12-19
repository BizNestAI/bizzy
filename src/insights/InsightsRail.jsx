// /src/insights/InsightsRail.jsx
import React, { useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useInsightsStore } from './useInsightsStore';
import InsightCard from './InsightCard';
import AgendaWidget from '../pages/Calendar/AgendaWidget';
import { useRightExtras } from './RightExtrasContext';
import { MOCK_INSIGHTS } from './mockInsights';
import useDemoMode from '../hooks/useDemoMode.js';

/* ----------------------- small helpers ----------------------- */
function moduleFromPath(path) {
  const clean = (path || '').split('?')[0].split('#')[0];
  const seg = clean.split('/')[2] || 'bizzy';
  const lowered = seg.toLowerCase();
  if (lowered === 'sch') return 'calendar';
  if (lowered === 'financials') return 'accounting';
  if (lowered.includes('lead') || lowered.includes('job')) return 'jobs';
  return lowered;
}

const accentHexMap = {
  bizzy:       '#FF4EEB',
  accounting:  '#00FFB2',
  marketing:   '#3B82F6',
  tax:         '#FFD700',
  investments: '#B388FF',
  email:       '#3CF6FF',
  calendar:    '#94a3b8',
  activity:    '#94a3b8',
  ops:         '#94a3b8',
};

const CHROME_HEX = '#BFBFBF';
const isChromeRoute = (p = '') =>
  p.startsWith('/dashboard/bizzy') ||
  p.startsWith('/dashboard/leads-jobs') ||
  p.startsWith('/dashboard/calendar') ||
  p.startsWith('/dashboard/activity');

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
  const location   = useLocation();
  const chrome     = isChromeRoute(location.pathname);

  const routeModule      = moduleFromPath(location.pathname);
  const { extras }       = useRightExtras(); // { type:'agenda', props:{businessId, module?} } | { type:null }
  const descriptorModule = extras?.type === 'agenda' ? extras.props?.module : undefined;
  const moduleKey        = descriptorModule || routeModule;

  /* ---- Agenda props (stable scalars; no object creation) ---- */
  const agendaBusinessId =
    (extras?.type === 'agenda' && extras.props?.businessId) ? extras.props.businessId : businessId;
  const agendaModule =
    (extras?.type === 'agenda' && extras.props?.module) ? extras.props.module : routeModule;

  const demoMode = useDemoMode();
  const usingDemoInsights = demoMode === 'demo';

  /* ---- Accent for rail glass & dividers ---- */
  const accentHex = useMemo(
    () => (chrome ? CHROME_HEX : (accentHexMap[moduleKey] || '#FF4EEB')),
    [chrome, moduleKey]
  );

  const headerLine = useMemo(() => hexToRgba(accentHex, 0.2), [accentHex]);

  /* ---- Frosted glass config ---- */
  const glass = useMemo(() => {
    const border = chrome ? 'rgba(191,191,191,0.12)' : hexToRgba(accentHex, 0.12);
    return {
      blur:     '16px',
      saturate: '130%',
      border,
      shadow:   '0 18px 38px rgba(0,0,0,0.26), inset 0 1px 0 rgba(255,255,255,0.04)',
      leftGlow: chrome
        ? 'linear-gradient(to right, rgba(191,191,191,0.12), transparent)'
        : `linear-gradient(to right, ${hexToRgba(accentHex, 0.12)}, transparent)`,
    };
  }, [accentHex, chrome]);

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
    return MOCK_INSIGHTS.filter((i) => {
      const mod = (i.module || '').toLowerCase();
      const key = (moduleKey || '').toLowerCase();
      if (key === 'jobs' || key === 'ops' || key.includes('lead')) {
        return mod === 'jobs' || mod === 'ops' || mod === 'leads' || mod === 'lead-jobs';
      }
      return mod === key;
    });
  }, [items, moduleKey, usingDemoInsights]);

  /* 
   * SEEN on view; READ on leave
   * - Mark SEEN when ≥50% visible (no timers).
   * - Do NOT mark READ here.
   * - When moduleKey changes (leaving this module), mark all seen-but-unread as READ.
   */
  const listRef          = useRef(null);
  const itemsByModuleRef = useRef(new Map());

  // Cache the latest items per module so leaving a module still has its snapshot.
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

  // Mark READ when leaving a module (cleanup runs before moduleKey updates take effect).
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
        try { markRead(id); } catch (e) { /* non-fatal */ }
      });
    };
  }, [moduleKey, markRead]);

  /* ---- Fetch when module changes ---- */
  useEffect(() => { fetchInsights(); }, [moduleKey, accountId]); // eslint-disable-line

  return (
    <div
      data-open={isOpen ? 'true' : 'false'}
      className={[
        'insights-rail',
        'absolute inset-0 isolate flex flex-col overflow-hidden',
        'transition-[opacity,transform] duration-800 ease-[cubic-bezier(0.18,0.9,0.32,1)]',
        isOpen ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4 pointer-events-none',
      ].join(' ')}
      style={{ marginTop: 0, paddingTop: 0 }}
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
          className="rail-content flex-1 min-h-0 px-2 pt-7 pb-10 space-y-5 overflow-y-auto touch-scroll no-scrollbar"
          style={{
            background: 'transparent',
            scrollbarWidth: 'none',
          }}
        >
          {/* Agenda */}
          <div className="ml-2">
            <div
              className="rounded-2xl p-3 transition-[transform,opacity,box-shadow] duration-600 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{ background: 'transparent', border: '1px solid transparent' }}
            >
              <AgendaWidget businessId={agendaBusinessId} module={agendaModule} />
            </div>
          </div>

          {/* Header */}
          <div className="ml-4 mt-1 pr-2">
            <div className="font-semibold text-primary">
              Live Alerts <span className="text-[12px] text-white/50">(sorted by most recent)</span>
            </div>
            <div
              className="mt-2 h-[1px] rounded-full"
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
                    accentHex={accentHex}
                    animate={!alreadyAnimated}
                    index={idx}
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
