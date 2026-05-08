// src/layout/MainLayout.jsx
import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../services/supabaseClient';
import { useNavigate, useLocation } from 'react-router-dom';
import BusinessWizard from '../pages/UserAdmin/BusinessWizard';
import useModuleTheme from '../hooks/useModuleTheme';
import { BizzyChatProvider, useBizzyChatContext } from '../context/BizzyChatContext';
import SubsectionTabs from '../components/Navigation/SubsectionTabs.jsx';
import ToastPortal from '../insights/ToastPortal';
import { InsightsUnreadProvider } from '../insights/InsightsUnreadContext';

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

  const textColor = theme?.textClass || 'text-primary';
  const isChatHome = location.pathname.startsWith('/dashboard/bizzy/chat') || location.pathname.startsWith('/chat');
  const { isCanvasOpen = false } = useBizzyChatContext?.() || {};

  const [currentBusiness, setCurrentBusiness] = useState(null);
  const [isProfileComplete, setIsProfileComplete] = useState(null);

  /* Decide switcher accent:
     - Chrome (silver) on: Pulse(bizzy), Jobs(leads-jobs), Calendar, Bizzi Docs, Meet Bizzi, Settings/Sync
     - Email uses light blue
     - All others keep module color
     - Chat home remains neutral
  */
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
      <div className="h-screen bg-[var(--bg)] bizzy-bg-textured font-sans p-6 text-primary">
        <BusinessWizard />
      </div>
    );
  }

  const businessId = currentBusiness?.id || localStorage.getItem('currentBusinessId');
  const subnavItems = React.useMemo(() => {
    const path = location.pathname || "";
    if (path.startsWith("/dashboard/accounting")) {
      return [
        { label: "Books", path: "/dashboard/accounting/bookkeeping" },
        { label: "Forecasts", path: "/dashboard/accounting/forecasts" },
        { label: "Health", path: "/dashboard/accounting" },
        { label: "Reports", path: "/dashboard/accounting/reports" },
        { label: "Reconciliations", path: "/dashboard/accounting/reconciliations" },
      ];
    }
    if (path.startsWith("/dashboard/jobs") || path.startsWith("/dashboard/leads-jobs")) {
      const base = path.startsWith("/dashboard/leads-jobs") ? "/dashboard/leads-jobs" : "/dashboard/jobs";
      return [
        { label: "Collections", path: `${base}/collections`, activePaths: [base] },
        { label: "Job Costing", path: `${base}/job-costing` },
      ];
    }
    if (path.startsWith("/dashboard/marketing")) {
      return [
        { label: "Overview", path: "/dashboard/marketing" },
        { label: "Post Gallery", path: "/dashboard/marketing/captions" },
      ];
    }
    if (path.startsWith("/dashboard/tax")) {
      return [
        { label: "Overview", path: "/dashboard/tax" },
        { label: "Deductions", path: "/dashboard/tax/deductions" },
      ];
    }
    return [];
  }, [location.pathname]);

  return (
    <InsightsUnreadProvider userId={user?.id} businessId={businessId}>
      <div className={`min-h-screen h-screen ${textColor} font-sans relative`} style={{ paddingLeft: "var(--nav-w, 0px)" }}>
        {/* Single global background layer */}
        <div
          aria-hidden
          className="bizzy-bg-textured"
          style={{ position: "fixed", inset: 0, zIndex: 0, backgroundColor: "var(--bg)", pointerEvents: "none" }}
        />

        <div style={{ position: "relative", zIndex: 1 }} className="flex flex-col min-h-screen">
          {/* Header */}
          <header className="relative shrink-0 z-[30] pt-2 bg-transparent" data-bizzy-header>
            <div
              className="relative z-[5] w-full flex items-center gap-3 pl-3 pr-4 md:pl-6 pt-2 pb-3 rounded-b-2xl"
              style={{
                paddingRight: 'var(--header-pad-right, 0.75rem)',
                transition: 'padding-right 200ms ease',
                width: 'calc(100% - var(--content-rail-offset, 0px))',
                backgroundColor: 'transparent',
              }}
            >
              <div className="flex items-center gap-3 w-full" style={{ position: "relative", zIndex: 1 }}>
                <div className="flex-1 flex justify-center">
                  {subnavItems.length > 0 && !isCanvasOpen ? <SubsectionTabs items={subnavItems} /> : null}
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
            </div>
          </header>

          <main
            className="flex-1 min-h-0 w-full overflow-hidden col-start-2 col-end-3 bg-transparent"
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
