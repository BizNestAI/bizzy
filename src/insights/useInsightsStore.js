// /src/insights/useInsightsStore.js
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { apiUrl, safeFetch } from '../utils/safeFetch';
import { supabase } from '../services/supabaseClient';
import { MOCK_INSIGHTS, countMockInsights } from './mockInsights';

/**
 * Bizzi Insights store
 * - Loads insights for the active module
 * - Emits unread counts (canonical + alias) so Sidebar can badge tabs
 * - ❌ Does NOT auto-mark READ on enter
 * - ✅ In DEV/mock, READ is persisted for this session so returning to a module
 *   does not re-raise the badge (until full page reload).
 */

// modules where we never want a badge
const SUPPRESS_BANNER_MODULES = new Set([
  'docs', 'bizzy-docs', 'documents',
  'meet-bizzi', 'companion',
  'settings', 'settings/sync', 'settings-sync', 'sync',
]);

/* aliasing used by Sidebar */
function aliasOf(moduleKey) {
  if (moduleKey === 'email') return 'inbox';
  if (moduleKey === 'calendar') return 'sch';
  if (moduleKey === 'ops') return 'jobs';
  return null;
}

/* emit unread for canonical and alias */
function emitUnread(moduleKey, businessId, count) {
  try {
    window.dispatchEvent(
      new CustomEvent('insights:unread', { detail: { moduleKey, businessId, count } })
    );
    const alias = aliasOf(moduleKey);
    if (alias) {
      window.dispatchEvent(
        new CustomEvent('insights:unread', { detail: { moduleKey: alias, businessId, count } })
      );
    }
  } catch {}
}

