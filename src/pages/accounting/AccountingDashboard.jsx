// File: /src/pages/Accounting/AccountingDashboard.jsx
import React, { lazy, Suspense, useMemo, useEffect, useState } from 'react';
import { useBusiness } from '../../context/BusinessContext';
import useModuleTheme from '../../hooks/useModuleTheme';
import { useNavigate } from 'react-router-dom';
import AgendaWidget from '../Calendar/AgendaWidget.jsx';

import ModuleHeader from '../../components/layout/ModuleHeader/ModuleHeader';
import SyncButton from '../../components/Integrations/SyncButton.jsx';

import FinancialKPICards from '../../components/Accounting/FinancialKPICards';
import FinancialPulseCard from '../../components/Accounting/FinancialPulseCard';
import SuggestedMovesCard from '../../components/Accounting/SuggestedMovesCard';
import useIntegrationManager from '../../hooks/useIntegrationManager.js';
import { safeFetch } from '../../utils/safeFetch.js';
import { getHeroInsight } from '../../services/heroInsights/getHeroInsight.js';
import { RefreshCcw } from 'lucide-react';

const RevenueChart = lazy(() => import('../../components/Accounting/RevenueChart'));
const NetProfitChart = lazy(() => import('../../components/Accounting/NetProfitChart'));
const ExpenseBreakdownChart = lazy(() => import('../../components/Accounting/ExpenseBreakdownChart'));

// ✅ publish right-rail extras to the layout
import { useRightExtras } from '../../insights/RightExtrasContext';
import LiveModePlaceholder from '../../components/common/LiveModePlaceholder.jsx';
import { shouldForceLiveData, shouldUseDemoData } from '../../services/demo/demoClient.js';

