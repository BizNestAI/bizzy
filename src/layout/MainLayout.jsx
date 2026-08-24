// src/layout/MainLayout.jsx
import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../services/supabaseClient';
import { useNavigate, useLocation } from 'react-router-dom';
import BusinessWizard from '../pages/UserAdmin/BusinessWizard';
import useModuleTheme from '../hooks/useModuleTheme';
import { BizzyChatProvider, useBizzyChatContext } from '../context/BizzyChatContext';
import SubsectionTabs from '../components/Navigation/SubsectionTabs.jsx';
import FinancialMonthlyReviewStamp from '../components/Accounting/FinancialMonthlyReviewStamp.jsx';
import ToastPortal from '../insights/ToastPortal';
import { InsightsUnreadProvider } from '../insights/InsightsUnreadContext';
import { useAdminView } from '../context/AdminViewContext.jsx';
import AdminViewReadOnlyGuard from '../components/AdminView/AdminViewReadOnlyGuard.jsx';

const RIGHT_RAIL_W = 320;  // keep in sync with DashboardLayout / InsightsRail width
const GRID_GAP     = 6;    // the grid gap between center & right rail columns

/* Which module routes should use Chrome/Silver? */
const CHROME_MODULES = new Set(['bizzy','leads-jobs','calendar','activity','docs','companion','settings']);

