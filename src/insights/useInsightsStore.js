// /src/insights/useInsightsStore.js
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { apiUrl, safeFetch } from '../utils/safeFetch';
import { supabase } from '../services/supabaseClient';
import { MOCK_INSIGHTS, countMockInsights } from './mockInsights';

const GLOBAL_INSIGHTS_MODULE = 'contractor_cfo';

/**
 * Bizzi Insights store
 * - Loads global contractor CFO insights for the active business
 * - Emits unread counts for the global rail badge
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

/* emit unread for the canonical global rail */
function emitUnread(moduleKey, businessId, count) {
  try {
    window.dispatchEvent(
      new CustomEvent('insights:unread', { detail: { moduleKey, businessId, count } })
    );
  } catch {
    // Event dispatch is best-effort.
  }
}

export function useInsightsStore({
  userId,
  businessId,
  accountId,
  refreshMs = 60_000,
  allowMockFallback = true,
}) {
  const insightModuleKey = GLOBAL_INSIGHTS_MODULE;
  const env = (typeof import.meta !== "undefined" && import.meta.env) || {};
  const isDemoMode = allowMockFallback && String(env?.VITE_DEMO_DATA || env?.VITE_USE_DEMO_INSIGHTS || "").toLowerCase() === "true";
  const [items, setItems]     = useState([]);
  const [unread, setUnread]   = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const sinceRef     = useRef('');
  const inflightRef  = useRef(false);
  const mountedRef   = useRef(false);

  const isDev = ((typeof import.meta !== "undefined" && import.meta.env?.MODE) || 'development') !== 'production';
  const readCacheEnabled = !isDev; // keep badges accurate in dev mocks

  const makeNow = useCallback((offsetMin = 0) => {
    const d = new Date(Date.now() - offsetMin * 60_000);
    return d.toISOString();
  }, []);

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

  const suppressBadge = SUPPRESS_BANNER_MODULES.has(String(insightModuleKey || '').toLowerCase());
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
  const mockCreatedAtRef = useRef(new Map());

  const loadReadCache = useCallback(() => {
    if (!readCacheEnabled) return;
    const key = `bizzy:read:${businessId || 'anon'}:${insightModuleKey}${accountId ? ':' + accountId : ''}`;
    readCacheKeyRef.current = key;
    try {
      const raw = sessionStorage.getItem(key);
      readIdsRef.current = new Set(raw ? JSON.parse(raw) : []);
    } catch {
      readIdsRef.current = new Set();
    }
  }, [readCacheEnabled, businessId, insightModuleKey, accountId]);

  const persistReadId = useCallback((id) => {
    if (!readCacheEnabled || !id) return;
    try {
      readIdsRef.current.add(id);
      sessionStorage.setItem(readCacheKeyRef.current, JSON.stringify([...readIdsRef.current]));
    } catch {
      // Session storage can fail in private browsing or restricted contexts.
    }
  }, [readCacheEnabled]);

  // ---------- helpers ----------
  const mockRowsForModule = useCallback(
    () =>
      MOCK_INSIGHTS
        .filter((i) => {
          const mod = String(i.module || '').toLowerCase();
          const matches = mod === insightModuleKey;
          const acctOk = !accountId || !i.account_id || i.account_id === accountId;
          const notDismissed = !dismissedDevRef.current.has(i.id);
          return matches && acctOk && notDismissed;
        })
        .map((item, idx) => ({
          ...item,
          created_at:
            item.created_at ||
            mockCreatedAtRef.current.get(item.id) ||
            (() => {
              const createdAt = makeNow(5 + idx * 4);
              mockCreatedAtRef.current.set(item.id, createdAt);
              return createdAt;
            })(),
        }))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    [accountId, makeNow, insightModuleKey]
  );

  // ---- FETCH (no auto-read on enter)
  const fetchInsights = useCallback(async ({ append = false } = {}) => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    setError(null);
    if (!append) setLoading(true);

    try {
      let rows = [];

      if ((isDev || isDemoMode) && allowMockFallback) {
        rows = mockRowsForModule();
      } else {
        const headers = await authHeaders();
        const url = new URL(apiUrl('/api/insights/list'));
        if (businessId) url.searchParams.set('businessId', businessId);
        if (userId)     url.searchParams.set('userId', userId);
        url.searchParams.set('module', insightModuleKey);
        if (accountId)  url.searchParams.set('accountId', accountId);
        url.searchParams.set('limit', '50');
        url.searchParams.set('voice', 'bizzi');
        const data = await safeFetch(url.toString(), { headers });
        rows = Array.isArray(data?.items) ? data.items : [];
        // server rows may already be read; DO NOT auto mark-read here.
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
      if (!suppressBadge) emitUnread(insightModuleKey, businessId, unreadCount);

      setItems(rows);
    } catch (e) {
      console.error('[insights] fetch failed:', e);
      const rows = allowMockFallback ? mockRowsForModule() : [];
      const unreadCount = rows.filter((r) => !r.is_read).length;
      setItems(rows);
      setUnreadSafe(unreadCount);
      // keep suppressBadge behavior even on error
      if (!suppressBadge) emitUnread(insightModuleKey, businessId, unreadCount);
    } finally {
      inflightRef.current = false;
      if (!append) setLoading(false);
    }
  }, [isDev, isDemoMode, userId, businessId, insightModuleKey, accountId, suppressBadge, allowMockFallback, mockRowsForModule, authHeaders, readCacheEnabled, setUnreadSafe]);

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
        if (!suppressBadge) emitUnread(insightModuleKey, businessId, cnt);
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
       	if (!suppressBadge) emitUnread(insightModuleKey, businessId, cnt);
        return next;
      });
      persistReadId(id);
    } catch (e) {
      console.error('[insights] markRead failed:', e);
    }
  }, [isDev, userId, businessId, insightModuleKey, suppressBadge, persistReadId]);

  // snooze (remove immediately + update count)
  const snooze = useCallback(async (id, untilIso) => {
    if (!id) return;

    if (isDev) {
      dismissedDevRef.current.add(id);
      setItems((prev) => {
        const next = prev.filter((x) => x.id !== id);
        const cnt  = next.filter((r) => !r.is_read).length;
        setUnreadSafe(cnt);
        if (!suppressBadge) emitUnread(insightModuleKey, businessId, cnt);
        return next;
      });
      return;
    }

    try {
      const headers = await authHeaders();
      await safeFetch(apiUrl('/api/insights/snooze'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ id, until: untilIso || 'now', userId, businessId }),
      });
      setItems((prev) => {
        const next = prev.filter((x) => x.id !== id);
        const cnt  = next.filter((r) => !r.is_read).length;
        setUnreadSafe(cnt);
        if (!suppressBadge) emitUnread(insightModuleKey, businessId, cnt);
        return next;
      });
    } catch (e) {
      console.error('[insights] snooze failed:', e);
    }
  }, [isDev, businessId, userId, insightModuleKey, suppressBadge, authHeaders, setUnreadSafe]);

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
  }, [userId, businessId, insightModuleKey, accountId, loadReadCache, refreshAll]);

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