/* ------------------ Visual constants ------------------ */
const ACCOUNTING_ACCENT = '#00FFB2';
function hexToRgba(hex, alpha = 1) {
  let c = (hex || '').replace('#', '');
  if (c.length === 3) c = c.split('').map(s => s + s).join('');
  const n = parseInt(c || '000000', 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Graphite / chrome neutrals (slightly darker than before)
const CHROME_BORDER        = 'rgba(165,167,169,0.14)';  // default test: dark chrome/silver
const CHROME_BORDER_HOVER  = 'rgba(165,167,169,0.20)';
const EMERALD_DARK_BORDER  = hexToRgba(ACCOUNTING_ACCENT, 0.18); // optional dark emerald frame

// Panel surface (same as before)
const PANEL_BG = 'var(--panel)';

/* ------------------ Skeleton ------------------ */
const CardSkeleton = ({ h = 'h-56' }) => (
  <div
    className={`rounded-2xl bg-panel border ${h} animate-pulse`}
    style={{ borderColor: CHROME_BORDER }}
  />
);

/* ------------------ Helpers ------------------ */
const RowGap = ({ children }) => <div className="flex flex-col gap-4">{children}</div>;

/** Card container with switchable frame variant */
function CardFrame({
  children,
  padded = true,
  className = '',
  style = {},
  variant = 'chrome', // 'chrome' | 'emerald-dark'
}) {
  const borderColor =
    variant === 'emerald-dark' ? EMERALD_DARK_BORDER : CHROME_BORDER;

  return (
    <div
      className={`rounded-2xl overflow-hidden shadow-bizzi transition-colors ${padded ? 'p-3' : ''} ${className}`}
      style={{
        border: `1px solid ${borderColor}`,
        background: PANEL_BG,
        backgroundClip: 'padding-box',
        ...style,
      }}
      // subtle hover lift without neon glow
      onMouseEnter={e => {
        e.currentTarget.style.borderColor =
          variant === 'emerald-dark' ? EMERALD_DARK_BORDER : CHROME_BORDER_HOVER;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = borderColor;
      }}
    >
      <div className="rounded-[inherit] overflow-visible">{children}</div>
    </div>
  );
}

/** ⛑️ Temporary client mock (remove when API returns hero) */
const TEMP_DEBUG_MOCK_HERO = {
  id: 'debug-fin-hero',
  title: 'Revenue up 15% vs last month',
  summary: '',
  metric: '$48,200',
  severity: 'good',
  dismissible: true,
};

export default function AccountingDashboard() {
  const { currentBusiness, loading } = useBusiness();
  const theme = useModuleTheme('accounting');
  const navigate = useNavigate();
  const { setRightExtras } = useRightExtras();

  const [hero, setHero] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('bizzy:lastFinancialRefresh') : null;
    return stored ? Number(stored) : null;
  });

  const bgColor   = theme?.bgClass   || 'bg-app';
  const textColor = theme?.textClass || 'text-primary';

  const userId = useMemo(() => localStorage.getItem('user_id') || '', []);
  const businessId = useMemo(
    () => currentBusiness?.id || localStorage.getItem('currentBusinessId') || '',
    [currentBusiness?.id]
  );
  const usingDemo = useMemo(() => shouldUseDemoData(currentBusiness), [currentBusiness]);
  const forceLive = shouldForceLiveData();
  const integrationManager = useIntegrationManager({ businessId });
  const qbStatus = integrationManager?.getStatus?.('quickbooks')?.status || 'disconnected';

  // 🧠 Publish AgendaWidget to the right rail
  useEffect(() => {
    if (!businessId) return;
    setRightExtras(
      <AgendaWidget
        businessId={businessId}
        module="financials"
        onOpenCalendar={() => navigate('/dashboard/calendar')}
      />
    );
    return () => setRightExtras(null);
  }, [businessId, navigate, setRightExtras]);

  // 🔎 Load hero insight (Financials)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await getHeroInsight('financials', { force: true, timeout: 6000 });
        if (!alive) return;
        const heroCandidate = res?.hero || null;
        // In live/testing, we hide hero entirely unless it is explicitly non-mock
        if (forceLive && !usingDemo) {
          setHero(null);
          return;
        }

        // Filter out demo/mock heroes
        const mode = (heroCandidate?.mode || heroCandidate?.dataMode || heroCandidate?.source || "").toString();
        const hasMockId = typeof heroCandidate?.id === "string" && /demo|mock/i.test(heroCandidate.id);
        const heroIsMock =
          heroCandidate?.mock === true ||
          /demo|mock/i.test(mode) ||
          hasMockId;

        setHero(heroIsMock ? null : heroCandidate);
      } catch (e) {
        if (!alive) return;
        console.warn('[AccountingDashboard] hero insight fetch failed:', e?.message || e);
        setHero(null);
      }
    })();
    return () => { alive = false; };
  }, [usingDemo, forceLive]);

  if (loading) return null;
  if (!currentBusiness) return <div className="text-rose-400 p-4">No business selected.</div>;
  const canView = usingDemo || qbStatus === 'connected';
  const showHeroPlaceholder = !hero && canView;
  if (!canView) {
    return <LiveModePlaceholder title="Connect QuickBooks to view Financial Hub insights" />;
  }

  const handleRefresh = async () => {
    if (!businessId) return;
    setRefreshing(true);
    try {
      const qs = `business_id=${encodeURIComponent(businessId)}&data_mode=live&live_only=true`;
      await Promise.all([
        safeFetch(`/api/accounting/revenue-series?${qs}`),
        safeFetch(`/api/accounting/profit-series?${qs}`),
        safeFetch(`/api/accounting/metrics?${qs}`),
      ]);
      const now = Date.now();
      setLastRefreshed(now);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('bizzy:lastFinancialRefresh', String(now));
      }
    } catch (e) {
      console.warn("[AccountingDashboard] refresh failed", e?.message || e);
    } finally {
      setRefreshing(false);
    }
  };

  // Heights tuned so charts are fully visible
  const H_REVENUE = 300;
  const H_EXPENSE = 200;
  const H_PROFIT  = 280;

  return (
    /**
     * ⚠️ Keep this root NON-scrolling. No h-screen/min-h-full/overflow here.
     */
    <div className={`w-full px-3 md:px-4 pt-0 pb-2 ${bgColor} ${textColor}`}>
      {/* Header (title + optional hero) */}
      <ModuleHeader
        module="financials"
        title="Financial Hub"
        hero={hero}
        onDismissHero={() => setHero(null)}
        className="mb-4"
        right={
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm text-white/90 transition disabled:opacity-60"
              style={{ borderColor: "rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.35)" }}
            >
              <RefreshCcw className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              {refreshing ? "Refreshing…" : "Refresh live data"}
            </button>
            {lastRefreshed ? (
              <span className="text-xs text-white/60">
                Updated {new Date(lastRefreshed).toLocaleString()}
              </span>
            ) : (
              <span className="text-xs text-white/50">No refresh yet</span>
            )}
            <SyncButton label="Sync QuickBooks" providers={["quickbooks"]} />
          </div>
        }
      />

      {/* Main content */}
      <RowGap>
        {/* KPI cards row */}
        <CardFrame padded={false} variant="emerald-dark">
          <div className="rounded-[inherit] p-3">
            <FinancialKPICards />
          </div>
        </CardFrame>

        {/* Charts — Revenue full-width row */}
        <CardFrame variant="emerald-dark">
          <Suspense fallback={<CardSkeleton h={`h-[${H_REVENUE}px]`} />}>
            <div className="rounded-[inherit] overflow-hidden" style={{ height: H_REVENUE }}>
              <RevenueChart height={H_REVENUE} />
            </div>
          </Suspense>
        </CardFrame>

        {/* Expense + Profit side-by-side */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <CardFrame variant="emerald-dark">
            <Suspense fallback={<CardSkeleton h={`h-[${H_EXPENSE}px]`} />}>
              <div className="rounded-[inherit]" style={{ height: H_EXPENSE }}>
                <ExpenseBreakdownChart height={H_EXPENSE} className="rounded-xl" />
              </div>
            </Suspense>
          </CardFrame>

          <CardFrame variant="emerald-dark">
            <Suspense fallback={<CardSkeleton h={`h-[${H_PROFIT}px]`} />}>
              <div className="rounded-[inherit]" style={{ height: H_PROFIT }}>
                <NetProfitChart height={H_PROFIT} compact className="rounded-xl" />
              </div>
            </Suspense>
          </CardFrame>
        </div>

        {/* Insights below the charts */}
        <CardFrame padded={false} variant="emerald-dark">
          <div className="rounded-[inherit] overflow-hidden">
            <FinancialPulseCard userId={userId} businessId={businessId} />
          </div>
        </CardFrame>

        <CardFrame padded={false} variant="emerald-dark">
          <div className="rounded-[inherit] overflow-hidden">
            <SuggestedMovesCard userId={userId} businessId={businessId} />
          </div>
        </CardFrame>
      </RowGap>
    </div>
  );
}