function AdminViewBanner() {
  const adminView = useAdminView();
  const navigate = useNavigate();
  if (!adminView.active) return null;

  const returnToMonthlyReview = () => {
    const target = adminView.returnUrl || "https://admin.bizzios.com/monthly-review";
    window.location.assign(target);
  };

  const exitAdminView = async () => {
    await adminView.endAdminView?.();
    navigate("/login", { replace: true });
  };

  return (
    <div className="fixed inset-x-0 top-0 z-[50000] border-b border-emerald-200/20 bg-[#07110d]/96 px-4 py-2 text-white shadow-[0_10px_28px_rgba(0,0,0,0.42)] backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-200">
            Admin View · Read Only
          </div>
          <div className="truncate text-sm font-semibold text-white/88">
            Viewing: {adminView.businessName || "Selected business"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={returnToMonthlyReview}
            className="rounded-full border border-emerald-200/22 bg-emerald-300/10 px-3 py-1.5 text-xs font-semibold text-emerald-50 hover:bg-emerald-300/16"
          >
            Return to Monthly Review
          </button>
          <button
            type="button"
            onClick={exitAdminView}
            className="rounded-full border border-white/12 bg-white/[0.05] px-3 py-1.5 text-xs font-semibold text-white/70 hover:bg-white/[0.09]"
          >
            Exit Admin View
          </button>
        </div>
      </div>
    </div>
  );
}

const MainLayoutCore = ({ children }) => {
  const { user } = useAuth();
  const adminView = useAdminView();
  const navigate = useNavigate();
  const location = useLocation();

  const seg = location.pathname.split('/')[2] || 'bizzy';
  const rawModuleKey = (seg === 'financials' ? 'accounting' : seg).toLowerCase();
  const moduleKey = rawModuleKey === 'bizzi'
    ? 'bizzy'
    : rawModuleKey === 'bizzi-docs'
      ? 'docs'
      : rawModuleKey;
  const theme = useModuleTheme(moduleKey);

  const textColor = theme?.textClass || 'text-primary';
  const isChatHome = location.pathname.startsWith('/dashboard/bizzi/chat') || location.pathname.startsWith('/chat');
  const { isCanvasOpen = false } = useBizzyChatContext?.() || {};

  const [currentBusiness, setCurrentBusiness] = useState(null);
  const [isProfileComplete, setIsProfileComplete] = useState(null);

  const clearStoredBusiness = () => {
    if (adminView.active) return;
    localStorage.removeItem('currentBusinessId');
    localStorage.removeItem('business_id');
    localStorage.removeItem('isProfileComplete');
  };

  const acceptBusiness = (business) => {
    setCurrentBusiness(business);
    setIsProfileComplete(true);
    if (adminView.active) return;
    localStorage.setItem('isProfileComplete', 'true');
    localStorage.setItem('currentBusinessId', business.id);
    localStorage.setItem('business_id', business.id);
  };

  /* Decide switcher accent:
     - Chrome (silver) on: Pulse(bizzy), Jobs(leads-jobs), Calendar, Bizzi Docs, Meet Bizzi, Settings/Sync
     - Email uses light blue
     - All others keep module color
     - Chat home remains neutral
  */
  useEffect(() => {
    const fetchCurrentBusiness = async () => {
      if (adminView.loading) return;
      if (adminView.active) {
        setCurrentBusiness({
          id: adminView.businessId,
          business_name: adminView.businessName || 'Selected business',
          admin_view: true,
          read_only: true,
        });
        setIsProfileComplete(true);
        return;
      }
      if (!user?.id) return;
      try {
        const url = new URL(window.location.href);
        const requestedBusinessId =
          url.searchParams.get('business_id') ||
          localStorage.getItem('currentBusinessId') ||
          localStorage.getItem('business_id');
        if (requestedBusinessId) {
          const { data: requestedBiz } = await supabase
            .from('business_profiles')
            .select('*')
            .eq('id', requestedBusinessId)
            .eq('user_id', user.id)
            .maybeSingle();
          if (requestedBiz) {
            acceptBusiness(requestedBiz);
            return;
          }
        }

        const { data: ownedBusiness, error: ownedBusinessError } = await supabase
          .from('business_profiles')
          .select('*')
          .eq('user_id', user.id)
          .order('business_name', { ascending: true })
          .limit(1)
          .maybeSingle();

        if (!ownedBusinessError && ownedBusiness) {
          acceptBusiness(ownedBusiness);
          return;
        }

        const { data: link } = await supabase
          .from('user_business_link').select('business_id')
          .eq('user_id', user.id).eq('role','owner').limit(1).maybeSingle();

        if (!link) {
          setCurrentBusiness(null);
          setIsProfileComplete(false);
          clearStoredBusiness();
          return;
        }

        const { data: biz } = await supabase.from('business_profiles')
          .select('*').eq('id', link.business_id).eq('user_id', user.id).maybeSingle();

        if (!biz) {
          setCurrentBusiness(null);
          setIsProfileComplete(false);
          clearStoredBusiness();
          return;
        }

        acceptBusiness(biz);
      } catch (err) {
        console.error('Error fetching business:', err);
        setCurrentBusiness(null);
        setIsProfileComplete(false);
        clearStoredBusiness();
      }
    };
    fetchCurrentBusiness();
  }, [user, location.search, adminView.loading, adminView.active, adminView.businessId, adminView.businessName]);

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

  const businessId = adminView.active ? adminView.businessId : (currentBusiness?.id || localStorage.getItem('currentBusinessId'));
  const subnavItems = React.useMemo(() => {
    const path = location.pathname || "";
    if (path.startsWith("/dashboard/accounting")) {
      return [
        { label: "Books", path: "/dashboard/accounting/bookkeeping", activePaths: ["/dashboard/accounting/rules"] },
        { label: "Forecasts", path: "/dashboard/accounting/forecasts" },
        { label: "Health", path: "/dashboard/accounting" },
        { label: "Reports", path: "/dashboard/accounting/reports" },
        { label: "Reconciliations", path: "/dashboard/accounting/reconciliations" },
      ];
    }
    if (path.startsWith("/dashboard/jobs") || path.startsWith("/dashboard/leads-jobs")) {
      const base = path.startsWith("/dashboard/leads-jobs") ? "/dashboard/leads-jobs" : "/dashboard/jobs";
      return [
        { label: "Job Costing", path: `${base}/job-costing`, activePaths: [base] },
        { label: "Collections", path: `${base}/collections` },
        { label: "Bid Builder", path: `${base}/bid-builder`, tooltip: "Bid Builder: Coming Soon!", disableNavigate: true },
        { label: "Change Orders", path: `${base}/change-orders`, tooltip: "Change Orders: Coming Soon!", disableNavigate: true },
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
        { label: "Tax Overview", path: "/dashboard/tax" },
      ];
    }
    return [];
  }, [location.pathname]);

  if (isProfileComplete === false) {
    return (
      <div className="h-screen bg-[var(--bg)] bizzy-bg-textured font-sans p-6 text-primary">
        <BusinessWizard />
      </div>
    );
  }

  if (isProfileComplete === null) {
    return (
      <div
        className="min-h-screen bg-[var(--bg)] bizzy-bg-textured"
        aria-label="Loading Bizzi workspace"
      />
    );
  }

  return (
    <InsightsUnreadProvider userId={user?.id} businessId={businessId}>
        <div className={`bizzy-app-shell min-h-screen h-screen ${textColor} font-sans relative`} style={{ paddingLeft: "var(--nav-w, 0px)", paddingTop: adminView.active ? 44 : 0 }}>
        {/* Single global background layer */}
        <div
          aria-hidden
          className="bizzy-bg-textured"
          style={{ position: "fixed", inset: 0, zIndex: 0, backgroundColor: "var(--bg)", pointerEvents: "none" }}
        />

        <AdminViewBanner />
        <AdminViewReadOnlyGuard />
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
                <div className="flex-1 flex items-center justify-center">
                  {subnavItems.length > 0 && !isCanvasOpen ? (
                    <div className="relative inline-flex items-center justify-center">
                      <SubsectionTabs items={subnavItems} />
                      {moduleKey === 'accounting' ? (
                        <FinancialMonthlyReviewStamp
                          businessId={businessId}
                          className="absolute left-full top-1/2 ml-3 -translate-y-1/2"
                        />
                      ) : null}
                    </div>
                  ) : null}
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