export function useInsightsStore({
  userId,
  businessId,
  moduleKey,
  accountId,
  refreshMs = 60_000,
  allowMockFallback = true,
}) {
  const env = (typeof import.meta !== "undefined" && import.meta.env) || {};
  const isDemoMode = allowMockFallback && String(env?.VITE_DEMO_DATA || env?.VITE_USE_DEMO_INSIGHTS || "").toLowerCase() === "true";
  const [items, setItems]     = useState([]);
  const [unread, setUnread]   = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const sinceRef     = useRef('');
  const inflightRef  = useRef(false);
  const mountedRef   = useRef(false);

  const isDev = (import.meta?.env?.MODE || process.env.NODE_ENV) !== 'production';
  const readCacheEnabled = !isDev; // keep badges accurate in dev mocks

  const makeNow = useCallback((offsetMin = 0) => {
    const d = new Date(Date.now() - offsetMin * 60_000);
    return d.toISOString();
  }, []);

  // ---------- DEV mock insights ----------
  const MOCK = [
    // Pulse / Bizzi module
    { id: 'mock-pulse-1', module: 'bizzy', severity: 'warn', title: 'Bizzi Pulse 44/100 (At risk)',
      body: 'Cash is tight and payroll is heavy. Collect AR and trim labor 5–10% to stabilize margins.',
      created_at: makeNow(3), is_read: false, is_seen: false,
      primary_cta: { action: 'open_route', label: 'Open Pulse', route: '/dashboard/bizzy' } },
    { id: 'mock-pulse-2', module: 'bizzy', severity: 'info', title: 'Profit margin steady at 32.5%',
      body: 'Solid margin, but payroll is the main lever. A 5% reduction pushes you toward 35%.',
      created_at: makeNow(8), is_read: false, is_seen: false,
      primary_cta: { action: 'open_route', label: 'See Financials', route: '/dashboard/financials' } },
    { id: 'mock-pulse-3', module: 'bizzy', severity: 'warn', title: 'Cash on hand: $24.2K',
      body: 'Collecting 50% of AR keeps you above a two-month runway.',
      created_at: makeNow(10), is_read: false, is_seen: false },
    

    // Financials / Accounting
    { id: 'mock-fin-1', module: 'accounting', severity: 'info', title: 'Revenue $48.2K vs. Expenses $32.5K',
      body: 'Margin is 32.5%. Payroll is still the biggest lever for savings.',
      created_at: makeNow(5), is_read: false, is_seen: false,
      primary_cta: { action: 'open_route', label: 'Open Financials', route: '/dashboard/financials' } },
    { id: 'mock-fin-2', module: 'accounting', severity: 'warn', title: 'Labor costs are 39% of spend',
      body: 'A 5% trim adds roughly $1,600 profit.',
      created_at: makeNow(15), is_read: false, is_seen: false },
    { id: 'mock-fin-3', module: 'accounting', severity: 'warn', title: 'AR outstanding: $18.6K',
      body: 'Collect half to add $9.3K cash this month.',
      created_at: makeNow(20), is_read: false, is_seen: false },

    // Marketing
    { id: 'mock-mkt-1', module: 'marketing', severity: 'info', title: '62 new leads this month',
      body: '70% from Google Ads with the highest close rate.',
      created_at: makeNow(6), is_read: false, is_seen: false,
      primary_cta: { action: 'open_route', label: 'Open Marketing', route: '/dashboard/marketing' } },
    { id: 'mock-mkt-2', module: 'marketing', severity: 'info', title: 'Boost Google Ads budget',
      body: 'A 10% increase could add 8–10 qualified leads.',
      created_at: makeNow(12), is_read: false, is_seen: false },
    { id: 'mock-mkt-3', module: 'marketing', severity: 'warn', title: 'Follow-ups lagging',
      body: '20% of leads are untouched — roughly $12K potential revenue.',
      created_at: makeNow(18), is_read: false, is_seen: false },

    // Tax
    { id: 'mock-tax-1', module: 'tax', severity: 'warn', title: 'Tax payment due in 3 days',
      body: 'Estimated $6,200 for Q3 — pay early to avoid penalties.',
      created_at: makeNow(9), is_read: false, is_seen: false,
      primary_cta: { action: 'open_route', label: 'Open Tax', route: '/dashboard/tax' } },
    { id: 'mock-tax-2', module: 'tax', severity: 'info', title: 'Tax readiness: 83%',
      body: 'Missing two receipts (~$600). Upload to keep records clean.',
      created_at: makeNow(14), is_read: false, is_seen: false },

    // Investments
    { id: 'mock-inv-1', module: 'investments', severity: 'info', title: 'Portfolio up 5.4%',
      body: 'Tech ETFs are driving gains.',
      created_at: makeNow(11), is_read: false, is_seen: false,
      primary_cta: { action: 'open_route', label: 'Open Investments', route: '/dashboard/investments' } },
    { id: 'mock-inv-2', module: 'investments', severity: 'warn', title: 'Equity drift at 68% (target 60%)',
      body: 'Rebalance to lock in ~$2.2K gains.',
      created_at: makeNow(16), is_read: false, is_seen: false },

    // Calendar
    { id: 'mock-cal-1', module: 'calendar', severity: 'info', title: 'No meetings scheduled',
      body: 'Add payroll + AR follow-ups by Wednesday to stay on track.',
      created_at: makeNow(4), is_read: false, is_seen: false },
    { id: 'mock-cal-2', module: 'calendar', severity: 'warn', title: 'Tile delivery & walkthrough due Thursday',
      body: 'Confirm crew assignments by Tuesday morning.',
      created_at: makeNow(8), is_read: false, is_seen: false },
    { id: 'mock-cal-3', module: 'calendar', severity: 'info', title: 'Add Weekly Bizzi Review',
      body: 'Fridays at 8 a.m.—recap finances and pipeline.',
      created_at: makeNow(12), is_read: false, is_seen: false },

    // Email
    { id: 'mock-email-1', module: 'email', severity: 'warn', title: '2 urgent emails pending',
      body: 'Both from John Smith confirming project start.',
      created_at: makeNow(3), is_read: false, is_seen: false,
      primary_cta: { action: 'open_route', label: 'Open Inbox', route: '/dashboard/email' }, account_id: 'mock-email-acct' },
    { id: 'mock-email-2', module: 'email', severity: 'info', title: 'Avg reply time: 19 hours',
      body: 'Target under six hours to keep close rates up.',
      created_at: makeNow(9), is_read: false, is_seen: false },

    // Jobs / Ops
    { id: 'mock-ops-1', module: 'jobs', severity: 'info', title: '3 active jobs ($92K total)',
      body: 'All on track with no delays reported.',
      created_at: makeNow(5), is_read: false, is_seen: false,
      primary_cta: { action: 'open_route', label: 'Open Jobs', route: '/dashboard/leads-jobs' } },
    { id: 'mock-ops-2', module: 'jobs', severity: 'warn', title: 'Labor utilization 86%',
      body: 'Healthy now, but overtime risk if another job starts.',
      created_at: makeNow(11), is_read: false, is_seen: false },
    { id: 'mock-ops-3', module: 'jobs', severity: 'warn', title: 'Tile delivery Wednesday',
      body: 'Any delay could push November revenue into December.',
      created_at: makeNow(17), is_read: false, is_seen: false },
  ];

  const authHeaders = useCallback(async () => {
    const { data: { session } } = supabase.getClient
      ? await supabase.getClient().auth.getSession()
      : await supabase.auth.getSession();
    const token = session?.access_token || '';
    return {
      'x-user-id': userId || '',
      'x-business-id': businessId || '',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }, [userId, businessId]);

  const suppressBadge = SUPPRESS_BANNER_MODULES.has(String(moduleKey || '').toLowerCase());
  const setUnreadSafe = useCallback((n) => {
    setUnread(suppressBadge ? 0 : n);
  }, [suppressBadge]);

  const MOCK_COUNTS = useMemo(() => {
    if (!isDev || !allowMockFallback) return null;
    return countMockInsights({ suppress: SUPPRESS_BANNER_MODULES });
  }, [isDev, allowMockFallback]);

  useEffect(() => {
    if (!isDev || !MOCK_COUNTS || !allowMockFallback) return;
    Object.entries(MOCK_COUNTS).forEach(([mod, count]) => emitUnread(mod, businessId, count));
  }, [isDev, MOCK_COUNTS, businessId, allowMockFallback]);

  // ---- DEV: session read-cache (so mock items remain read when returning to a module)
  const readIdsRef = useRef(new Set());
  const readCacheKeyRef = useRef('');

  const dismissedDevRef = useRef(new Set()); // your existing in-memory session snooze cache

  const loadReadCache = useCallback(() => {
    if (!readCacheEnabled) return;
    const key = `bizzy:read:${businessId || 'anon'}:${moduleKey}${accountId ? ':' + accountId : ''}`;
    readCacheKeyRef.current = key;
    try {
      const raw = sessionStorage.getItem(key);
      readIdsRef.current = new Set(raw ? JSON.parse(raw) : []);
    } catch {
      readIdsRef.current = new Set();
    }
  }, [readCacheEnabled, businessId, moduleKey, accountId]);

  const persistReadId = useCallback((id) => {
    if (!readCacheEnabled || !id) return;
    try {
      readIdsRef.current.add(id);
      sessionStorage.setItem(readCacheKeyRef.current, JSON.stringify([...readIdsRef.current]));
    } catch {}
  }, [readCacheEnabled]);

  // ---------- helpers ----------
  const mockRowsForModule = useCallback(
    () =>
      MOCK_INSIGHTS
        .filter((i) => {
          const mod = i.module;
          const isJobsLike =
            moduleKey === 'jobs' || moduleKey === 'ops' || moduleKey === 'leads' || moduleKey === 'lead-jobs';
          const matches =
            mod === moduleKey ||
            (isJobsLike && (mod === 'jobs' || mod === 'ops' || mod === 'leads' || mod === 'lead-jobs'));
          const acctOk = !accountId || !i.account_id || i.account_id === accountId;
          const notDismissed = !dismissedDevRef.current.has(i.id);
          return matches && acctOk && notDismissed;
        })
        .map((item, idx) => ({
          ...item,
          created_at: item.created_at || makeNow(5 + idx * 4),
        }))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    [accountId, makeNow, moduleKey]
  );

  // ---- FETCH (no auto-read on enter)
  const fetchInsights = useCallback(async ({ append = false } = {}) => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    setError(null);
    if (!append) setLoading(true);

    try {
      let rows = [];

      if (moduleKey === 'jobs' && allowMockFallback) {
        rows = mockRowsForModule();
      } else if ((isDev || isDemoMode) && allowMockFallback) {
        rows = mockRowsForModule();
      } else {
        const headers = await authHeaders();
        const url = new URL(apiUrl('/api/insights/list'));
        if (businessId) url.searchParams.set('businessId', businessId);
        if (userId)     url.searchParams.set('userId', userId);
        if (moduleKey && moduleKey !== 'all') url.searchParams.set('module', moduleKey);
        if (accountId)  url.searchParams.set('accountId', accountId);
        url.searchParams.set('limit', '50');
        url.searchParams.set('voice', 'bizzi');
        const data = await safeFetch(url.toString(), { headers });
        rows = Array.isArray(data?.items) ? data.items : [];
        // server rows may already be read; DO NOT auto mark-read here

        // Inject bookkeeping cleanup card when relevant
        if (moduleKey === 'accounting' && businessId) {
          try {
            const health = await safeFetch(apiUrl('/api/accounting/bookkeeping-health'), { headers });
            const count = health?.health?.uncategorized_count || 0;
            if (count > 0) {
              const id = `bookkeeping-health-${businessId}`;
              const exists = rows.some((r) => r.id === id);
              if (!exists) {
                rows.unshift({
                  id,
                  module: 'accounting',
                  severity: 'warn',
                  title: `You have ${count} uncategorized transactions`,
                  body: 'Open Bookkeeping Cleanup to review Bizzi’s suggested categories and keep your reports accurate.',
                  created_at: makeNow(1),
                  is_read: false,
                  is_seen: false,
                  primary_cta: { action: 'open_route', label: 'Open cleanup', route: '/dashboard/accounting/bookkeeping' },
                });
              }
            }
          } catch (e) {
            console.warn('[insights] bookkeeping health fetch failed', e);
          }
        }
      }

      if (readCacheEnabled && readIdsRef.current.size) {
        rows = rows.map((r) =>
          readIdsRef.current.has(r.id) ? { ...r, is_read: true, is_seen: true } : r
        );
      }

      // If nothing came back, fall back to mock so the rail isn't empty.
      if (rows.length === 0 && allowMockFallback) {
        rows = mockRowsForModule();
      }

      // Compute unread AFTER applying session cache
      const unreadCount = rows.filter((r) => !r.is_read).length;
      setUnreadSafe(unreadCount);
      if (!suppressBadge) emitUnread(moduleKey, businessId, unreadCount);

      setItems(rows);
    } catch (e) {
      console.error('[insights] fetch failed:', e);
      const rows = allowMockFallback ? mockRowsForModule() : [];
      const unreadCount = rows.filter((r) => !r.is_read).length;
      setItems(rows);
      setUnreadSafe(unreadCount);
      // keep suppressBadge behavior even on error
      if (!suppressBadge) emitUnread(moduleKey, businessId, unreadCount);
    } finally {
      inflightRef.current = false;
      if (!append) setLoading(false);
    }
  }, [isDev, isDemoMode, userId, businessId, moduleKey, accountId, suppressBadge, allowMockFallback, mockRowsForModule, authHeaders, makeNow, readCacheEnabled, setUnreadSafe, emitUnread]);

  const refreshAll = useCallback(() => fetchInsights({ append: false }), [fetchInsights]);

  // mark SEEN (no count change here)
  const markSeen = useCallback(async (ids = []) => {
    if (!ids.length) return;
    if (isDev) {
      setItems((prev) => prev.map((x) => (ids.includes(x.id) ? { ...x, is_seen: true } : x)));
      return;
    }
    try {
      const headers = await authHeaders();
      await safeFetch(apiUrl('/api/insights/seen'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids, userId }),
      });
      setItems((prev) => prev.map((x) => (ids.includes(x.id) ? { ...x, is_seen: true } : x)));
    } catch (e) {
      console.error('[insights] markSeen failed:', e);
    }
  }, [isDev, userId]);

  // mark READ (usually called on LEAVE by InsightsRail)
  const markRead = useCallback(async (id) => {
    if (!id) return;

    if (isDev) {
      setItems((prev) => {
        const next = prev.map((x) => (x.id === id ? { ...x, is_read: true } : x));
        const cnt  = next.filter((r) => !r.is_read).length;
        setUnreadSafe(cnt);
        if (!suppressBadge) emitUnread(moduleKey, businessId, cnt);
        return next;
      });
      persistReadId(id);
      return;
    }

    try {
      const headers = await authHeaders();
      await safeFetch(apiUrl('/api/insights/mark-read'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ id, userId }),
      });
      setItems((prev) => {
        const next = prev.map((x) => (x.id === id ? { ...x, is_read: true } : x));
        const cnt  = next.filter((r) => !r.is_read).length;
        setUnreadSafe(cnt);
       	if (!suppressBadge) emitUnread(moduleKey, businessId, cnt);
        return next;
      });
      persistReadId(id);
    } catch (e) {
      console.error('[insights] markRead failed:', e);
    }
  }, [isDev, userId, businessId, moduleKey, suppressBadge, persistReadId]);

  // snooze (remove immediately + update count)
  const snooze = useCallback(async (id, untilIso) => {
    if (!id) return;

    if (isDev) {
      dismissedDevRef.current.add(id);
      setItems((prev) => {
        const next = prev.filter((x) => x.id !== id);
        const cnt  = next.filter((r) => !r.is_read).length;
        setUnreadSafe(cnt);
        if (!suppressBadge) emitUnread(moduleKey, businessId, cnt);
        return next;
      });
      return;
    }

    try {
      const headers = await authHeaders();
      await safeFetch(apiUrl('/api/insights/snooze'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ id, until: untilIso || 'now', userId }),
      });
      setItems((prev) => {
        const next = prev.filter((x) => x.id !== id);
        const cnt  = next.filter((r) => !r.is_read).length;
        setUnreadSafe(cnt);
        if (!suppressBadge) emitUnread(moduleKey, businessId, cnt);
        return next;
      });
    } catch (e) {
      console.error('[insights] snooze failed:', e);
    }
  }, [isDev, businessId, moduleKey, suppressBadge]);

  // Initial load / on module change — NO auto-read on enter.
  useEffect(() => {
    mountedRef.current = true;
    sinceRef.current = '';
    setItems([]);

    loadReadCache(); // apply session read-cache before first fetch in this module
    if (isDev) {
      // we intentionally do NOT reset readIds cache here
    }
    refreshAll();

    return () => { mountedRef.current = false; };
  }, [userId, businessId, moduleKey, accountId, loadReadCache, refreshAll]);

  // Background refresh when visible
  useEffect(() => {
    if (!refreshMs) return;
    const id = setInterval(() => {
      if (!mountedRef.current || document.visibilityState !== 'visible') return;
      fetchInsights({ append: true });
    }, refreshMs);
    return () => clearInterval(id);
  }, [fetchInsights, refreshMs]);

  // Pull new when window regains focus/online
  useEffect(() => {
    const onFocus = () => fetchInsights({ append: true });
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [fetchInsights]);

  useEffect(() => {
    const onOnline = () => fetchInsights({ append: true });
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [fetchInsights]);

  return {
    items,
    unread,
    loading,
    error,
    fetchInsights: refreshAll,
    fetchNew: () => fetchInsights({ append: true }),
    markRead,
    snooze,
    setItems,
    markSeen,
  };
}
