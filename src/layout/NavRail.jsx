// File: /src/components/layout/NavRail.jsx
import React, { useState, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Sidebar from '../components/UserAdmin/Sidebar';
import ChatDrawer from '../components/Bizzy/ChatDrawer';
import { useBizzyChatContext } from '../context/BizzyChatContext';
import { useBusiness } from '../context/BusinessContext';
import bizzyLogo from '../assets/bizzy-logo.png';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

const accentHexMap = {
  bizzy: '#FF4EEB',        // fallback (not used for chrome pages)
  accounting: '#00FFB2',
  marketing: '#3B82F6',
  tax: '#FFD700',
  investments: '#B388FF',
  email: '#3CF2FF',
  activity: '#BFBFBF',
};

function moduleFromPath(path) {
  const seg = path.split('/')[2] || 'bizzy';
  return (seg === 'financials' ? 'accounting' : seg).toLowerCase();
}
function hexToRgba(hex, alpha = 1) {
  let c = (hex || '').replace('#', '');
  if (c.length === 3) c = c.split('').map(s => s + s).join('');
  const n = parseInt(c || '000000', 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const DEFAULT_NAV_W = 256;
const COLLAPSED_NAV_W = 115;

/** Bizzi/chrome routes */
const isChromeRoute = (path) =>
  path.startsWith('/dashboard/bizzy')   ||   // Pulse
  path.startsWith('/dashboard/bizzy-docs') ||
  path.startsWith('/dashboard/companion') ||
  path.startsWith('/dashboard/settings') ||
  path.startsWith('/dashboard/leads-jobs') ||
  path.startsWith('/dashboard/calendar') ||
  path.startsWith('/dashboard/activity') ||
  path === '/chat';

export default function NavRail({
  businessId,
  className = '',
  open = false,
  onClose,
  accentOverride,
}) {
  const { openThread, threadsRefreshKey } = useBizzyChatContext();
  const { currentBusiness } = useBusiness();
  const location = useLocation();
  const navigate = useNavigate();

  const isChatHome = location.pathname.startsWith('/chat');
  const moduleKey = useMemo(() => moduleFromPath(location.pathname), [location.pathname]);
  const useChrome = isChromeRoute(location.pathname);

  // neutral when explicitly requested or on chat home
  const isNeutral = useMemo(
    () => accentOverride === 'neutral' || isChatHome,
    [accentOverride, isChatHome]
  );

  // pick the “base” accent for this route (chrome for bizzi-family, else module color)
  const baseAccent = useMemo(() => {
    if (useChrome) return '#BFBFBF'; // chrome silver
    return accentHexMap[moduleKey] || '#FF4EEB';
  }, [useChrome, moduleKey]);

  // expose tokens for children (Sidebar, etc.)
  const accentToken = baseAccent;
  const accentSoft  = useMemo(() => (useChrome ? 'rgba(191,191,191,.50)' : hexToRgba(baseAccent, 0.40)), [useChrome, baseAccent]);

  const effectiveBusinessId = useMemo(() => (
    currentBusiness?.id ||
    businessId ||
    localStorage.getItem('currentBusinessId') ||
    ''
  ), [currentBusiness?.id, businessId]);

  const asideRef = useRef(null);

  const [collapsed, setCollapsed] = useState(true);

  useLayoutEffect(() => {
    const width = `${collapsed ? COLLAPSED_NAV_W : DEFAULT_NAV_W}px`;
    document.documentElement.style.setProperty("--nav-w", width);
    document.documentElement.style.setProperty("--nav-collapsed", String(collapsed ? 1 : 0));
  }, [collapsed]);

  return (
    <>
      {/* Fixed, full-height column. On mobile it slides in; on md+ it’s always visible. */}
      <aside
        ref={asideRef}
        aria-label="Navigation rail"
        data-collapsed={collapsed ? 'true' : 'false'}
      className={[
        "fixed left-0 px-2 top-0 h-[100svh] md:h-screen z-40",
        "bg-sidebar/95 text-primary",
        "transition-[width,transform,border-color,box-shadow] duration-200 ease-in-out",
        "w-[--nav-w]",
        open ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        "flex flex-col min-h-0 overflow-y-auto no-scrollbar",
        className
      ].join(' ')}
      style={{
        '--accent': accentToken,
        '--accent-soft': accentSoft,
        '--chat-clearance': '112px',
        borderRight: '1px solid rgba(255,255,255,0.08)',
        boxShadow: collapsed ? `2px 0 8px rgba(0,0,0,0.35)` : `0 0 4px ${accentSoft}`,
        willChange: "width, transform",
        transition: "width 200ms cubic-bezier(0.22,1,0.36,1), transform 200ms cubic-bezier(0.22,1,0.36,1), border-color 180ms ease, box-shadow 180ms ease",
      }}
      >
        {/* Rail header */}
        <div
          className="sticky top-0 z-10 pl-2 pr-3 pt-3 pb-2"
          style={{
            background: 'rgba(18,16,15,0.9)',
          }}
        >
          <div className="flex items-center min-w-0 gap-3">
            <div className="flex items-center gap-3 min-w-0 flex-shrink-0">
              <button
                onClick={() => navigate('/dashboard/bizzy')}
                className="group relative h-9 w-9 rounded-full overflow-hidden shrink-0 outline-none"
                aria-label="Go to Bizzi Dashboard"
                title="Go to Bizzi Dashboard"
                style={{
                  border: `1px solid ${hexToRgba(baseAccent, 0.55)}`,
                  boxShadow: `0 0 0 1px ${hexToRgba(baseAccent, 0.22)}, 0 0 10px ${accentSoft}`
                }}
              >
                <img
                  src={bizzyLogo}
                  alt="Bizzi logo"
                  className="h-full w-full object-contain rounded-full bg-panel p-[2px] select-none"
                  draggable="false"
                  loading="eager"
                  decoding="async"
                />
              </button>

              {!collapsed && (
                <span className="text-lg leading-none truncate text-primary">Bizzi</span>
              )}
            </div>

            {/* Collapse/Expand button */}
            <div className="flex-1 flex justify-end">
              <button
                onClick={() => setCollapsed(v => !v)}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full transition hover:bg-white/8"
                title={collapsed ? "Expand" : "Collapse"}
                aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
                style={{ color: 'var(--text)' }}
              >
                {collapsed ? <PanelLeftOpen size={11} /> : <PanelLeftClose size={11} />}
              </button>
            </div>
          </div>
        </div>

        {/* Main nav list */}
        <div className="shrink-0 mt-3">
          <Sidebar compact collapsed={collapsed} />
        </div>

        {/* Chat threads list (scrolls with rail) */}
        <div className="mt-2 px-0">
          <ChatDrawer
            businessId={effectiveBusinessId}
            onOpenThread={openThread}
            refreshKey={threadsRefreshKey}
            className="h-auto"
            collapsed={collapsed}
            onToggle={() => setCollapsed(v => !v)}
            scrollRootRef={asideRef}
          />
        </div>
      </aside>

      {/* Scrim for mobile */}
      <button
        aria-label="Close navigation"
        onClick={onClose}
        className={[
          "fixed inset-0 z-30 bg-black/40 md:hidden transition-opacity",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        ].join(' ')}
      />
    </>
  );
}
