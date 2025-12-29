// src/layout/MainLayout.jsx
import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../services/supabaseClient';
import { useNavigate, useLocation } from 'react-router-dom';
import BusinessSwitcher from '../components/UserAdmin/BusinessSwitcher';
import BusinessWizard from '../pages/UserAdmin/BusinessWizard';
import useModuleTheme from '../hooks/useModuleTheme';
import { useBizzyChatContext, BizzyChatProvider } from '../context/BizzyChatContext';
import { Calendar, Menu } from 'lucide-react';
import CalendarQuickOpen from '../pages/Calendar/CalendarQuickOpen.jsx';
import ToastPortal from '../insights/ToastPortal';
import NavRail from './NavRail';
import { InsightsUnreadProvider } from '../insights/InsightsUnreadContext';
import ChatSwitchToggle from '../components/Bizzy/ChatSwitchToggle';

const accentHexMap = {
  bizzy:'#FF4EEB',
  accounting:'#00FFB2',
  marketing:'#3B82F6',
  tax:'#FFD700',
  investments:'#B388FF',
  email: '#3CF2FF',
  activity: '#BFBFBF',
};

/* util to make a soft glow from hex */
function hexToRgba(hex, alpha = 0.45) {
  let c = (hex || '').replace('#','');
  if (c.length === 3) c = c.split('').map(s => s+s).join('');
  const n = parseInt(c, 16);
  const r = (n>>16)&255, g = (n>>8)&255, b = n&255;
  return `rgba(${r},${g},${b},${alpha})`;
}

const RIGHT_RAIL_W = 320;  // keep in sync with DashboardLayout / InsightsRail width
const GRID_GAP     = 6;    // the grid gap between center & right rail columns

/* Which module routes should use Chrome/Silver? */
const CHROME_MODULES = new Set(['bizzy','leads-jobs','calendar','activity','bizzy-docs','companion','settings']);

