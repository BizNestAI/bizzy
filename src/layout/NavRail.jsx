// File: /src/components/layout/NavRail.jsx
import React, { useMemo, useRef, useLayoutEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Sidebar from '../components/UserAdmin/Sidebar';
import ChatDrawer from '../components/Bizzy/ChatDrawer';
import { useBizzyChatContext } from '../context/BizzyChatContext';
import { useBusiness } from '../context/BusinessContext';
import bizzyLogo from '../assets/bizzy-logo.png';
import { ACCENT_HEX, ACCENT_SOFT } from '../config/accent';
import NavRailBusinessBadge from './NavRailBusinessBadge';

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
  path.startsWith('/chat');

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

  const isChatHome = location.pathname.startsWith('/dashboard/bizzy/chat') || location.pathname.startsWith('/chat');
  const moduleKey = useMemo(() => moduleFromPath(location.pathname), [location.pathname]);
  const useChrome = isChromeRoute(location.pathname);

  // neutral when explicitly requested or on chat home
  const isNeutral = useMemo(
    () => accentOverride === 'neutral' || isChatHome,
    [accentOverride, isChatHome]
  );

  // pick the “base” accent for this route (unified Books green everywhere)
  const baseAccent = useMemo(() => ACCENT_HEX, []);

  // expose tokens for children (Sidebar, etc.)
  const accentToken = baseAccent;
  const accentSoft  = useMemo(() => ACCENT_SOFT, []);

  const effectiveBusinessId = useMemo(() => (
    currentBusiness?.id ||
    businessId ||
    localStorage.getItem('currentBusinessId') ||
    ''
  ), [currentBusiness?.id, businessId]);

  const asideRef = useRef(null);
  const chatDrawerRef = useRef(null);
  const collapsed = true;

  useLayoutEffect(() => {
    const width = `${COLLAPSED_NAV_W}px`;
    document.documentElement.style.setProperty("--nav-w", width);
    document.documentElement.style.setProperty("--nav-collapsed", "1");
  }, []);

  return (
    <>
      {/* Fixed, full-height column. On mobile it slides in; on md+ it’s always visible. */}
      <aside
        ref={asideRef}
        aria-label="Navigation rail"
        data-collapsed={collapsed ? 'true' : 'false'}
      className={[
        `fixed left-0 ${collapsed ? "px-1" : "px-2"} top-0 h-[100svh] md:h-screen z-40`,
        "text-primary",
        "transition-[width,transform,padding,border-color,box-shadow] duration-350 ease-[cubic-bezier(.22,1,.36,1)]",
        "w-[--nav-w]",
        open ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        "flex flex-col min-h-0",
        className
      ].join(' ')}
      style={{
        '--accent': accentToken,
        '--accent-soft': accentSoft,
        '--chat-clearance': '112px',
        borderRight: '1px solid rgba(255,255,255,0.06)',
        boxShadow: 'none',
        backgroundColor: 'transparent',
        willChange: "width, transform",
        transition: "width 320ms cubic-bezier(0.22,1,0.36,1), transform 320ms cubic-bezier(0.22,1,0.36,1), padding 320ms cubic-bezier(0.22,1,0.36,1), border-color 220ms ease, box-shadow 320ms cubic-bezier(0.22,1,0.36,1)",
      }}
      >
        {/* Dedicated grain layer for the rail */}
        <div
          aria-hidden
          className="bizzy-bg-textured"
          style={{ position: "absolute", inset: 0, backgroundColor: "var(--bg)", pointerEvents: "none", zIndex: 0 }}
        />

        <div
          className="flex-1 min-h-0 flex flex-col overflow-y-auto no-scrollbar relative"
          style={{ zIndex: 1, paddingBottom: "76px" }}
        >
          {/* Rail header */}
          <div
            className="sticky top-0 z-10 pl-2 pr-3 pt-3 pb-2"
            style={{ background: "transparent" }}
          >
            <div className="flex items-center min-w-0 gap-3">
              <div className="flex items-center gap-3 min-w-0 flex-shrink-0">
                <button
                onClick={() => navigate('/dashboard/bizzy/chat')}
                className="group relative h-9 w-9 rounded-full overflow-hidden shrink-0 outline-none"
                aria-label="Go to ChatHome"
                title="Go to ChatHome"
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
            </div>
          </div>

          {/* Main nav list */}
          <div className="shrink-0 mt-3">
            <Sidebar
              compact
              collapsed={collapsed}
              onChatHistoryHover={(anchor) => chatDrawerRef.current?.openHistory(anchor, { align: 'bottom' })}
              onChatHistoryLeave={() => chatDrawerRef.current?.closeHistory()}
              onChatHistoryClick={(anchor) => chatDrawerRef.current?.openHistory(anchor, { align: 'bottom' })}
            />
          </div>

          {/* Chat threads list (scrolls with rail) */}
          <div className="mt-2 px-0">
            <ChatDrawer
              businessId={effectiveBusinessId}
              onOpenThread={openThread}
              refreshKey={threadsRefreshKey}
              className="h-auto"
              collapsed={collapsed}
              ref={chatDrawerRef}
              showHistoryTrigger={false}
              scrollRootRef={asideRef}
            />
          </div>
        </div>

        {/* Bottom badge */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 22,
            display: "flex",
            justifyContent: "center",
            pointerEvents: "auto",
            zIndex: 5,
          }}
        >
          <NavRailBusinessBadge />
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