const MainLayoutCore = ({ children }) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const seg = location.pathname.split('/')[2] || 'bizzy';
  const moduleKey = (seg === 'financials' ? 'accounting' : seg).toLowerCase();
  const theme = useModuleTheme(moduleKey);

  const { usageCount } = useBizzyChatContext?.() || {};
  const textColor = theme?.textClass || 'text-primary';
  const isChatHome = location.pathname.startsWith('/dashboard/bizzy') || location.pathname.startsWith('/chat');

  const [currentBusiness, setCurrentBusiness] = useState(null);
  const [isProfileComplete, setIsProfileComplete] = useState(null);

  const [calendarOpen, setCalendarOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  /* Decide switcher accent:
     - Chrome (silver) on: Pulse(bizzy), Jobs(leads-jobs), Calendar, Bizzi Docs, Meet Bizzi, Settings/Sync
     - Email uses light blue
     - All others keep module color
     - Chat home remains neutral
  */
  const { brandAccent, accentSoft } = useMemo(() => {
    if (CHROME_MODULES.has(moduleKey)) {
      return { brandAccent: '#BFBFBF', accentSoft: 'rgba(191,191,191,.50)' };
    }
    if (moduleKey === 'email') {
      return { brandAccent: accentHexMap.email, accentSoft: hexToRgba(accentHexMap.email, 0.45) };
    }
    const hex = accentHexMap[moduleKey] || '#FF4EEB';
    return { brandAccent: hex, accentSoft: hexToRgba(hex, 0.45) };
  }, [moduleKey]);

  const neutralAccent = 'rgba(165,167,169,0.30)';
  /* hover state for BusinessSwitcher glow */
  const [switcherHover, setSwitcherHover] = useState(false);

  useEffect(() => {
    const fetchCurrentBusiness = async () => {
      if (!user) return;
      try {
        const { data: link } = await supabase
          .from('user_business_link').select('business_id')
          .eq('user_id', user.id).eq('role','owner').limit(1).maybeSingle();

        if (!link) { setIsProfileComplete(false); return; }

        const { data: biz } = await supabase.from('business_profiles')
          .select('*').eq('id', link.business_id).single();

        if (!biz) { setIsProfileComplete(false); return; }

        setCurrentBusiness(biz);
        setIsProfileComplete(true);
        localStorage.setItem('currentBusinessId', biz.id);
      } catch (err) {
        console.error('Error fetching business:', err);
        setIsProfileComplete(false);
      } finally {
      }
    };
    fetchCurrentBusiness();
  }, [user]);

  useEffect(() => {
    const handler = (event) => {
      const detail = event?.detail || {};
      const target = detail.target || detail.to;
      if (!target) return;
      navigate(target);
    };
    window.addEventListener('bizzy:navigate', handler);
    return () => window.removeEventListener('bizzy:navigate', handler);
  }, [navigate]);

  if (isProfileComplete === false) {
    return (
      <div className="h-screen bg-app font-sans p-6 text-primary">
        <BusinessWizard />
      </div>
    );
  }

  const businessId = currentBusiness?.id || localStorage.getItem('currentBusinessId');

  return (
    <InsightsUnreadProvider userId={user?.id} businessId={businessId}>
      <div className={`min-h-screen h-screen bg-app ${textColor} font-sans relative`}>
        <div
          className="h-screen min-h-0 grid"
          style={{
            gridTemplateColumns: `var(--nav-w) 1fr`,
            gridTemplateRows: "auto 1fr",
          }}
        >
          <div className="row-start-1 row-end-3">
            <NavRail businessId={businessId} open={navOpen} onClose={() => setNavOpen(false)} />
          </div>

          {/* Header */}
          <header className="relative bg-app shrink-0 col-start-2 col-end-3 z-[30] pt-2">
            {/* Curtain behind the cluster to prevent transparency bleed */}
            <div
              aria-hidden
              className="absolute top-0 left-0 rounded-b-2xl"
              style={{
                // Stop before the insights rail; when the rail is closed this stays at 0
                right: 'calc(var(--content-rail-offset, 0px) + 8px)',
                height: '48px',
                backgroundColor: 'var(--bg)',
              }}
            />

            <div
              className="relative z-[5] w-full flex items-center gap-3 pl-3 pr-4 md:pl-6 pt-2 pb-3 rounded-b-2xl backdrop-blur-sm"
              style={{
                backgroundColor: 'rgba(18,16,15,0.78)',
                paddingRight: 'var(--header-pad-right, 0.75rem)',
                transition: 'padding-right 200ms ease',
                width: 'calc(100% - var(--content-rail-offset, 0px))',
              }}
            >
              <div className="flex items-center gap-3">
                <button
                  className="md:hidden inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/10 text-secondary hover:bg-white/5"
                  onClick={() => setNavOpen(true)}
                  aria-label="Open navigation"
                  style={{ position: 'relative', zIndex: 1000 }}
                >
                  <Menu size={18} />   {/* ✅ icon body restored */}
                </button>
              </div>

              {/* Right-aligned cluster pinned before the rail */}
              <div
                className="absolute inset-y-0 flex items-center flex-wrap gap-4 pr-3 justify-end"
                style={{
                  // When the rail is open, reserve the full rail width; when closed, this stays at 0.
                  right: '12px',
                  zIndex: 10,
                  gap: '12px',
                }}
              >
                {usageCount !== undefined && (
                  <div className="text-sm text-secondary whitespace-nowrap">
                    {usageCount} / 300 Bizzi credits used this month
                  </div>
                )}
                <button
                  title="Quick Calendar"
                  onClick={() => setCalendarOpen(true)}
                  className="p-2 rounded-md border border-white/10 text-secondary hover:bg-white/5"
                >
                  <Calendar size={18} />
                </button>

                {/* BusinessSwitcher:
                    - neutral on /chat
                    - chrome / module / email colors elsewhere
                    - hover → outer glow */}
                <div
                  className="bizzy-switcher-quiet rounded-lg transition-shadow"
                  style={{
                    '--accent': isChatHome ? neutralAccent : brandAccent,
                    boxShadow: switcherHover ? `0 0 14px ${accentSoft}` : 'none',
                  }}
                  onMouseEnter={() => setSwitcherHover(true)}
                  onMouseLeave={() => setSwitcherHover(false)}
                >
                  <BusinessSwitcher
                    currentBusiness={currentBusiness}
                    setCurrentBusiness={setCurrentBusiness}
                    className="w-full"
                    variant="neutral"
                  />
                </div>
              </div>
              {/* Floating Chat back button – fixed above dashboard content */}
              {!isChatHome && (
                <div
                  className="hidden md:block"
                  style={{
                    position: 'fixed',
                    top: 12,
                    right: `calc(${RIGHT_RAIL_W}px + ${GRID_GAP * 2}px + 24px)`,
                    zIndex: 9999
                  }}
                >
                </div>
              )}
            </div>
          </header>

          {calendarOpen && (
            <CalendarQuickOpen
              businessId={businessId}
              onClose={() => setCalendarOpen(false)}
              onCreated={() => window.dispatchEvent(new CustomEvent('bizzy:calendar:refresh'))}
            />
          )}

          <main
            className="flex-1 min-h-0 w-full overflow-hidden bg-app col-start-2 col-end-3"
            style={{
              isolation: 'isolate',
              padding: 0,
              paddingTop: '20px',
              paddingRight: 'var(--content-rail-offset, 0px)',
              position: 'relative',
            }}
          >
            {children}
          </main>
        </div>

        <ToastPortal />
      </div>
    </InsightsUnreadProvider>
  );
};

const MainLayout = (props) => (
  <BizzyChatProvider>
    <MainLayoutCore {...props} />
  </BizzyChatProvider>
);

export default MainLayout;
